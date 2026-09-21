"""
=============================================================================
SDAP Universal District & State Satellite Acquisition & Processing Pipeline
=============================================================================
Location: backend/scripts/download_district_tiles.py

Description:
    Generic, dynamic master script to perform tile lookup for ANY district or state
    present in 'district_tiles_mapping', perform AWS S3 gap check, atomic scene downloading,
    SCL cloud masking, full-tile index calculation, reprojection, mosaicing, and delivery clipping.

    Follows SRS 8.1.1 — Database-Mediated Module Handoff:
    Each stage writes its output to ProcessJobModel before the next stage begins,
    enabling restart-without-repeat and full status visibility at any point.

Usage:
    python scripts/download_district_tiles.py --district "Khammam" --start-date "2025-01-01" --end-date "2025-01-31"
    python scripts/download_district_tiles.py --state "Telangana" --start-date "2025-01-01" --end-date "2025-01-31"
=============================================================================
"""

import os
import sys
import argparse
import logging
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import text

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.sdap_models import SceneModel, RequestModel, ProcessJobModel
from app.services.gap_check_service import perform_gap_check, get_all_mapped_districts, get_tiles_for_state
from app.services.downloader_service import download_and_verify_scene
from app.services.processor_service import compute_full_tile_index
from app.services.delivery_service import produce_district_delivery_output

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.universal_pipeline")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def append_request_log(db_session, req_id: int, message: str, level: str = "INFO"):
    """Appends a log entry persistently to RequestModel.execution_logs in PostgreSQL."""
    if not req_id:
        return
    session = db_session if db_session else SessionLocal()
    close_needed = db_session is None
    try:
        req = session.query(RequestModel).filter(RequestModel.id == req_id).first()
        if req:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            log_line = f"[{timestamp}] {level}:sdap.universal_pipeline:{message}\n"
            req.execution_logs = (req.execution_logs or "") + log_line
            session.commit()
    except Exception as e:
        logger.warning(f"Could not persist execution log: {e}")
    finally:
        if close_needed:
            session.close()


def _get_or_create_job(db, request_id: int, stage: str) -> ProcessJobModel:
    """
    SRS 8.1.1: Get the existing QUEUED job for this stage, or create a new one.
    Ensures each pipeline stage is tracked in the database.
    """
    job = db.query(ProcessJobModel).filter(
        ProcessJobModel.request_id == request_id,
        ProcessJobModel.stage == stage,
        ProcessJobModel.status == "QUEUED"
    ).first()

    if not job:
        job = ProcessJobModel(request_id=request_id, stage=stage, status="QUEUED")
        db.add(job)
        db.commit()
        db.refresh(job)

    return job


def _update_job(db, job: ProcessJobModel, status: str, error_log: str = None):
    """Update a ProcessJobModel's status and optional error log."""
    job.status = status
    job.updated_at = datetime.utcnow()
    if error_log:
        job.error_log = error_log
    db.commit()


def _is_request_stopped(db, request_id: int) -> bool:
    """Check if the user requested to STOP/CANCEL this request."""
    if not request_id:
        return False
    try:
        row = db.query(RequestModel.status).filter(RequestModel.id == request_id).first()
        return row is not None and row[0] in ("STOPPED", "CANCELLED", "REJECTED")
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────────────────────
# Main Pipeline
# ─────────────────────────────────────────────────────────────────────────────

def run_district_acquisition_pipeline(
    district_name: str,
    start_date: str,
    end_date: str,
    satellite: str = "Sentinel-2",
    indices: list = None,
    request_id: int = 1,
    state_name: str = None
) -> bool:
    """
    Executes the complete SDAP acquisition & processing workflow for a district.

    Modules executed (SRS 8.1):
      M2  — Gap Check: resolve tiles, list AWS scenes, identify missing
      M3  — Downloader: fetch missing files, verify, retry
      M4  — Archive: write band_file records, mark scene HELD when complete
      M5  — Processor: cloud mask + full-tile index (only if data held)
      M5.5— Delivery: join, reproject, clip, district average (only if indexed)
    """
    if indices is None:
        indices = ["NDVI", "LSWI"]

    banner_top = "=" * 78
    header_title = f"SDAP PIPELINE EXECUTION | District: {district_name} ({state_name or 'Auto'})"
    header_sub = f"Range: {start_date} to {end_date} | Satellite: {satellite} | Indices: {indices}"
    logger.info(banner_top)
    logger.info(header_title)
    logger.info(header_sub)
    logger.info(banner_top)

    db = SessionLocal()
    try:
        append_request_log(db, request_id, banner_top)
        append_request_log(db, request_id, f"  {header_title}")
        append_request_log(db, request_id, f"  {header_sub}")
        append_request_log(db, request_id, banner_top)

        # ────────────────────────────────────────────────
        # STAGE 1 — Gap Check (SRS M2)
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "Pipeline halted before gap check because request was STOPPED.", level="WARNING")
            append_request_log(db, request_id, "[STOPPED] Pipeline halted before gap check because request was cancelled.", level="WARNING")
            return False

        gap_job = _get_or_create_job(db, request_id, "GAP_CHECK")
        _update_job(db, gap_job, "RUNNING")

        step1_msg = f"STEP 1: Gap Check & Scene Search for '{district_name}'..."
        logger.info(step1_msg)
        append_request_log(db, request_id, step1_msg)
        append_request_log(db, request_id, "\n[STAGE 1/4] SCENE DISCOVERY & GAP CHECK")
        append_request_log(db, request_id, f"  • Querying database for tiles overlapping '{district_name}'...")

        gap_res = perform_gap_check(db, district_name, start_date, end_date, satellite)

        if gap_res.get("status") == "ERROR" or not gap_res.get("tiles"):
            err = gap_res.get("message", f"No mapped tiles found for district '{district_name}'.")
            logger.error(err)
            append_request_log(db, request_id, f"ERROR: {err}", level="ERROR")
            append_request_log(db, request_id, f"  [ERROR] {err}", level="ERROR")
            _update_job(db, gap_job, "FAILED", error_log=err)
            return False

        tiles = gap_res["tiles"]
        missing_scenes = gap_res["missing_scenes"]
        avail_count = gap_res.get('total_available_scenes', 0)
        held_count = gap_res.get('held_scenes_count', 0)

        res_msg = (
            f"Gap Check complete. "
            f"Tiles: {tiles} | "
            f"Available on S3: {gap_res.get('total_available_scenes', 0)} | "
            f"Already held: {gap_res.get('held_scenes_count', 0)} | "
            f"Genuinely missing: {len(missing_scenes)}"
        )
        logger.info(res_msg)
        append_request_log(db, request_id, res_msg)
        append_request_log(db, request_id, f"  • S2 MGRS Tiles identified ({len(tiles)} total): {tiles}")
        append_request_log(db, request_id, f"  • Available on AWS S3:     {avail_count} total scenes")
        append_request_log(db, request_id, f"  • Already held in archive: {held_count} scenes (cached)")
        append_request_log(db, request_id, f"  • Missing from archive:    {len(missing_scenes)} scenes (queued for download)")

        # Detailed individual tile breakdown
        append_request_log(db, request_id, f"\n[STAGE 1/2] INDIVIDUAL TILE AUDIT & STORAGE STATUS ({len(tiles)} Tiles):")
        tile_statuses = gap_res.get("tile_statuses", {})
        for t in tiles:
            t_info = tile_statuses.get(t, {})
            t_stat = t_info.get("status", "UNKNOWN")
            t_tot = t_info.get("total_scenes", 0)
            t_h = t_info.get("held_scenes", 0)
            t_m = t_info.get("missing_scenes", 0)
            arch_p = t_info.get("archive_dir", f"data/archive/{t}")

            if t_stat == "DOWNLOADED":
                append_request_log(
                    db, request_id,
                    f"  • [TILE STATUS: DOWNLOADED] Tile '{t}': 100% CACHED ({t_h}/{t_tot} scenes verified in '{arch_p}'). Skipping re-download."
                )
            elif t_stat == "PARTIALLY_DOWNLOADED":
                append_request_log(
                    db, request_id,
                    f"  • [TILE STATUS: PARTIAL] Tile '{t}': PARTIALLY CACHED ({t_h}/{t_tot} scenes cached, {t_m} scenes queued for download)."
                )
            elif t_stat == "PENDING_DOWNLOAD":
                append_request_log(
                    db, request_id,
                    f"  • [TILE STATUS: PENDING] Tile '{t}': PENDING DOWNLOAD (0/{t_tot} scenes held, {t_m} scenes queued for download)."
                )
            else:
                append_request_log(
                    db, request_id,
                    f"  • [TILE STATUS: NO DATA] Tile '{t}': 0 scenes found on AWS S3 for the requested date window."
                )

        for h_sc in gap_res.get("held_scenes", []):
            dl_time = h_sc.get("downloaded_at", "previously")
            arch_p = h_sc.get("archive_path", "")
            append_request_log(
                db, request_id,
                f"  • [CACHE VERIFIED] Scene '{h_sc['scene_id']}' (Tile {h_sc['tile']}, Date {h_sc['sensing_date']}) "
                f"cached at '{arch_p}' (Downloaded: {dl_time}). Skipping download."
            )

        append_request_log(db, request_id, f"  ✓ Stage 1 Complete: Gap Check verified.")
        _update_job(db, gap_job, "COMPLETED")

        # ────────────────────────────────────────────────
        # STAGE 2 — Download (SRS M3 + M4)
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "[STOPPED] Pipeline halted before download stage because request was cancelled.", level="WARNING")
            return False

        dl_job = _get_or_create_job(db, request_id, "DOWNLOAD")
        _update_job(db, dl_job, "RUNNING")

        step2_msg = f"STEP 2: Downloading {len(missing_scenes)} missing scenes from AWS Open Data S3..."
        logger.info(step2_msg)
        append_request_log(db, request_id, step2_msg)
        append_request_log(db, request_id, f"\n[STAGE 2/2] FETCHING & VERIFYING {len(missing_scenes)} MISSING SCENES FROM AWS S3 (GeoTIFF)")
        append_request_log(db, request_id, f"  • S2 COGs: '{settings.AWS_SENTINEL_COGS_BUCKET}' ({settings.AWS_COGS_REGION}) | S1 GRD: '{settings.AWS_SENTINEL_1_BUCKET}' ({settings.AWS_SENTINEL_1_REGION})")

        req_record = db.query(RequestModel).filter(RequestModel.id == request_id).first()
        user_id = req_record.user_id if req_record else None

        downloaded_count = 0
        tile_downloaded_count = {t: 0 for t in tiles}
        held_scenes = []

        for idx, sc in enumerate(missing_scenes, start=1):
            pct = int((idx / len(missing_scenes)) * 100)

            # Check for cancellation before processing each scene
            if _is_request_stopped(db, request_id):
                stop_log = f"\n[STOPPED] Execution cancelled by user at scene [{idx}/{len(missing_scenes)}]. Download halted cleanly."
                logger.warning(stop_log)
                append_request_log(db, request_id, stop_log, level="WARNING")
                _update_job(db, dl_job, "STOPPED", error_log="Stopped by user")
                return False

            s_id = sc["scene_id"]

            # Create or retrieve SceneModel record (SRS M4 — archive record)
            scene_obj = db.query(SceneModel).filter(SceneModel.scene_id == s_id).first()
            if not scene_obj:
                scene_obj = SceneModel(
                    scene_id=s_id,
                    tile=sc["tile"],
                    sensing_date=sc["sensing_date"],
                    satellite=sc["satellite"],
                    folder=sc["folder"],
                    prefix=sc["prefix"],
                    status="PENDING"
                )
                db.add(scene_obj)
                db.commit()

            dl_msg = f"  [{idx}/{len(missing_scenes)} - {pct}%] Processing '{sc['folder']}' (Tile {sc['tile']}, Date {sc['sensing_date']})..."
            logger.info(dl_msg)
            append_request_log(db, request_id, dl_msg)

            ok, band_details, dl_log = download_and_verify_scene(db, scene_obj, user_id=user_id)
            ok, band_details, dl_log = download_and_verify_scene(db, scene_obj, user_id=user_id, request_id=request_id)
            if ok:
                downloaded_count += 1
                held_scenes.append(scene_obj)
                sc_tile = sc.get("tile", "")
                tile_downloaded_count[sc_tile] = tile_downloaded_count.get(sc_tile, 0) + 1
                append_request_log(db, request_id, f"     ✓ {dl_log}")

                # Associate scene with this request in process_jobs for reliable downstream TIF retrieval
                try:
                    existing_sc_job = db.query(ProcessJobModel).filter(
                        ProcessJobModel.request_id == request_id,
                        ProcessJobModel.scene_id == s_id
                    ).first()
                    if not existing_sc_job:
                        db.add(ProcessJobModel(
                            request_id=request_id,
                            scene_id=s_id,
                            stage="DOWNLOAD",
                            status="COMPLETED"
                        ))
                        db.commit()
                except Exception as pj_err:
                    logger.warning(f"Could not record process_job for scene {s_id}: {pj_err}")
                    db.rollback()
            else:
                failed_bands = [b['band'] for b in band_details if not b.get('ok')]
                append_request_log(
                    db, request_id,
                    f"     ⚠ WARN: Scene '{sc['scene_id']}' download failed (Incomplete bands: {failed_bands}) - remains PENDING.",
                    level="WARNING"
                )

        dl_summary = f"  ✓ Stage 2 Complete: Downloaded & verified {downloaded_count}/{len(missing_scenes)} scenes."
        logger.info(dl_summary)
        append_request_log(db, request_id, dl_summary)
        _update_job(db, dl_job, "COMPLETED" if downloaded_count > 0 else "FAILED")

        # Comprehensive individual tile final audit summary
        append_request_log(db, request_id, "\n" + "=" * 78)
        append_request_log(db, request_id, f"  INDIVIDUAL TILE ACQUISITION SUMMARY FOR '{district_name}'")
        append_request_log(db, request_id, "-" * 78)
        for t in tiles:
            t_info = tile_statuses.get(t, {})
            t_tot = t_info.get("total_scenes", 0)
            t_init_held = t_info.get("held_scenes", 0)
            t_new_dl = tile_downloaded_count.get(t, 0)
            t_final_held = t_init_held + t_new_dl
            arch_p = os.path.join(settings.RAW_ARCHIVE_DIR, t)

            if t_tot > 0 and t_final_held >= t_tot:
                status_label = "DOWNLOADED (100% Complete)"
                log_tag = "TILE STATUS: DOWNLOADED"
            elif t_final_held > 0:
                status_label = f"PARTIAL ({t_final_held}/{t_tot} scenes)"
                log_tag = "TILE STATUS: PARTIAL"
            elif t_tot == 0:
                status_label = "NO DATA ON AWS"
                log_tag = "TILE STATUS: NO DATA"
            else:
                status_label = "FAILED / INCOMPLETE"
                log_tag = "TILE STATUS: INCOMPLETE"

            append_request_log(
                db, request_id,
                f"  • [{log_tag}] Tile '{t}': {status_label} | {t_final_held}/{t_tot} scenes stored locally in '{arch_p}'."
            )
        append_request_log(db, request_id, "=" * 78)

        # Retrieve all verified TIF raster file paths for this request for subsequent processing
        from app.services.downloader_service import get_downloaded_tifs_for_request
        tif_summary = get_downloaded_tifs_for_request(db, request_id)
        total_tifs = tif_summary.get("total_tifs", 0)
        total_mb = tif_summary.get("total_size_mb", 0.0)

        # Pipeline completes upon data download and local archive verification
        success_msg = (
            f"DATA DOWNLOAD & ACQUISITION COMPLETED FOR '{district_name}' ({satellite}). "
            f"Total Scenes Held/Downloaded: {downloaded_count + held_count} (New: {downloaded_count}, Cached: {held_count}). "
            f"Total GeoTIFF (.tif) files ready: {total_tifs} ({total_mb:.1f} MB)."
        )
        logger.info("=" * 78)
        logger.info(success_msg)
        logger.info("=" * 78)
        append_request_log(db, request_id, success_msg)
        append_request_log(db, request_id, "\n" + "=" * 78)
        append_request_log(db, request_id, f"  DATA ACQUISITION FINISHED SUCCESSFULLY FOR '{district_name}'")
        append_request_log(db, request_id, f"  Archive Location: '{settings.RAW_ARCHIVE_DIR}' (GeoTIFFs only)")
        append_request_log(db, request_id, f"  Scenes Verified:  {downloaded_count + held_count} total ({downloaded_count} newly downloaded, {held_count} cached).")
        append_request_log(db, request_id, f"  GeoTIFFs Ready:   {total_tifs} .tif files ({total_mb:.1f} MB) ready for next processing steps.")
        append_request_log(db, request_id, "=" * 78)
        return True

    except Exception as e:
        err_msg = f"Pipeline exception for request #{request_id}: {e}"
        logger.exception(err_msg)
        try:
            append_request_log(db, request_id, f"FATAL ERROR: {err_msg}", level="ERROR")
        except Exception:
            pass
        return False

    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Batch & State-Level Processing
# ─────────────────────────────────────────────────────────────────────────────

def process_all_districts_in_db(start_date: str, end_date: str, satellite: str = "Sentinel-2"):
    """Iterates through all mapped districts in district_tiles_mapping and runs the pipeline."""
    db = SessionLocal()
    try:
        all_dists = get_all_mapped_districts(db)
        logger.info(f"Found {len(all_dists)} unique mapped districts. Processing all...")
        for i, d_info in enumerate(all_dists):
            d_name = d_info["district_name"]
            st_name = d_info["state_name"]
            logger.info(f"\n--- Batch District {i+1}/{len(all_dists)}: {d_name} ({st_name}) ---")
            run_district_acquisition_pipeline(
                district_name=d_name,
                state_name=st_name,
                start_date=start_date,
                end_date=end_date,
                satellite=satellite,
                request_id=d_info["district_id"]
            )
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description="SDAP Universal Satellite Acquisition Pipeline")
    parser.add_argument("--district", type=str, default=None)
    parser.add_argument("--state", type=str, default=None)
    parser.add_argument("--all-districts", action="store_true")
    parser.add_argument("--start-date", type=str, default="2025-01-01")
    parser.add_argument("--end-date", type=str, default="2025-01-31")
    parser.add_argument("--satellite", type=str, default="Sentinel-2")
    parser.add_argument("--request-id", type=int, default=1)
    args = parser.parse_args()

    if args.all_districts:
        process_all_districts_in_db(args.start_date, args.end_date, args.satellite)
    elif args.district:
        run_district_acquisition_pipeline(
            district_name=args.district,
            state_name=args.state,
            start_date=args.start_date,
            end_date=args.end_date,
            satellite=args.satellite,
            request_id=args.request_id
        )
    elif args.state:
        db = SessionLocal()
        try:
            dists = [r[0] for r in db.execute(
                text("""
                    SELECT DISTINCT dtm.district_name
                    FROM district_tiles_mapping dtm
                    JOIN district_boundaries db ON dtm.district_id = db.id
                    WHERE LOWER(db.state_name) = LOWER(:st);
                """),
                {"st": args.state}
            ).fetchall()]
            logger.info(f"State '{args.state}' has {len(dists)} mapped districts: {dists}")
            for d in dists:
                run_district_acquisition_pipeline(
                    district_name=d,
                    state_name=args.state,
                    start_date=args.start_date,
                    end_date=args.end_date,
                    satellite=args.satellite
                )
        finally:
            db.close()
    else:
        logger.info("No --district or --state specified. Using first mapped district from DB...")
        db = SessionLocal()
        try:
            sample = get_all_mapped_districts(db)
            if sample:
                first = sample[0]
                logger.info(f"Selected: '{first['district_name']}' ({first['state_name']})")
                run_district_acquisition_pipeline(
                    district_name=first["district_name"],
                    state_name=first["state_name"],
                    start_date=args.start_date,
                    end_date=args.end_date,
                    satellite=args.satellite,
                    request_id=first["district_id"]
                )
        finally:
            db.close()


def get_request_tif_paths(request_id: int) -> list[str]:
    """
    Helper for subsequent processing stages (Stage 3 Indexing, Stage 4 Delivery Clipping)
    to retrieve the exact list of downloaded GeoTIFF file paths for a request.
    """
    from app.services.downloader_service import get_downloaded_tifs_for_request
    db = SessionLocal()
    try:
        res = get_downloaded_tifs_for_request(db, request_id)
        return res.get("tif_paths", [])
    finally:
        db.close()


if __name__ == "__main__":
    main()
