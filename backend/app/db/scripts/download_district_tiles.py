"""
=============================================================================
SDAP Universal District & State Satellite Acquisition & Processing Pipeline
=============================================================================
Location: backend/scripts/download_district_tiles.py

Description:
    Generic, dynamic master script to perform tile lookup for ANY district or state
    present in 'district_tiles_mapping', perform AWS S3 gap check, atomic scene downloading,
    SCL cloud masking, full-tile index calculation, reprojection, mosaicing, and delivery clipping.

    Follows SRS 8.1.1 - Database-Mediated Module Handoff:
    Each stage writes its output to ProcessJobModel before the next stage begins,
    enabling restart-without-repeat and full status visibility at any point.

    FAST-SKIP CHECKS (DB + NAS):
      Stage 2: scene already on NAS (required bands present + raster verified) -> no download.
      Stage 3: NDVI/LSWI (or VV_VH) already on NAS + verified -> no recomputation,
               DB band_file records are (re)synced.

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
from app.services.downloader_service import download_and_verify_scene, ensure_nas_connection, prune_empty_dirs
from app.db.scripts.cloud_removal_and_indices import process_and_save_indices
from app.services.processor_service import compute_full_tile_index
from app.services.delivery_service import produce_district_delivery_output

# verify_raster: prefer the project's own implementation, fall back to a rasterio check.
try:
    from app.services.downloader_service import verify_raster  # returns (ok, info, err)
except ImportError:  # pragma: no cover
    def verify_raster(path: str):
        """Fallback integrity check: file is non-empty and rasterio can open it and read a block."""
        try:
            if not os.path.exists(path) or os.path.getsize(path) == 0:
                return False, None, "missing or empty file"
            import rasterio
            with rasterio.open(path) as src:
                if src.width == 0 or src.height == 0 or src.count == 0:
                    return False, None, "invalid raster dimensions"
                src.read(1, window=((0, 1), (0, 1)))
            return True, None, None
        except Exception as e:
            return False, None, str(e)

# Band-file model is optional at import time; the DB sync helper degrades gracefully.
try:
    from app.models.sdap_models import BandFileModel
except ImportError:  # pragma: no cover
    BandFileModel = None

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.universal_pipeline")

# Minimum band set that must be on NAS for a scene to count as "already downloaded".
REQUIRED_S2_BANDS = ("B04", "B08", "B11", "SCL")
REQUIRED_S1_BANDS = ("VV", "VH")


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def append_request_log(db_session, req_id: int, message: str, level: str = "INFO"):
    """Appends a log entry persistently to RequestModel.execution_logs in PostgreSQL."""
    if not req_id:
        return
    try:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        log_line = f"[{timestamp}] {level}:sdap.universal_pipeline:{message}\n"
        from app.core.database import engine
        with engine.connect() as conn:
            conn.execute(
                text("UPDATE requests SET execution_logs = COALESCE(execution_logs, '') || :line WHERE id = :id"),
                {"line": log_line, "id": req_id}
            )
            conn.commit()
    except Exception as e:
        logger.warning(f"Could not persist execution log: {e}")


def _get_or_create_job(db, request_id: int, stage: str) -> ProcessJobModel:
    """SRS 8.1.1: Get the existing QUEUED job for this stage, or create a new one."""
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


def _scene_attr(sc, name: str, default=""):
    """Read an attribute from either a SceneModel object or a dict."""
    if hasattr(sc, name):
        val = getattr(sc, name)
    elif isinstance(sc, dict):
        val = sc.get(name, default)
    else:
        val = default
    return default if val is None else val


def _is_s1(sc, fallback_satellite: str = "") -> bool:
    sat = str(_scene_attr(sc, "satellite", fallback_satellite))
    prefix = str(_scene_attr(sc, "prefix", ""))
    return "Sentinel-1" in sat or "GRD/" in prefix


def _resolve_scene_dir(sc, fallback_satellite: str = "", district_name: str = "") -> str:
    """
    Single source of truth for where a scene lives on NAS.
    Sentinel-1 layout: RAW_ARCHIVE_DIR/Sentinel-1/<tile>/<district_name>/<year>/<month>/<folder>
    Sentinel-2 layout: RAW_ARCHIVE_DIR/Sentinel-2/<tile>/<year>/<month>/<folder>
    Falls back to intermediate (without district) and legacy layouts without satellite sub-folder.
    """
    tile = str(_scene_attr(sc, "tile", ""))
    folder = str(_scene_attr(sc, "folder", ""))
    date = str(_scene_attr(sc, "sensing_date", ""))
    year = date[0:4] if len(date) >= 4 else "2026"
    month = str(int(date[5:7])) if len(date) >= 7 else "1"
    is_s1_scene = _is_s1(sc, fallback_satellite)
    sat_subfolder = "Sentinel-1" if is_s1_scene else "Sentinel-2"

    if is_s1_scene and district_name:
        dist_dir = os.path.join(settings.RAW_ARCHIVE_DIR, sat_subfolder, tile, district_name, year, month, folder)
        if os.path.exists(dist_dir):
            return dist_dir
        legacy_s1 = os.path.join(settings.RAW_ARCHIVE_DIR, sat_subfolder, tile, year, month, folder)
        if os.path.exists(legacy_s1):
            return legacy_s1
        legacy = os.path.join(settings.RAW_ARCHIVE_DIR, tile, year, month, folder)
        if os.path.exists(legacy):
            return legacy
        return dist_dir

    scene_dir = os.path.join(settings.RAW_ARCHIVE_DIR, sat_subfolder, tile, year, month, folder)
    if not os.path.exists(scene_dir):
        legacy = os.path.join(settings.RAW_ARCHIVE_DIR, tile, year, month, folder)
        if os.path.exists(legacy):
            return legacy
    return scene_dir


def _list_band_paths(scene_dir: str) -> dict:
    """
    Map BAND_NAME -> path for every .tif/.tiff in a scene directory.
    Supports both Sentinel-2 (flat root) and Sentinel-1 ESA SAFE format (measurement/ sub-folder).
    """
    band_paths = {}
    if not os.path.isdir(scene_dir):
        return band_paths

    # 1. Check top-level directory
    for f in os.listdir(scene_dir):
        low = f.lower()
        if low.endswith(".tif") or low.endswith(".tiff"):
            b_name = os.path.splitext(f)[0].upper()
            band_paths[b_name] = os.path.join(scene_dir, f)

    # 2. Check measurement/ sub-folder (Sentinel-1 SAFE standard layout)
    meas_dir = os.path.join(scene_dir, "measurement")
    if os.path.isdir(meas_dir):
        for f in os.listdir(meas_dir):
            low = f.lower()
            if low.endswith(".tif") or low.endswith(".tiff"):
                f_path = os.path.join(meas_dir, f)
                b_clean = os.path.splitext(f)[0].upper()
                if "VV" in b_clean and "VH" not in b_clean:
                    band_paths["VV"] = f_path
                elif "VH" in b_clean and "VV" not in b_clean:
                    band_paths["VH"] = f_path
                band_paths[b_clean] = f_path

    return band_paths


def _scene_cached_on_nas(scene_dir: str, is_s1: bool):
    """
    STAGE 2 FAST CHECK (NAS side): are all required bands present and readable?
    For Sentinel-1, verifies complete SAFE package:
    - manifest.safe exists and is non-empty
    - measurement/ folder exists and contains valid .tif/.tiff rasters
    - annotation/ folder exists and contains files
    - preview/ folder exists
    Returns (cached: bool, band_paths: dict, problem: str|None).
    """
    if is_s1:
        if not os.path.isdir(scene_dir):
            return False, {}, "scene directory does not exist on NAS"

        manifest_p = os.path.join(scene_dir, "manifest.safe")
        if not os.path.isfile(manifest_p) or os.path.getsize(manifest_p) == 0:
            return False, {}, "missing manifest.safe on NAS (incomplete S1 SAFE structure)"

        meas_dir = os.path.join(scene_dir, "measurement")
        if not os.path.isdir(meas_dir):
            return False, {}, "missing measurement/ folder on NAS"
        meas_files = [f for f in os.listdir(meas_dir) if f.lower().endswith((".tif", ".tiff"))]
        if not meas_files:
            return False, {}, "no rasters found inside measurement/ folder on NAS"

        annot_dir = os.path.join(scene_dir, "annotation")
        if not os.path.isdir(annot_dir) or not os.listdir(annot_dir):
            return False, {}, "missing annotation/ folder on NAS"

        prev_dir = os.path.join(scene_dir, "preview")
        if not os.path.isdir(prev_dir):
            return False, {}, "missing preview/ folder on NAS"

        band_paths = _list_band_paths(scene_dir)
        required = REQUIRED_S1_BANDS
        missing = [b for b in required if b not in band_paths]
        if missing:
            return False, band_paths, f"missing bands on NAS: {missing}"

        for b in required:
            ok, _, err = verify_raster(band_paths[b])
            if not ok:
                return False, band_paths, f"band {b} failed verification ({err})"

        return True, band_paths, None

    # Sentinel-2 check
    required = REQUIRED_S2_BANDS
    band_paths = _list_band_paths(scene_dir)
    missing = [b for b in required if b not in band_paths]
    if missing:
        return False, band_paths, f"missing bands on NAS: {missing}"

    for b in required:
        ok, _, err = verify_raster(band_paths[b])
        if not ok:
            return False, band_paths, f"band {b} failed verification ({err})"

    return True, band_paths, None


def _record_index_band_file_in_db(db, scene_id: str, tile: str, sensing_date, satellite: str,
                                  band_name: str, file_path: str):
    """
    STAGE 3 DB SYNC: make sure a band_file record exists for a computed index raster.
    Idempotent: updates the existing row if present, otherwise inserts one.

    NOTE: BandFileModel's column names are not visible in this script, so columns are
    matched by introspection. Adjust the candidate lists below if your schema differs.
    """
    if BandFileModel is None:
        logger.debug("BandFileModel not available; skipping DB band_file sync.")
        return False

    try:
        cols = {c.name for c in BandFileModel.__table__.columns}

        def pick(*names):
            return next((n for n in names if n in cols), None)

        c_scene = pick("scene_id")
        c_band = pick("band", "band_name")
        c_path = pick("file_path", "path", "local_path")
        if not (c_scene and c_band and c_path):
            logger.warning("BandFileModel lacks scene/band/path columns; DB sync skipped.")
            return False

        values = {c_scene: scene_id, c_band: band_name, c_path: file_path}
        for cand, val in (
            (("tile",), tile),
            (("sensing_date",), sensing_date),
            (("satellite",), satellite),
            (("status",), "VERIFIED"),
            (("verified", "is_verified"), 1),
            (("file_size_mb", "size_mb"), round(os.path.getsize(file_path) / (1024 * 1024), 3)),
            (("file_size_bytes", "size_bytes", "file_size"), os.path.getsize(file_path)),
        ):
            col = pick(*cand)
            if col and col not in values:
                values[col] = val

        existing = db.query(BandFileModel).filter(
            getattr(BandFileModel, c_scene) == scene_id,
            getattr(BandFileModel, c_band) == band_name
        ).first()

        if existing:
            for k, v in values.items():
                setattr(existing, k, v)
        else:
            db.add(BandFileModel(**values))
        db.commit()
        return True
    except Exception as e:
        db.rollback()
        logger.warning(f"Could not sync band_file for {scene_id}/{band_name}: {e}")
        return False


def _link_scene_to_request(db, request_id: int, scene_id: str):
    """Associate a scene with this request in process_jobs (for downstream TIF retrieval)."""
    try:
        exists = db.query(ProcessJobModel).filter(
            ProcessJobModel.request_id == request_id,
            ProcessJobModel.scene_id == scene_id
        ).first()
        if not exists:
            db.add(ProcessJobModel(
                request_id=request_id,
                scene_id=scene_id,
                stage="DOWNLOAD",
                status="COMPLETED"
            ))
            db.commit()
    except Exception as pj_err:
        logger.warning(f"Could not record process_job for scene {scene_id}: {pj_err}")
        db.rollback()


def _sync_cached_scene_band_files(db, scene_obj, s_dir: str):
    """Ensure all .tif/.tiff files in a cached NAS scene folder have BandFileModel records."""
    if not BandFileModel or not os.path.isdir(s_dir):
        return
    try:
        now = datetime.utcnow()
        candidate_files = []
        for fname in os.listdir(s_dir):
            if fname.lower().endswith((".tif", ".tiff")):
                candidate_files.append((fname, os.path.join(s_dir, fname)))

        meas_dir = os.path.join(s_dir, "measurement")
        if os.path.isdir(meas_dir):
            for fname in os.listdir(meas_dir):
                if fname.lower().endswith((".tif", ".tiff")):
                    candidate_files.append((fname, os.path.join(meas_dir, fname)))

        for fname, fpath in candidate_files:
            if not os.path.isfile(fpath):
                continue
            fsize = os.path.getsize(fpath)

            # Map canonical band name for Sentinel-1 (iw-vv -> VV, iw-vh -> VH)
            f_upper = os.path.splitext(fname)[0].upper()
            if "VV" in f_upper and "VH" not in f_upper:
                band_name = "VV"
            elif "VH" in f_upper and "VV" not in f_upper:
                band_name = "VH"
            else:
                band_name = fname

            existing_bf = db.query(BandFileModel).filter(
                BandFileModel.scene_id == scene_obj.scene_id,
                BandFileModel.band == band_name
            ).first()
            if existing_bf:
                existing_bf.path = fpath
                existing_bf.size_bytes = fsize
                existing_bf.verified = 1
            else:
                db.add(BandFileModel(
                    scene_id=scene_obj.scene_id,
                    tile=scene_obj.tile,
                    sensing_date=scene_obj.sensing_date,
                    satellite=scene_obj.satellite or "Sentinel-1",
                    band=band_name,
                    path=fpath,
                    size_bytes=fsize,
                    verified=1,
                    downloaded_at=now
                ))
        db.commit()
    except Exception as e:
        db.rollback()
        logger.warning(f"Could not sync cached band files for {scene_obj.scene_id}: {e}")


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
    state_name: str = None,
    max_cloud_cover: float = 100.0,
    composite_interval: str = "none",
    level: str = "max"
) -> bool:
    """
    Executes the complete SDAP acquisition & processing workflow for a district.

    Modules executed (SRS 8.1):
      M2  - Gap Check: resolve tiles, list AWS scenes, identify missing (DB check)
      M3  - Downloader: NAS fast-check, then fetch missing files, verify, retry
      M4  - Archive: write band_file records, mark scene HELD when complete
      M5  - Processor: NAS/DB fast-check, then cloud mask + full-tile index
      M5.5- Compositor: temporal compositing (weekly, fortnightly, monthly) & delivery
    """
    if indices is None:
        indices = ["NDVI", "LSWI"]

    db = SessionLocal()
    try:
        # Use composite_interval and level from the request record if available
        if request_id:
            req_rec = db.query(RequestModel).filter(RequestModel.id == request_id).first()
            if req_rec:
                if (not composite_interval or composite_interval.lower() == "none") and req_rec.composite_interval and req_rec.composite_interval.lower() != "none":
                    composite_interval = req_rec.composite_interval
                if not level or level == "max":
                    level = getattr(req_rec, "level", "max") or "max"

        level = (level or "max").lower().strip()

        banner_top = "=" * 78
        header_title = f"SDAP PIPELINE EXECUTION | District: {district_name} ({state_name or 'Auto'})"
        header_sub = (
            f"Range: {start_date} to {end_date} | Satellite: {satellite} | Indices: {indices} | "
            f"Level: {level.upper()} | Max Cloud: {max_cloud_cover}% | Composite: {composite_interval.upper() if composite_interval else 'NONE'}"
        )
        logger.info(banner_top)
        logger.info(header_title)
        logger.info(header_sub)
        logger.info(banner_top)

        append_request_log(db, request_id, banner_top)
        append_request_log(db, request_id, f"  {header_title}")
        append_request_log(db, request_id, f"  {header_sub}")
        append_request_log(db, request_id, banner_top)

        # ────────────────────────────────────────────────
        # STAGE 1 - Gap Check (SRS M2)  [DB check]
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "[STOPPED] Pipeline halted before gap check because request was cancelled.", level="WARNING")
            return False

        gap_job = _get_or_create_job(db, request_id, "GAP_CHECK")
        _update_job(db, gap_job, "RUNNING")

        if not state_name and request_id:
            req_rec_st = db.query(RequestModel.state).filter(RequestModel.id == request_id).first()
            if req_rec_st and req_rec_st[0]:
                state_name = req_rec_st[0]

        is_pure_s1 = ("Sentinel-1" in satellite) and ("Sentinel-2" not in satellite)
        has_composite = bool(composite_interval and composite_interval.lower() not in ("none", "null", "false", "0"))
        total_stages = (3 if has_composite else 2) if is_pure_s1 else (4 if has_composite else 3)

        step1_msg = f"STEP 1: Gap Check & Scene Search for '{district_name}' ({state_name or 'Auto'})..."
        logger.info(step1_msg)
        append_request_log(db, request_id, step1_msg)
        append_request_log(db, request_id, f"\n[STAGE 1/{total_stages}] SCENE DISCOVERY & GAP CHECK")
        append_request_log(db, request_id, f"  • Querying database for tiles overlapping '{district_name}' (State: {state_name or 'Auto'})...")

        gap_res = perform_gap_check(
            db, district_name, start_date, end_date, satellite,
            max_cloud_cover=max_cloud_cover, state_name=state_name
        )

        if gap_res.get("status") == "ERROR" or not gap_res.get("tiles"):
            err = gap_res.get("message", f"No mapped tiles found for district '{district_name}'.")
            logger.error(err)
            append_request_log(db, request_id, f"  [ERROR] {err}", level="ERROR")
            _update_job(db, gap_job, "FAILED", error_log=err)
            return False

        tiles = gap_res["tiles"]
        missing_scenes = gap_res["missing_scenes"]
        avail_count = gap_res.get("total_available_scenes", 0)
        held_count = gap_res.get("held_scenes_count", 0)

        res_msg = (
            f"Gap Check complete. Tiles: {tiles} | Available on S3: {avail_count} | "
            f"Already held: {held_count} | Genuinely missing: {len(missing_scenes)}"
        )
        logger.info(res_msg)
        append_request_log(db, request_id, res_msg)
        append_request_log(db, request_id, f"  • S2 MGRS Tiles identified ({len(tiles)} total): {tiles}")
        append_request_log(db, request_id, f"  • Available on AWS S3:     {avail_count} total scenes")
        append_request_log(db, request_id, f"  • Already held in archive: {held_count} scenes (cached)")
        append_request_log(db, request_id, f"  • Missing from archive:    {len(missing_scenes)} scenes (queued for download)")

        # Detailed individual tile breakdown
        append_request_log(db, request_id, f"\n[STAGE 1/{total_stages}] INDIVIDUAL TILE AUDIT & STORAGE STATUS ({len(tiles)} Tiles):")
        tile_statuses = gap_res.get("tile_statuses", {})
        for t in tiles:
            t_info = tile_statuses.get(t, {})
            t_stat = t_info.get("status", "UNKNOWN")
            t_tot = t_info.get("total_scenes", 0)
            t_h = t_info.get("held_scenes", 0)
            t_m = t_info.get("missing_scenes", 0)
            arch_p = t_info.get("archive_dir", f"data/archive/{t}")

            if t_stat == "DOWNLOADED":
                append_request_log(db, request_id, f"  • [TILE STATUS: DOWNLOADED] Tile '{t}': 100% CACHED ({t_h}/{t_tot} scenes verified in '{arch_p}'). Skipping re-download.")
            elif t_stat == "PARTIALLY_DOWNLOADED":
                append_request_log(db, request_id, f"  • [TILE STATUS: PARTIAL] Tile '{t}': PARTIALLY CACHED ({t_h}/{t_tot} scenes cached, {t_m} scenes queued for download).")
            elif t_stat == "PENDING_DOWNLOAD":
                append_request_log(db, request_id, f"  • [TILE STATUS: PENDING] Tile '{t}': PENDING DOWNLOAD (0/{t_tot} scenes held, {t_m} scenes queued for download).")
            else:
                append_request_log(db, request_id, f"  • [TILE STATUS: NO DATA] Tile '{t}': 0 scenes found on AWS S3 for the requested date window.")

        for h_sc in gap_res.get("held_scenes", []):
            dl_time = h_sc.get("downloaded_at", "previously")
            arch_p = h_sc.get("archive_path", "")
            sc_id_h = h_sc.get("scene_id")
            append_request_log(
                db, request_id,
                f"  • [CACHE VERIFIED] Scene '{sc_id_h}' (Tile {h_sc.get('tile')}, Date {h_sc.get('sensing_date')}) "
                f"cached at '{arch_p}' (Downloaded: {dl_time}). Skipping download."
            )
            # Ensure cached scenes are recorded in ProcessJobModel for this request
            try:
                if sc_id_h:
                    existing_pj = db.query(ProcessJobModel).filter(
                        ProcessJobModel.request_id == request_id,
                        ProcessJobModel.scene_id == sc_id_h
                    ).first()
                    if not existing_pj:
                        db.add(ProcessJobModel(
                            request_id=request_id,
                            scene_id=sc_id_h,
                            stage="DOWNLOAD",
                            status="COMPLETED"
                        ))
            except Exception as e_pj:
                logger.warning(f"Could not record cached job for {sc_id_h}: {e_pj}")

        try:
            db.commit()
        except Exception:
            db.rollback()

        append_request_log(db, request_id, "  ✓ Stage 1 Complete: Gap Check verified.")
        _update_job(db, gap_job, "COMPLETED")

        # ────────────────────────────────────────────────
        # STAGE 2 - Download (SRS M3 + M4)  [DB + NAS fast check]
        # ────────────────────────────────────────────────
        if _is_request_stopped(db, request_id):
            append_request_log(db, request_id, "[STOPPED] Pipeline halted before download stage because request was cancelled.", level="WARNING")
            return False

        dl_job = _get_or_create_job(db, request_id, "DOWNLOAD")
        _update_job(db, dl_job, "RUNNING")

        step2_msg = f"STEP 2: Verifying/Downloading {len(missing_scenes)} candidate scenes from AWS Open Data S3..."
        logger.info(step2_msg)
        append_request_log(db, request_id, step2_msg)
        append_request_log(db, request_id, f"\n[STAGE 2/{total_stages}] NAS FAST-CHECK & FETCHING {len(missing_scenes)} CANDIDATE SCENES FROM AWS S3 (GeoTIFF)")
        append_request_log(db, request_id, f"  • S2 COGs: '{settings.AWS_SENTINEL_COGS_BUCKET}' ({settings.AWS_COGS_REGION}) | S1 GRD: '{settings.AWS_SENTINEL_1_BUCKET}' ({settings.AWS_SENTINEL_1_REGION})")

        req_record = db.query(RequestModel).filter(RequestModel.id == request_id).first()
        user_id = req_record.user_id if req_record else None

        # Pre-check NAS connectivity if there are missing scenes to process
        nas_root = getattr(settings, "RAW_ARCHIVE_DIR", "")
        if len(missing_scenes) > 0 and nas_root:
            if nas_root.startswith("\\\\") or ":" in nas_root:
                if not ensure_nas_connection(nas_root):
                    nas_err_msg = (
                        f"[NAS_CONNECTION_ERROR] Target NAS storage '{nas_root}' is disconnected or unreachable. "
                        "Aborting download pipeline immediately. Local storage fallback is strictly prohibited to preserve local disk space."
                    )
                    logger.error(nas_err_msg)
                    append_request_log(db, request_id, nas_err_msg, level="ERROR")
                    _update_job(db, dl_job, "FAILED", error_log=nas_err_msg)
                    return False

        downloaded_count = 0       # actually fetched from S3 in this run
        nas_cached_count = 0       # found valid on NAS, download skipped
        failed_count = 0
        tile_downloaded_count = {t: 0 for t in tiles}
        held_scenes = []           # SceneModel objects that are complete (downloaded or NAS-cached)

        for idx, sc in enumerate(missing_scenes, start=1):
            pct = int((idx / len(missing_scenes)) * 100)

            if _is_request_stopped(db, request_id):
                stop_log = f"\n[STOPPED] Execution cancelled by user at scene [{idx}/{len(missing_scenes)}]. Download halted cleanly."
                logger.warning(stop_log)
                append_request_log(db, request_id, stop_log, level="WARNING")
                _update_job(db, dl_job, "STOPPED", error_log="Stopped by user")
                return False

            s_id = sc["scene_id"]
            sc_tile = sc.get("tile", "")

            # Create or retrieve SceneModel record (SRS M4 - archive record)
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

            dl_msg = f"  [{idx}/{len(missing_scenes)} - {pct}%] Processing '{sc['folder']}' (Tile {sc_tile}, Date {sc['sensing_date']})..."
            logger.info(dl_msg)
            append_request_log(db, request_id, dl_msg)

            # ---- FAST CHECK: is the scene already complete on NAS? ----
            s_is_s1 = _is_s1(sc, satellite)
            s_dir = _resolve_scene_dir(sc, satellite, district_name=district_name)
            cached, _, problem = _scene_cached_on_nas(s_dir, s_is_s1)

            if cached:
                if getattr(scene_obj, "status", None) != "HELD":
                    try:
                        scene_obj.status = "HELD"
                        db.commit()
                    except Exception as st_err:
                        db.rollback()
                        logger.warning(f"Could not mark scene {s_id} HELD: {st_err}")

                nas_cached_count += 1
                held_scenes.append(scene_obj)
                tile_downloaded_count[sc_tile] = tile_downloaded_count.get(sc_tile, 0) + 1
                _link_scene_to_request(db, request_id, s_id)
                _sync_cached_scene_band_files(db, scene_obj, s_dir)
                append_request_log(
                    db, request_id,
                    f"     ✓ [NAS VERIFIED - SKIPPED] '{sc['folder']}' already on NAS at '{s_dir}'. Skipping download."
                )
                continue

            if problem and os.path.isdir(s_dir):
                append_request_log(db, request_id, f"     • NAS copy incomplete ({problem}); downloading.")

            # ---- Not (fully) on NAS: download ----
            ok, band_details, dl_log = download_and_verify_scene(db, scene_obj, user_id=user_id, request_id=request_id, district_name=district_name)
            if ok:
                downloaded_count += 1
                held_scenes.append(scene_obj)
                tile_downloaded_count[sc_tile] = tile_downloaded_count.get(sc_tile, 0) + 1
                append_request_log(db, request_id, f"     ✓ {dl_log}")
                _link_scene_to_request(db, request_id, s_id)
            else:
                failed_count += 1
                failed_bands = [b['band'] for b in band_details if not b.get('ok')]
                if dl_log and "[NAS_ERROR]" in dl_log:
                    append_request_log(
                        db, request_id,
                        f"     ❌ {dl_log}",
                        level="ERROR"
                    )
                else:
                    detail_str = f"Incomplete bands: {failed_bands}" if failed_bands else (dl_log or "Download failed")
                    append_request_log(
                        db, request_id,
                        f"     ⚠ WARN: Scene '{sc['scene_id']}' download failed ({detail_str}) - remains PENDING.",
                        level="WARNING"
                    )

        dl_summary = (
            f"  ✓ Stage 2 Complete: {downloaded_count} downloaded, {nas_cached_count} already on NAS "
            f"(skipped), {failed_count} failed, out of {len(missing_scenes)} candidate scenes."
        )
        logger.info(dl_summary)
        append_request_log(db, request_id, dl_summary)

        # Nothing to do or everything satisfied = COMPLETED. FAILED only if there was work and none succeeded.
        if len(missing_scenes) == 0 or (downloaded_count + nas_cached_count) > 0:
            _update_job(db, dl_job, "COMPLETED")
        else:
            _update_job(db, dl_job, "FAILED", error_log="No scenes could be downloaded or verified.")

        # Individual tile final audit summary
        append_request_log(db, request_id, "\n" + "=" * 78)
        append_request_log(db, request_id, f"  INDIVIDUAL TILE ACQUISITION SUMMARY FOR '{district_name}'")
        append_request_log(db, request_id, "-" * 78)
        for t in tiles:
            t_info = tile_statuses.get(t, {})
            t_tot = t_info.get("total_scenes", 0)
            t_init_held = t_info.get("held_scenes", 0)
            t_new = tile_downloaded_count.get(t, 0)
            t_final_held = t_init_held + t_new
            arch_p = os.path.join(settings.RAW_ARCHIVE_DIR, t)

            if t_tot > 0 and t_final_held >= t_tot:
                status_label, log_tag = "DOWNLOADED (100% Complete)", "TILE STATUS: DOWNLOADED"
            elif t_final_held > 0:
                status_label, log_tag = f"PARTIAL ({t_final_held}/{t_tot} scenes)", "TILE STATUS: PARTIAL"
            elif t_tot == 0:
                status_label, log_tag = "NO DATA ON AWS", "TILE STATUS: NO DATA"
            else:
                status_label, log_tag = "FAILED / INCOMPLETE", "TILE STATUS: INCOMPLETE"

            append_request_log(
                db, request_id,
                f"  • [{log_tag}] Tile '{t}': {status_label} | {t_final_held}/{t_tot} scenes stored locally in '{arch_p}'."
            )
        append_request_log(db, request_id, "=" * 78)

        # ────────────────────────────────────────────────
        # SENTINEL-1 SAR CALIBRATION & TERRAIN CORRECTION (ESA SNAP Engine)
        # ────────────────────────────────────────────────
        if "Sentinel-1" in satellite:
            if _is_request_stopped(db, request_id):
                append_request_log(db, request_id, "[STOPPED] Pipeline halted before Sentinel-1 processing because request was cancelled.", level="WARNING")
                return False

            from app.services.sentinel1_processor_service import (
                run_sentinel_1_processing,
                sync_s1_processed_rasters_to_db
            )

            append_request_log(db, request_id, "\n" + "=" * 78)
            append_request_log(db, request_id, "  SENTINEL-1 SAR CALIBRATION & TERRAIN CORRECTION (ESA SNAP GPT)")
            append_request_log(db, request_id, "  Graph: Apply-Orbit-File -> ThermalNoiseRemoval -> Calibration -> Terrain-Correction -> BandMaths")
            append_request_log(db, request_id, "-" * 78)

            s1_candidate_scenes = []
            s1_scene_ids = set()
            for sc_item in list(held_scenes) + list(gap_res.get("held_scenes", [])):
                sc_id = _scene_attr(sc_item, "scene_id", "")
                sc_sat = _scene_attr(sc_item, "satellite", "")
                if ("Sentinel-1" in sc_sat or "S1" in str(sc_id)) and sc_id not in s1_scene_ids:
                    s1_scene_ids.add(sc_id)
                    s1_candidate_scenes.append(sc_item)

            total_s1 = len(s1_candidate_scenes)
            append_request_log(db, request_id, f"  • Found {total_s1} Sentinel-1 scene(s) to verify / process with SNAP engine...")

            for s1_idx, sc_obj in enumerate(s1_candidate_scenes, start=1):
                if _is_request_stopped(db, request_id):
                    append_request_log(db, request_id, f"[STOPPED] S1 processing halted at scene [{s1_idx}/{total_s1}] because request was cancelled.", level="WARNING")
                    return False

                s_id = _scene_attr(sc_obj, "scene_id", "")
                _link_scene_to_request(db, request_id, s_id)
                arch_path = _scene_attr(sc_obj, "archive_path", "")
                scene_dir = os.path.dirname(arch_path) if arch_path.endswith("manifest.safe") else arch_path

                if not os.path.isdir(scene_dir):
                    append_request_log(db, request_id, f"  ⚠ Scene directory '{scene_dir}' not found on disk; skipping.")
                    continue

                append_request_log(db, request_id, f"  [{s1_idx}/{total_s1}] Processing Sentinel-1 Scene: '{os.path.basename(scene_dir)}'...")
                try:
                    s1_res = run_sentinel_1_processing(
                        scene_dir=scene_dir,
                        log_fn=lambda msg: append_request_log(db, request_id, msg)
                    )
                    if s1_res.get("success"):
                        sync_s1_processed_rasters_to_db(db, sc_obj, s1_res)
                    else:
                        append_request_log(db, request_id, f"  ⚠ S1 Processing issue for '{s_id}': {s1_res.get('error')}", level="WARNING")
                except Exception as s1_err:
                    logger.error(f"Error during Sentinel-1 processing for scene '{s_id}': {s1_err}", exc_info=True)
                    append_request_log(db, request_id, f"  ❌ Error processing Sentinel-1 scene '{s_id}': {s1_err}", level="ERROR")

            append_request_log(db, request_id, "=" * 78)

        # ────────────────────────────────────────────────
        # STAGE 3 - Spectral Index Calculation (SRS 8.4.1 & 8.4.3)  [Optical Sentinel-2 Only]
        # ────────────────────────────────────────────────
        indices_computed = 0
        indices_skipped = 0
        index_errors = 0

        if not is_pure_s1:
            if _is_request_stopped(db, request_id):
                append_request_log(db, request_id, "[STOPPED] Pipeline halted before processing stage because request was cancelled.", level="WARNING")
                return False

            proc_job = _get_or_create_job(db, request_id, "TILE_INDEX")
            _update_job(db, proc_job, "RUNNING")

            step3_label = "NDVI & LSWI (Cloud-Masked)"
            step3_msg = f"STEP 3: Processing & Calculating Spectral Indices ({step3_label}) for '{district_name}'..."
            logger.info(step3_msg)
            append_request_log(db, request_id, "\n" + "=" * 78)
            append_request_log(db, request_id, f"  [STAGE 3/{total_stages}] SPECTRAL INDEX PROCESSING & CLOUD REMOVAL ({step3_label})")
            append_request_log(db, request_id, "-" * 78)

            if not indices or len(indices) == 0:
                skip_msg = f"  ✓ [STAGE 3/{total_stages} SKIPPED] No spectral indices selected in request (2-Step Raw Band Acquisition Mode)."
                logger.info(skip_msg)
                append_request_log(db, request_id, "\n" + "=" * 78)
                append_request_log(db, request_id, skip_msg)
                _update_job(db, proc_job, "COMPLETED")
                unique_scenes = []
                total_sc = 0
            else:
                candidate_ids = []
                for sc_item in list(held_scenes) + list(gap_res.get("held_scenes", [])):
                    sc_id = _scene_attr(sc_item, "scene_id", "")
                    if sc_id and sc_id not in candidate_ids:
                        candidate_ids.append(sc_id)

                unique_scenes = []
                for sc_id in candidate_ids:
                    scene_row = db.query(SceneModel).filter(SceneModel.scene_id == sc_id).first()
                    if scene_row:
                        unique_scenes.append(scene_row)
                    else:
                        logger.warning(f"Scene '{sc_id}' not found in DB; skipping index processing.")

                total_sc = len(unique_scenes)

            for n, sc_item in enumerate(unique_scenes, start=1):
                if _is_request_stopped(db, request_id):
                    append_request_log(db, request_id, f"[STOPPED] Processing halted at scene [{n}/{total_sc}] because request was cancelled.", level="WARNING")
                    _update_job(db, proc_job, "STOPPED", error_log="Stopped by user")
                    return False

                s_id = str(_scene_attr(sc_item, "scene_id", ""))
                s_tile = str(_scene_attr(sc_item, "tile", ""))
                s_folder = str(_scene_attr(sc_item, "folder", ""))
                s_date = str(_scene_attr(sc_item, "sensing_date", ""))
                s_sat = str(_scene_attr(sc_item, "satellite", satellite))
                is_s1_scene = _is_s1(sc_item, satellite)

                if is_s1_scene:
                    continue

                scene_dir = _resolve_scene_dir(sc_item, satellite, district_name=district_name)
                band_paths = _list_band_paths(scene_dir)

                # ---------- Optical: NDVI + LSWI ----------
                ndvi_path = os.path.join(scene_dir, "NDVI.tif")
                lswi_path = os.path.join(scene_dir, "LSWI.tif")

                if os.path.exists(ndvi_path) and os.path.exists(lswi_path):
                    ndvi_ok, _, _ = verify_raster(ndvi_path)
                    lswi_ok, _, _ = verify_raster(lswi_path)
                    if ndvi_ok and lswi_ok:
                        _record_index_band_file_in_db(db, s_id or s_folder, s_tile, s_date, s_sat, "NDVI", ndvi_path)
                        _record_index_band_file_in_db(db, s_id or s_folder, s_tile, s_date, s_sat, "LSWI", lswi_path)
                        indices_skipped += 2
                        proc_log = (
                            f"  ✓ [INDICES VERIFIED ON NAS & DB - SKIPPED] [{n}/{total_sc}] Scene '{s_folder}' -> "
                            f"'NDVI.tif' & 'LSWI.tif' cached at '{scene_dir}'. Skipping calculation."
                        )
                        logger.info(proc_log)
                        append_request_log(db, request_id, proc_log)
                        continue

                b04_p = band_paths.get("B04")
                b08_p = band_paths.get("B08")
                b11_p = band_paths.get("B11")
                scl_p = band_paths.get("SCL")

                if b04_p and b08_p and b11_p and scl_p:
                    try:
                        ndvi_out, lswi_out, cov_pct = process_and_save_indices(
                            red_path=b04_p,
                            nir_path=b08_p,
                            swir1_path=b11_p,
                            scl_path=scl_p,
                            district=district_name,
                            acq_date=s_date,
                            output_dir=scene_dir
                        )
                        _record_index_band_file_in_db(db, s_id or s_folder, s_tile, s_date, s_sat, "NDVI", ndvi_path)
                        _record_index_band_file_in_db(db, s_id or s_folder, s_tile, s_date, s_sat, "LSWI", lswi_path)
                        indices_computed += 2
                        proc_log = (
                            f"  ✓ [CLOUD MASKING & INDICES COMPUTED] [{n}/{total_sc}] Scene '{s_folder}' -> "
                            f"Saved 'NDVI.tif' & 'LSWI.tif' in '{scene_dir}' (Clear Coverage: {cov_pct:.1f}%)."
                        )
                        logger.info(proc_log)
                        append_request_log(db, request_id, proc_log)
                    except Exception as s2_err:
                        index_errors += 1
                        warn_log = f"  ⚠ WARN: Cloud removal & index calculation error for '{s_folder}': {s2_err}"
                        logger.warning(warn_log)
                        append_request_log(db, request_id, warn_log, level="WARNING")
                else:
                    index_errors += 1
                    missing_b = [b for b in REQUIRED_S2_BANDS if b not in band_paths]
                    warn_log = f"  ⚠ WARN: Missing required bands for optical indices in '{s_folder}': {missing_b}"
                    logger.warning(warn_log)
                    append_request_log(db, request_id, warn_log, level="WARNING")

            processed_indices_count = indices_computed + indices_skipped
            stage3_summary = (
                f"  ✓ Stage 3 Complete: {indices_computed} index rasters computed, "
                f"{indices_skipped} already on NAS/DB (skipped), {index_errors} errors."
            )
            logger.info(stage3_summary)
            append_request_log(db, request_id, stage3_summary)

            if total_sc > 0 and processed_indices_count == 0 and index_errors > 0:
                _update_job(db, proc_job, "FAILED", error_log=f"{index_errors} scene(s) failed index processing.")
            else:
                _update_job(db, proc_job, "COMPLETED")

        # ────────────────────────────────────────────────
        # STAGE 4 - Temporal Compositing & District Delivery (SRS 8.4 & 8.5)
        # ────────────────────────────────────────────────
        if composite_interval and composite_interval.lower() not in ("none", "null", "false", "0"):
            if _is_request_stopped(db, request_id):
                append_request_log(db, request_id, "[STOPPED] Pipeline halted before compositing because request was cancelled.", level="WARNING")
                return False

            append_request_log(db, request_id, f"\n[STAGE {total_stages}/{total_stages}] TEMPORAL COMPOSITING ({composite_interval.upper()} - LEVEL: {level.upper()})")
            comp_job = _get_or_create_job(db, request_id, "DELIVERY_CLIP")
            _update_job(db, comp_job, "RUNNING")
            try:
                from app.services.compositor_service import run_temporal_compositing_for_request
                run_temporal_compositing_for_request(
                    db=db,
                    request_id=request_id,
                    composite_interval=composite_interval,
                    level=level
                )
                _update_job(db, comp_job, "COMPLETED")
            except Exception as comp_err:
                logger.error(f"Error executing Stage {total_stages} temporal compositing: {comp_err}", exc_info=True)
                append_request_log(db, request_id, f"  ⚠ WARN: Temporal compositing encountered an error: {comp_err}", level="WARNING")
                _update_job(db, comp_job, "FAILED", error_log=str(comp_err))

        # Retrieve all verified TIF raster file paths for this request
        from app.services.downloader_service import get_downloaded_tifs_for_request
        tif_summary = get_downloaded_tifs_for_request(db, request_id)
        total_tifs = tif_summary.get("total_tifs", 0)
        total_mb = tif_summary.get("total_size_mb", 0.0)

        total_held = downloaded_count + nas_cached_count + held_count
        if is_pure_s1:
            success_msg = (
                f"DATA ACQUISITION & RAW BAND DOWNLOAD COMPLETED FOR '{district_name}' ({satellite}). "
                f"Total Scenes Held/Downloaded: {total_held} "
                f"(New: {downloaded_count}, NAS-cached: {nas_cached_count}, DB-cached: {held_count}). "
                f"Total GeoTIFF (.tif) files ready: {total_tifs} ({total_mb:.1f} MB)."
            )
            logger.info("=" * 78)
            logger.info(success_msg)
            logger.info("=" * 78)
            append_request_log(db, request_id, success_msg)
            append_request_log(db, request_id, "\n" + "=" * 78)
            append_request_log(db, request_id, f"  DATA ACQUISITION & PROCESSING FINISHED SUCCESSFULLY FOR '{district_name}'")
            append_request_log(db, request_id, f"  Archive Location: '{settings.RAW_ARCHIVE_DIR}' (SAR Rasters)")
            append_request_log(db, request_id, f"  Scenes Verified:  {total_held} total ({downloaded_count} newly downloaded, {nas_cached_count} NAS-cached, {held_count} DB-cached).")
            append_request_log(db, request_id, f"  GeoTIFFs Ready:   {total_tifs} .tif files ({total_mb:.1f} MB) ready for delivery.")
            append_request_log(db, request_id, "=" * 78)
        else:
            success_msg = (
                f"DATA DOWNLOAD & SPECTRAL INDEX PROCESSING COMPLETED FOR '{district_name}' ({satellite}). "
                f"Total Scenes Held/Downloaded: {total_held} "
                f"(New: {downloaded_count}, NAS-cached: {nas_cached_count}, DB-cached: {held_count}). "
                f"Indices: {indices_computed} computed, {indices_skipped} reused. "
                f"Total GeoTIFF (.tif) files ready: {total_tifs} ({total_mb:.1f} MB)."
            )
            logger.info("=" * 78)
            logger.info(success_msg)
            logger.info("=" * 78)
            append_request_log(db, request_id, success_msg)
            append_request_log(db, request_id, "\n" + "=" * 78)
            append_request_log(db, request_id, f"  DATA ACQUISITION & PROCESSING FINISHED SUCCESSFULLY FOR '{district_name}'")
            append_request_log(db, request_id, f"  Archive Location: '{settings.RAW_ARCHIVE_DIR}' (Rasters & Spectral Indices)")
            append_request_log(db, request_id, f"  Scenes Verified:  {total_held} total ({downloaded_count} newly downloaded, {nas_cached_count} NAS-cached, {held_count} DB-cached).")
            append_request_log(db, request_id, f"  Indices Created:  {indices_computed} computed, {indices_skipped} reused from NAS/DB.")
            append_request_log(db, request_id, f"  GeoTIFFs Ready:   {total_tifs} .tif files ({total_mb:.1f} MB) ready for delivery.")
            append_request_log(db, request_id, "=" * 78)
        return True

    except Exception as e:
        db.rollback()
        err_msg = f"Pipeline exception for request #{request_id}: {e}"
        logger.exception(err_msg)
        try:
            append_request_log(db, request_id, f"FATAL ERROR: {err_msg}", level="ERROR")
        except Exception:
            pass
        return False

    finally:
        # Clean up local staging directory after request completion
        # WARNING: this wipes the WHOLE staging dir; unsafe if several pipelines run concurrently.
        try:
            import shutil
            stg_dir = getattr(settings, "STAGING_DIR", "data/staging")
            if os.path.exists(stg_dir):
                for item in os.listdir(stg_dir):
                    ip = os.path.join(stg_dir, item)
                    if os.path.isdir(ip):
                        shutil.rmtree(ip, ignore_errors=True)
                    elif os.path.isfile(ip):
                        try:
                            os.remove(ip)
                        except Exception:
                            pass
                prune_empty_dirs(stg_dir)
                logger.info(f"Cleaned up local staging directory: '{stg_dir}'")
        except Exception as stg_err:
            logger.warning(f"Staging cleanup error: {stg_err}")
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
            # NOTE: district_id is used as request_id here (kept from original). This can collide
            # with real RequestModel ids; create a dedicated RequestModel per district if that matters.
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


def get_request_tif_paths(request_id: int) -> list[str]:
    """Helper for subsequent stages to retrieve the downloaded GeoTIFF file paths for a request."""
    from app.services.downloader_service import get_downloaded_tifs_for_request
    db = SessionLocal()
    try:
        res = get_downloaded_tifs_for_request(db, request_id)
        return res.get("tif_paths", [])
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
    parser.add_argument("--composite-interval", type=str, default="none",
                        help="Composite interval: 'weekly', 'fortnightly', 'monthly', or 'none'")
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
            request_id=args.request_id,
            composite_interval=args.composite_interval
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
                    satellite=args.satellite,
                    request_id=args.request_id,
                    composite_interval=args.composite_interval
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