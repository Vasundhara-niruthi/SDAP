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
    try:
        req = db_session.query(RequestModel).filter(RequestModel.id == req_id).first()
        if req:
            timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            log_line = f"[{timestamp}] {level}:sdap.universal_pipeline:{message}\n"
            req.execution_logs = (req.execution_logs or "") + log_line
            db_session.commit()
    except Exception as e:
        logger.warning(f"Could not persist execution log: {e}")


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

    header_msg = (
        f"STARTING SDAP PIPELINE FOR '{district_name}' "
        f"(State: {state_name or 'Auto'}) | "
        f"Date: {start_date} to {end_date} | "
        f"Satellite: {satellite} | Indices: {indices}"
    )
    logger.info("=" * 72)
    logger.info(header_msg)
    logger.info("=" * 72)
    banner_top = "=" * 78
    header_title = f"SDAP PIPELINE EXECUTION | District: {district_name} ({state_name or 'Auto'})"
    header_sub = f"Range: {start_date} to {end_date} | Satellite: {satellite} | Indices: {indices}"
    logger.info(banner_top)
    logger.info(header_title)
    logger.info(header_sub)
    logger.info(banner_top)

    db = SessionLocal()
    try:
        append_request_log(db, request_id, header_msg)
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
        append_request_log(db, request_id, f"  • S2 MGRS Tiles identified: {tiles}")
        append_request_log(db, request_id, f"  • Available on AWS S3:     {avail_count} total scenes")
        append_request_log(db, request_id, f"  • Already held in archive: {held_count} scenes (skipped)")
        for h_sc in gap_res.get("held_scenes", []):
            dl_time = h_sc.get("downloaded_at", "previously")
            arch_p = h_sc.get("archive_path", "")
            append_request_log(
                db, request_id,
                f"  • [ALREADY DOWNLOADED - VERIFIED] Scene '{h_sc['scene_id']}' (Tile {h_sc['tile']}, Date {h_sc['sensing_date']}) "
                f"cached at '{arch_p}' (Downloaded: {dl_time}). Skipping download."
            )

        append_request_log(db, request_id, f"  ✓ Stage 1 Complete: Gap Check verified.")
        _update_job(db, gap_job, "COMPLETED")

        # ────────────────────────────────────────────────
        # STAGE 2 — Download (SRS M3 + M4)
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "Pipeline halted before download stage because request was STOPPED.", level="WARNING")
            append_request_log(db, request_id, "\n[STOPPED] Pipeline halted before download stage because request was cancelled.", level="WARNING")
            return False

        dl_job = _get_or_create_job(db, request_id, "DOWNLOAD")
        _update_job(db, dl_job, "RUNNING")

        step2_msg = (
            f"STEP 2: Downloading {len(missing_scenes)} missing scenes "
            f"from AWS S3 bucket '{settings.AWS_SENTINEL_BUCKET}'..."
        )
        logger.info(step2_msg)
        append_request_log(db, request_id, step2_msg)
        append_request_log(db, request_id, f"\n[STAGE 2/4] FETCHING & VERIFYING {len(missing_scenes)} MISSING SCENES FROM AWS S3")
        append_request_log(db, request_id, f"  • Bucket: '{settings.AWS_SENTINEL_BUCKET}' ({settings.AWS_REGION}) | Concurrency: 5 bands in parallel")

        req_record = db.query(RequestModel).filter(RequestModel.id == request_id).first()
        user_id = req_record.user_id if req_record else None

        downloaded_count = 0
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
            if ok:
                downloaded_count += 1
                held_scenes.append(scene_obj)
                append_request_log(db, request_id, f"     ✓ {dl_log}")
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

        # ────────────────────────────────────────────────
        # Query all HELD scenes for these tiles
        # ────────────────────────────────────────────────
        all_held = db.query(SceneModel).filter(
            SceneModel.tile.in_(tiles),
            SceneModel.status == "HELD"
        ).all()

        if not all_held:
            warn_msg = f"No HELD scenes available for index calculation for tiles {tiles}."
            logger.warning(warn_msg)
            append_request_log(db, request_id, f"WARNING: {warn_msg}", level="WARNING")
            # Return True — gap check + download completed successfully even if nothing to process
            return downloaded_count > 0

        # ────────────────────────────────────────────────
        # STAGE 3 — Cloud Masking & Full-Tile Index (SRS M5)
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "Pipeline halted before index calculation because request was STOPPED.", level="WARNING")
            append_request_log(db, request_id, "\n[STOPPED] Pipeline halted before index calculation because request was cancelled.", level="WARNING")
            return False

        idx_job = _get_or_create_job(db, request_id, "TILE_INDEX")
        _update_job(db, idx_job, "RUNNING")

        step3_msg = (
            f"STEP 3: SCL Cloud Masking & Full-Tile Index Calculation "
            f"({indices}) for {len(all_held)} HELD scenes..."
        )
        logger.info(step3_msg)
        append_request_log(db, request_id, step3_msg)
        append_request_log(db, request_id, f"\n[STAGE 3/4] SCL CLOUD MASKING & FULL-TILE INDEX CALCULATION ({indices})")
        append_request_log(db, request_id, f"  • Processing {len(all_held)} HELD scenes across tiles {tiles}...")

        tile_index_outputs = {}

        for scene in all_held:
            if _is_request_stopped(db, request_id):
                stop_log = "Pipeline execution STOPPED by user. Halting tile index calculation."
                stop_log = "\n[STOPPED] Execution cancelled by user during index calculation."
                logger.warning(stop_log)
                append_request_log(db, request_id, stop_log, level="WARNING")
                _update_job(db, idx_job, "STOPPED", error_log="Stopped by user")
                return False

            band_paths = {
                os.path.splitext(f.band)[0]: f.path
                for f in scene.files if f.verified == 1
            }

            for idx_name in indices:
                if scene.archive_path:
                    out_filename = f"{scene.scene_id}_{idx_name}_fulltile.tif"
                    out_path = os.path.join(scene.archive_path, out_filename)
                else:
                    continue

                try:
                    idx_out, coverage_pct = compute_full_tile_index(band_paths, idx_name, out_path)
                    tile_index_outputs.setdefault(idx_name, []).append(idx_out)
                    append_request_log(
                        db, request_id,
                        f"  -> {idx_name} computed for '{scene.scene_id}' "
                        f"(Cloud-Free Coverage: {coverage_pct:.1f}%)"
                        f"  ✓ {idx_name} computed for scene '{scene.scene_id}' (Cloud-Free: {coverage_pct:.1f}%)"
                    )
                except Exception as err:
                    err_txt = f"Could not compute {idx_name} for scene {scene.scene_id}: {err}"
                    logger.warning(err_txt)
                    append_request_log(db, request_id, f"  -> WARNING: {err_txt}", level="WARNING")
                    append_request_log(db, request_id, f"  ⚠ WARN: {err_txt}", level="WARNING")

        append_request_log(db, request_id, f"  ✓ Stage 3 Complete: All indices calculated.")
        _update_job(db, idx_job, "COMPLETED" if tile_index_outputs else "FAILED")

        # ────────────────────────────────────────────────
        # STAGE 4 — Delivery: Reproject, Mosaic, Clip (SRS M5.5)
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "Pipeline halted before delivery clipping because request was STOPPED.", level="WARNING")
            append_request_log(db, request_id, "\n[STOPPED] Pipeline halted before delivery clipping because request was cancelled.", level="WARNING")
            return False

        deliv_job = _get_or_create_job(db, request_id, "DELIVERY_CLIP")
        _update_job(db, deliv_job, "RUNNING")

        step4_msg = (
            f"STEP 4: Mosaic, Reprojection & Boundary Clipping "
            f"for district '{district_name}'..."
        )
        logger.info(step4_msg)
        append_request_log(db, request_id, step4_msg)
        append_request_log(db, request_id, f"\n[STAGE 4/4] MOSAIC, REPROJECTION & BOUNDARY CLIPPING FOR '{district_name.upper()}'")

        delivery_results = []
        for idx_name, raster_paths in tile_index_outputs.items():
            out_name = f"{district_name}_{idx_name}_deliverable.tif"
            try:
                deliv_res = produce_district_delivery_output(
                    db=db,
                    request_id=request_id,
                    district_name=district_name,
                    index_raster_paths=raster_paths,
                    output_filename=out_name
                )
                deliv_res["index_type"] = idx_name
                delivery_results.append(deliv_res)
                append_request_log(
                    db, request_id,
                    f"  -> Delivered clipped {idx_name}: "
                    f"Mean={deliv_res['district_average_value']:.4f}, "
                    f"Coverage={deliv_res['cloud_free_coverage_pct']:.1f}%"
                    f"  ✓ Output deliverable clipped: {out_name} (Mean {idx_name}: {deliv_res['district_average_value']:.4f}, Coverage: {deliv_res['cloud_free_coverage_pct']:.1f}%)"
                )
            except Exception as err:
                clip_err = f"Failed delivery clip for {idx_name}: {err}"
                logger.error(clip_err)
                append_request_log(db, request_id, f"ERROR: {clip_err}", level="ERROR")
                append_request_log(db, request_id, f"  [ERROR] {clip_err}", level="ERROR")

        _update_job(db, deliv_job, "COMPLETED" if delivery_results else "FAILED")

        success_msg = (
            f"PIPELINE COMPLETED FOR '{district_name}'. "
            f"Total deliverables: {len(delivery_results)}"
        )
        logger.info("=" * 72)
        logger.info(success_msg)
        logger.info("=" * 72)
        append_request_log(db, request_id, success_msg)
        append_request_log(db, request_id, "\n" + "=" * 78)
        append_request_log(db, request_id, f"  PIPELINE FINISHED SUCCESSFULLY FOR '{district_name}'")
        append_request_log(db, request_id, f"  Total Deliverables: {len(delivery_results)} clipped GeoTIFF files ready in delivery folder.")
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


if __name__ == "__main__":
    main()
