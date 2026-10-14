from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, Query
try:
    from fastapi.responses import FileResponse  # type: ignore
except (ImportError, ModuleNotFoundError):
    from starlette.responses import FileResponse  # type: ignore
import os
import logging
from sqlalchemy.orm import Session, joinedload, defer
from sqlalchemy import text
from typing import List, Optional
from datetime import datetime

from app.core.database import get_db, SessionLocal
from app.core.security import get_current_user, get_current_admin
from app.models.sdap_models import RequestModel, UserModel, ProcessJobModel
from app.schemas.request_schema import (
    RequestCreate, RequestResponse, RequestEstimateResponse,
    LayerStackCreate, LayerStackResponse, LayerStackTaskResponse
)
from app.core.config import settings

import threading

logger = logging.getLogger("sdap.requests")
router = APIRouter()

active_request_threads = set()
active_threads_lock = threading.Lock()

def trigger_pipeline_in_thread(request_id: int):
    """Launches the pipeline in a dedicated daemon thread if not already running."""
    with active_threads_lock:
        if request_id in active_request_threads:
            logger.info(f"Request #{request_id} is already running in a background thread.")
            return
        active_request_threads.add(request_id)

    def _worker():
        try:
            run_pipeline_background(request_id)
        finally:
            with active_threads_lock:
                active_request_threads.discard(request_id)

    t = threading.Thread(target=_worker, daemon=True)
    t.start()

# ─────────────────────────────────────────────────────────────────────────────
# Storage thresholds (SRS 8.3)
# ─────────────────────────────────────────────────────────────────────────────
MAX_TOTAL_STORAGE_GB = 10_000.0    # 10 TB usable NAS (SRS 11.2)
APPROVAL_THRESHOLD_PCT = 0.20      # Hold for approval: would use > 20% of free storage
APPROVAL_THRESHOLD_GB = MAX_TOTAL_STORAGE_GB * APPROVAL_THRESHOLD_PCT   # 2,000 GB

# Stage → progress percentage mapping (for live monitoring display)
STAGE_PROGRESS = {
    "GAP_CHECK": 10.0,
    "DOWNLOAD": 40.0,
    "TILE_INDEX": 70.0,
    "DELIVERY_CLIP": 90.0,
}


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def estimate_request_storage(req: RequestCreate, db: Session = None) -> dict:
    """
    Dynamic storage estimation grounded in PostgreSQL tile mappings (SRS 8.3 & 11.1).
    Returns a dict with all estimate components for the confirmation step.
    """
    days = max(1, (req.end_date - req.start_date).days)
    months = days / 30.0

    # Default tile counts (fallback when DB unavailable)
    tile_count = 32 if (req.state and not req.district) else 3

    if db:
        try:
            if req.district:
                res = db.execute(
                    text("SELECT COUNT(DISTINCT tile_id) FROM district_tiles_mapping WHERE LOWER(district_name) = LOWER(:d)"),
                    {"d": req.district}
                ).fetchone()
                if res and res[0] > 0:
                    tile_count = res[0]
            elif req.state:
                res = db.execute(
                    text("""
                        SELECT COUNT(DISTINCT dtm.tile_id)
                        FROM district_tiles_mapping dtm
                        JOIN district_boundaries db_b ON dtm.district_id = db_b.id
                        WHERE LOWER(db_b.state_name) = LOWER(:s)
                    """),
                    {"s": req.state}
                ).fetchone()
                if res and res[0] > 0:
                    tile_count = res[0]
        except Exception:
            pass

    acquisitions_per_month = 2.5 if req.satellite == "Sentinel-1" else 6.0
    scene_size_gb = 0.615 if req.satellite == "Sentinel-1" else 0.270
    is_s1 = "Sentinel-1" in req.satellite
    is_s2 = "Sentinel-2" in req.satellite or not is_s1

    total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
    if is_s1 and is_s2:
        s1_acq = 2.5
        s1_size = 0.615
        s2_acq = 6.0
        s2_size = 0.270
        total_gb = (tile_count * s1_acq * months * s1_size) + (tile_count * s2_acq * months * s2_size)
        scene_count = int(tile_count * (s1_acq + s2_acq) * months)
        acquisitions_per_month = s1_acq + s2_acq
        scene_size_gb = round((s1_size + s2_size) / 2, 3)
    elif is_s1:
        acquisitions_per_month = 2.5
        scene_size_gb = 0.615
        total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
        scene_count = int(tile_count * acquisitions_per_month * months)
    else:
        acquisitions_per_month = 6.0
        scene_size_gb = 0.270
        total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
        scene_count = int(tile_count * acquisitions_per_month * months)

    total_gb = round(total_gb, 2)
    scene_count = int(tile_count * acquisitions_per_month * months)

    will_require_approval = total_gb > APPROVAL_THRESHOLD_GB
    will_be_rejected = total_gb > MAX_TOTAL_STORAGE_GB

    if will_be_rejected:
        status_hint = "REJECTED"
    elif will_require_approval:
        status_hint = "HOLD_FOR_APPROVAL"
    else:
        status_hint = "ACCEPTED"

    return {
        "tile_count": tile_count,
        "acquisitions_per_month": acquisitions_per_month,
        "scene_size_gb": scene_size_gb,
        "date_span_days": days,
        "estimated_total_gb": total_gb,
        "estimated_scene_count": scene_count,
        "will_require_approval": will_require_approval,
        "will_be_rejected": will_be_rejected,
        "approval_threshold_gb": APPROVAL_THRESHOLD_GB,
        "rejection_threshold_gb": MAX_TOTAL_STORAGE_GB,
        "status_hint": status_hint,
    }


def run_pipeline_background(request_id: int):
    """Executes the pipeline in a background task so API returns immediately."""
    db = SessionLocal()
    try:
        req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
        if not req or req.status == "STOPPED":
            return
        req.status = "PROCESSING"
        db.commit()

        district_name = req.district or req.state
        if not district_name:
            raise ValueError(f"Request #{request_id} does not specify a valid district or state.")
        start_str = req.start_date.strftime("%Y-%m-%d")
        end_str = req.end_date.strftime("%Y-%m-%d")
        indices = req.indices if isinstance(req.indices, list) else ["NDVI", "LSWI"]

        max_cloud_cover = float(getattr(req, "max_cloud_cover", 100.0) or 100.0)
        req_level = (getattr(req, "level", "max") or "max").lower().strip()

        from scripts.download_district_tiles import run_district_acquisition_pipeline
        ok = run_district_acquisition_pipeline(
            district_name=district_name,
            start_date=start_str,
            end_date=end_str,
            satellite=req.satellite,
            indices=indices,
            request_id=req.id,
            max_cloud_cover=max_cloud_cover,
            composite_interval=req.composite_interval or "none",
            level=req_level
        )
        db.refresh(req)
        # Only overwrite status if user didn't stop it during execution
        if req.status != "STOPPED":
            req.status = "COMPLETED" if ok else "ACCEPTED"
            db.commit()
    except Exception as e:
        logger.error(f"Error running pipeline for request {request_id}: {e}", exc_info=True)
        try:
            from scripts.download_district_tiles import append_request_log
            append_request_log(db, request_id, f"\n[ERROR] Pipeline crashed unexpectedly: {e}", level="ERROR")
        except Exception:
            pass
        try:
            db.refresh(req)
            if req.status != "STOPPED":
                req.status = "FAILED"
                db.commit()
        except Exception:
            pass
    finally:
        db.close()


def build_request_response(req: RequestModel, include_logs: bool = True) -> RequestResponse:
    """Helper to attach user metadata to request response."""
    return RequestResponse(
        id=req.id,
        user_id=req.user_id,
        user_email=req.user.email if req.user else None,
        user_full_name=req.user.full_name if req.user else None,
        request_title=req.request_title,
        area_type=req.area_type,
        state=req.state,
        district=req.district,
        season=req.season,
        start_date=req.start_date,
        end_date=req.end_date,
        satellite=req.satellite,
        bands=req.bands,
        indices=req.indices,
        composite_interval=req.composite_interval,
        max_cloud_cover=getattr(req, "max_cloud_cover", 20) or 20,
        level=getattr(req, "level", "max") or "max",
        status=req.status,
        storage_estimated_gb=req.storage_estimated_gb,
        execution_logs=(req.execution_logs[-200000:] if req.execution_logs else None) if include_logs else None,
        created_at=req.created_at
    )


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/estimate", response_model=RequestEstimateResponse, summary="Estimate storage & scenes before submitting (SRS 8.3)")
def estimate_request(
    state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    satellite: str = Query("Sentinel-2"),
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns a storage and scene estimate WITHOUT creating any record.
    This powers the pre-submit confirmation modal (SRS 8.3: show estimate always).
    """
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be in YYYY-MM-DD format.")

    if end_dt < start_dt:
        raise HTTPException(status_code=422, detail="end_date must be >= start_date.")

    parts = [p.strip() for p in satellite.replace("+", ",").replace("&", ",").split(",") if p.strip()]
    if not parts or not all(p in {"Sentinel-1", "Sentinel-2"} for p in parts):
        raise HTTPException(status_code=422, detail="satellite must be 'Sentinel-1', 'Sentinel-2', or both.")
    clean_sat = ", ".join(sorted(list(set(parts))))

    # Build a lightweight object for the estimator
    class _Req:
        pass
    r = _Req()
    r.state = state
    r.district = district
    r.satellite = clean_sat
    r.start_date = start_dt
    r.end_date = end_dt

    est = estimate_request_storage(r, db)

    return RequestEstimateResponse(
        state=state,
        district=district,
        satellite=clean_sat,
        start_date=start_dt,
        end_date=end_dt,
        **est
    )


@router.post("/", response_model=RequestResponse, status_code=status.HTTP_201_CREATED, summary="Submit Satellite Processing Request (M1)")
def create_request(
    req_in: RequestCreate,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Submit a satellite acquisition request (SRS M1).
    Associates the request with the logged-in user, estimates storage dynamically,
    applies SRS 8.3 acceptance rules, and triggers pipeline execution for ACCEPTED jobs.
    """
    est = estimate_request_storage(req_in, db)

    if est["will_be_rejected"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Request rejected: estimated storage ({est['estimated_total_gb']} GB) exceeds "
                f"the platform's total usable storage ({MAX_TOTAL_STORAGE_GB:,.0f} GB). "
                "Please reduce the date range or area."
            )
        )

    req_status = est["status_hint"]  # ACCEPTED or HOLD_FOR_APPROVAL

    db_req = RequestModel(
        user_id=current_user.id,
        request_title=req_in.request_title,
        area_type=req_in.area_type,
        state=req_in.state,
        district=req_in.district,
        season=req_in.season,
        start_date=req_in.start_date,
        end_date=req_in.end_date,
        satellite=req_in.satellite,
        bands=req_in.bands,
        indices=req_in.indices,
        composite_interval=req_in.composite_interval,
        max_cloud_cover=getattr(req_in, "max_cloud_cover", 100.0) or 100.0,
        level=(getattr(req_in, "level", "max") or "max").lower().strip(),
        
        status=req_status,
        storage_estimated_gb=est["estimated_total_gb"]
    )

    db.add(db_req)
    db.commit()
    db.refresh(db_req)

    # Create initial pipeline tracking job (SRS 8.1.1 — database-mediated handoff)
    init_job = ProcessJobModel(
        request_id=db_req.id,
        stage="GAP_CHECK",
        status="QUEUED"
    )
    db.add(init_job)
    db.commit()

    # Trigger background pipeline for auto-accepted requests
    if db_req.status == "ACCEPTED":
        trigger_pipeline_in_thread(db_req.id)

    return build_request_response(db_req)


@router.get("/", response_model=List[RequestResponse], summary="List Requests (Scoped by User Role)")
def list_requests(
    skip: int = 0,
    limit: int = 100,
    scope: Optional[str] = Query(None, description="'mine' to return only current user's requests"),
    user_id: Optional[int] = Query(None, description="Filter requests by user ID (Admin only)"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Retrieve satellite acquisition requests.
    - Standard USER: always sees ONLY their own submitted requests.
    - ADMIN:
      - if scope == 'mine': sees only their own requests.
      - if user_id is provided: sees only that user's requests.
      - otherwise: sees all requests.
    """
    query = db.query(RequestModel).options(
        joinedload(RequestModel.user),
        defer(RequestModel.execution_logs)
    )
    is_admin = (current_user.role or "").strip().upper() == "ADMIN"
    if not is_admin or scope == "mine":
        query = query.filter(RequestModel.user_id == current_user.id)
    elif user_id is not None:
        query = query.filter(RequestModel.user_id == user_id)

    requests_list = query.order_by(RequestModel.id.desc()).offset(skip).limit(limit).all()
    return [build_request_response(r, include_logs=False) for r in requests_list]


@router.get("/by-district/{district_name}", summary="Get requests for a specific district")
def get_requests_by_district(
    district_name: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns requests matching a district name so both Admin and standard Users
    can discover acquisition jobs for layer stacking and data retrieval.
    """
    from sqlalchemy import func
    reqs = db.query(RequestModel).filter(
        func.lower(RequestModel.district) == district_name.strip().lower()
    ).order_by(RequestModel.id.desc()).all()
    return [build_request_response(r, include_logs=False) for r in reqs]


@router.get("/{request_id}", response_model=RequestResponse, summary="Get Request by ID")
def get_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Retrieve details and execution logs for a specific request."""
    query = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id)
    req = query.first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")
    return build_request_response(req)


@router.patch("/{request_id}/status", response_model=RequestResponse, summary="Approve / Update Request Status (Admin Only)")
def update_request_status(
    request_id: int,
    status_value: str,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to approve requests (e.g., from HOLD_FOR_APPROVAL → ACCEPTED).
    If approved to ACCEPTED, automatically triggers the background pipeline.
    """
    db_req = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id).first()
    if not db_req:
        raise HTTPException(status_code=404, detail="Request not found.")

    new_status = status_value.upper()
    db_req.status = new_status
    db.commit()
    db.refresh(db_req)

    # Auto-trigger pipeline when admin approves a held request
    if new_status == "ACCEPTED":
        trigger_pipeline_in_thread(db_req.id)

    return build_request_response(db_req)


@router.post("/{request_id}/stop", summary="Stop / Cancel Running Request Pipeline")
def stop_request_pipeline(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Stops a running or accepted request pipeline immediately.
    Sets request status to 'STOPPED', marks active jobs as 'STOPPED',
    and signals the background worker to halt execution.
    """
    req = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")

    if current_user.role != "ADMIN" and req.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized to stop this request.")

    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    stop_entry = f"[{timestamp}] WARNING:sdap.universal_pipeline:--- PIPELINE EXECUTION STOPPED BY USER ---\n"
    req.execution_logs = (req.execution_logs or "") + stop_entry
    req.status = "STOPPED"

    # Also update any active ProcessJobModel
    active_jobs = db.query(ProcessJobModel).filter(
        ProcessJobModel.request_id == request_id,
        ProcessJobModel.status.in_(["RUNNING", "QUEUED"])
    ).all()
    for j in active_jobs:
        j.status = "STOPPED"
        j.error_log = "Execution stopped by user"
        j.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(req)
    return build_request_response(req)


@router.post("/{request_id}/rerun", summary="Rerun / Retry Satellite Acquisition Request")
def rerun_request_pipeline(
    request_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Reruns/retries an existing satellite acquisition request.
    Appends retry initiation log and triggers background pipeline.
    """
    req = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")

    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    retry_log = f"[{timestamp}] INFO:sdap.pipeline:--- USER TRIGGERED RE-RUN / RETRY FOR REQUEST #{req.id} ---\n"
    req.execution_logs = (req.execution_logs or "") + retry_log
    req.status = "PROCESSING"
    db.commit()

    trigger_pipeline_in_thread(request_id)
    return build_request_response(req)


@router.post("/{request_id}/process", summary="Manual pipeline trigger (for testing)")
def process_request_pipeline(
    request_id: int,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Manually triggers the end-to-end SDAP pipeline for a specific request.
    """
    req = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")

    req.status = "PROCESSING"
    db.commit()

    trigger_pipeline_in_thread(request_id)
    return {"request_id": req.id, "status": req.status, "message": f"Pipeline triggered for request #{req.id}."}
    return {"request_id": req.id, "status": req.status, "message": f"Pipeline triggered for request #{req.id}."}


@router.get("/tifs/available-regions", summary="Get all States and Districts with downloaded GeoTIFF rasters")
def get_downloaded_regions(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns only the States and Districts that have actual held scenes and downloaded
    GeoTIFF rasters stored in PostgreSQL. Used to populate the frontend Data Retrieval Form.
    """
    from app.services.downloader_service import get_available_downloaded_regions
    return get_available_downloaded_regions(db)


@router.get("/tifs/download-file", summary="Download a specific GeoTIFF raster file directly")
def download_tif_file(
    file_path: str = Query(..., description="Path to the GeoTIFF .tif file"),
    token: Optional[str] = Query(None, description="Optional JWT authentication token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Streams a downloaded GeoTIFF raster file directly to the user's browser for download.
    """
    from app.services.downloader_service import resolve_tif_path
    resolved_path, exists = resolve_tif_path(file_path)

    if not exists or not os.path.exists(resolved_path):
        raise HTTPException(
            status_code=404,
            detail=f"GeoTIFF raster file not found on disk: {file_path}"
        )

    filename = os.path.basename(resolved_path)
    return FileResponse(
        path=resolved_path,
        filename=filename,
        media_type="image/tiff"
    )


@router.get("/tifs/download-zip", summary="Batch download matching GeoTIFF rasters as a ZIP archive")
def download_tifs_zip(
    state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    satellite: Optional[str] = Query(None),
    band: Optional[str] = Query(None),
    composite_interval: Optional[str] = Query(None, description="Temporal interval: weekly, fortnightly, monthly, or none"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    token: Optional[str] = Query(None, description="Optional JWT authentication token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Bundles all matching verified GeoTIFF rasters into a ZIP archive and streams it to the user.
    """
    import zipfile
    import tempfile
    from app.services.downloader_service import search_downloaded_tifs_by_region, resolve_tif_path

    ret = search_downloaded_tifs_by_region(
        db=db, state=state, district=district, satellite=satellite,
        band=band, start_date=start_date, end_date=end_date,
        composite_interval=composite_interval
    )

    tifs = ret.get("tifs", [])
    if not tifs:
        raise HTTPException(status_code=404, detail="No matching downloaded GeoTIFF files found to archive.")

    tmp_dir = tempfile.mkdtemp()
    zip_filename = f"SDAP_GeoTIFFs_{district or state or 'Batch'}.zip"
    zip_path = os.path.join(tmp_dir, zip_filename)

    seen_paths = set()
    seen_arcnames = set()
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
        for item in tifs:
            p, exists = resolve_tif_path(item["path"])
            if not exists or not os.path.exists(p):
                continue

            abs_p = os.path.normcase(os.path.abspath(p))
            if abs_p in seen_paths:
                continue
            seen_paths.add(abs_p)

            norm_p = os.path.normpath(p)
            parts = norm_p.split(os.sep)
            fname = os.path.basename(norm_p)
            dist_folder = district or item.get("tile") or "Rasters"
            sc_id = item.get("scene_id")

            # Check if this is a composite raster
            is_composite = (
                fname.lower().startswith("composite_") or 
                "composites" in [pt.lower() for pt in parts] or
                (item.get("satellite") == "Composite Deliverable")
            )

            if is_composite:
                arcname = f"{dist_folder}/Composites/{fname}"
            elif sc_id and not sc_id.lower().startswith("composite"):
                # Put each scene's band files in its own scene_id folder so all scenes across date range are preserved
                arcname = f"{dist_folder}/{sc_id}/{fname}"
            elif "SDAP_DATA_STORAGE" in parts:
                storage_idx = parts.index("SDAP_DATA_STORAGE")
                rel_parts = [rp for rp in parts[storage_idx + 1:] if rp.lower() != "delivery" and not rp.lower().startswith("request_")]
                arcname = "/".join(rel_parts)
            elif "archive" in parts:
                arch_idx = parts.index("archive")
                rel_parts = [rp for rp in parts[arch_idx + 1:] if rp.lower() != "delivery" and not rp.lower().startswith("request_")]
                arcname = "/".join(rel_parts)
            else:
                arcname = f"{dist_folder}/{fname}"

            # Ensure 'delivery' or 'request_X' is NEVER in arcname
            clean_parts = [ap for ap in arcname.split("/") if ap and ap.lower() != "delivery" and not ap.lower().startswith("request_")]
            clean_arcname = "/".join(clean_parts)
            if not clean_arcname or clean_arcname == fname:
                if sc_id and not sc_id.lower().startswith("composite"):
                    clean_arcname = f"{dist_folder}/{sc_id}/{fname}"
                else:
                    clean_arcname = f"{dist_folder}/{fname}"

            base_arcname = clean_arcname
            counter = 1
            while clean_arcname.lower() in seen_arcnames:
                root, ext = os.path.splitext(base_arcname)
                clean_arcname = f"{root}_{counter}{ext}"
                counter += 1

            seen_arcnames.add(clean_arcname.lower())
            zf.write(p, arcname=clean_arcname)

    import shutil
    from starlette.background import BackgroundTask

    def _cleanup():
        try:
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass

    return FileResponse(
        path=zip_path,
        filename=zip_filename,
        media_type="application/zip",
        background=BackgroundTask(_cleanup)
    )


@router.get("/tifs/retrieve", summary="Retrieve downloaded GeoTIFF rasters by State and District")
def retrieve_tifs_by_region(
    state: Optional[str] = Query(None, description="Filter by State name (e.g. Telangana, Odisha)"),
    district: Optional[str] = Query(None, description="Filter by District name (e.g. Khammam, Cuttack)"),
    satellite: Optional[str] = Query(None, description="Filter by Satellite (Sentinel-1, Sentinel-2)"),
    band: Optional[str] = Query(None, description="Filter by Band name (e.g. B04, B08, TCI, SCL, VV, VH)"),
    composite_interval: Optional[str] = Query(None, description="Filter by Composite interval (weekly, fortnightly, monthly, none)"),
    start_date: Optional[str] = Query(None, description="Filter start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="Filter end date YYYY-MM-DD"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Matches the State and District to tile IDs in district_tiles_mapping, queries PostgreSQL
    for all stored GeoTIFF (.tif) file paths in held scenes, and returns verified file paths
    and metadata for user retrieval and next processing steps.
    """
    from app.services.downloader_service import search_downloaded_tifs_by_region
    return search_downloaded_tifs_by_region(
        db=db,
        state=state,
        district=district,
        satellite=satellite,
        band=band,
        start_date=start_date,
        end_date=end_date,
        composite_interval=composite_interval
    )


@router.get("/{request_id}/tifs", summary="Retrieve all downloaded GeoTIFF file paths for a request")
def get_request_tifs(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns all verified GeoTIFF raster file paths (.tif / .tiff) downloaded for a specific request.
    Enables users and subsequent processing pipelines (Stage 3 Indexing, Stage 4 Delivery Clipping)
    to easily discover and load the exact raster files.
    """
    req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")

    from app.services.downloader_service import get_downloaded_tifs_for_request
    return get_downloaded_tifs_for_request(db, request_id)


@router.get("/{request_id}/composites", summary="List all generated composite GeoTIFFs for a request")
def get_request_composites(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns all temporal composite GeoTIFF deliverables (weekly, fortnightly, monthly)
    generated for a specific request.
    """
    req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")

    district_name = req.district or req.state or "Region"
    interval = req.composite_interval or "none"
    year_str = req.start_date.strftime("%Y") if req.start_date else "2026"

    # Search in NAS composites directory and delivery folder
    search_dirs = [
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, year_str, interval.lower()),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name),
        os.path.join(settings.DELIVERY_DIR, f"request_{request_id}")
    ]

    composites = []
    seen = set()

    for s_dir in search_dirs:
        if os.path.exists(s_dir):
            for root, _, files in os.walk(s_dir):
                for f in files:
                    if f.endswith(".tif") or f.endswith(".tiff"):
                        full_p = os.path.join(root, f)
                        if full_p not in seen:
                            seen.add(full_p)
                            size_mb = os.path.getsize(full_p) / (1024 * 1024)
                            idx_type = "LSWI" if "LSWI" in f.upper() else ("NDVI" if "NDVI" in f.upper() else "INDEX")
                            inferred_interval = interval if interval != "none" else ("weekly" if "weekly" in f.lower() else ("fortnightly" if "fortnightly" in f.lower() else ("monthly" if "monthly" in f.lower() else "none")))
                            composites.append({
                                "filename": f,
                                "path": full_p,
                                "size_mb": round(size_mb, 2),
                                "composite_interval": inferred_interval,
                                "district": district_name,
                                "index": idx_type,
                                "download_url": f"/api/v1/requests/{request_id}/composites/download?filename={f}"
                            })

    return {
        "request_id": request_id,
        "district": district_name,
        "composite_interval": interval,
        "total_composites": len(composites),
        "composites": composites
    }


@router.get("/{request_id}/composites/download", summary="Download a single composite GeoTIFF file directly")
def download_request_composite(
    request_id: int,
    filename: Optional[str] = Query(None, description="Filename of specific composite to download"),
    token: Optional[str] = Query(None, description="Optional JWT authentication token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Downloads a single composite GeoTIFF raster directly (e.g. Composite_NDVI_weekly_Ganjam_20260901_20260905.tif).
    """
    req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")

    district_name = req.district or req.state or "Region"
    interval = req.composite_interval or "none"
    year_str = req.start_date.strftime("%Y") if req.start_date else "2026"

    search_dirs = [
        os.path.join(settings.DELIVERY_DIR, f"request_{request_id}"),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, year_str, interval.lower()),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name)
    ]

    target_file = None
    for s_dir in search_dirs:
        if os.path.exists(s_dir):
            if filename:
                cand = os.path.join(s_dir, filename)
                if os.path.exists(cand):
                    target_file = cand
                    break
            else:
                # Find first TIFF in directory
                for f in os.listdir(s_dir):
                    if f.endswith(".tif") or f.endswith(".tiff"):
                        target_file = os.path.join(s_dir, f)
                        break
            if target_file:
                break

    if not target_file or not os.path.exists(target_file):
        raise HTTPException(status_code=404, detail=f"Composite raster file not found for request #{request_id}.")

    return FileResponse(
        path=target_file,
        filename=os.path.basename(target_file),
        media_type="image/tiff"
    )


@router.post("/layer-stack", response_model=LayerStackTaskResponse, summary="Execute multi-band layer stacking across bands and indices")
def create_layer_stack(
    payload: LayerStackCreate,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Initiates asynchronous multi-band layer stacking with live progress and log tracking:
    Saves to: {RAW_ARCHIVE_DIR}/Composites/stack/{district}/
    Filename: {district}_{season}_{start_date}_{end_date}_{bands}.tif
    """
    from app.services.stacker_service import launch_layer_stack_task
    try:
        task_id = launch_layer_stack_task(
            district=payload.district,
            state=payload.state,
            season=payload.season or "Kharif",
            start_date=payload.start_date,
            end_date=payload.end_date,
            layers=payload.layers,
            clip_to_district=payload.clip_to_district if payload.clip_to_district is not None else True,
            output_filename=getattr(payload, "output_filename", None),
            selected_files=getattr(payload, "selected_files", None),
            selected_files_by_band=getattr(payload, "selected_files_by_band", None),
            request_id=payload.request_id,
            user_id=current_user.id if current_user else None
        )
        return {
            "status": "RUNNING",
            "task_id": task_id,
            "message": f"Layer stacking background task initiated for {payload.district}."
        }
    except Exception as exc:
        logger.error(f"Failed to initiate layer stack task: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Layer stacking launch failed: {exc}")


@router.get("/layer-stack/status/{task_id}", summary="Get live status, progress and execution logs for a layer stacking task")
def get_layer_stack_task_status(
    task_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Poll live progress percentage and real-time execution logs for a layer stacking task (checks in-memory & PostgreSQL)."""
    from app.services.stacker_service import get_stack_job
    job = get_stack_job(task_id, db=db)
    if not job:
        raise HTTPException(status_code=404, detail=f"Layer stacking task '{task_id}' not found.")
    return job


@router.get("/layer-stack/latest-active", summary="Get most recent or active layer stacking task for persistence across page refresh")
def get_latest_layer_stack_task(
    district: Optional[str] = Query(None, description="Optional district filter"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Retrieves the latest running or completed layer stack job from PostgreSQL."""
    from app.services.stacker_service import get_latest_stack_job
    job = get_latest_stack_job(district=district, db=db)
    return job or {}


@router.get("/layer-stack/jobs", summary="List layer stacking jobs history directly from PostgreSQL")
def get_layer_stack_jobs(
    district: Optional[str] = Query(None, description="Filter by district"),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Lists history of layer stacking executions with their logs and outputs."""
    from app.services.stacker_service import list_db_stack_jobs
    return list_db_stack_jobs(district=district, limit=limit, db=db)


@router.get("/layer-stack/download", summary="Download a generated layer-stacked GeoTIFF")
def download_layer_stack(
    file_path: str = Query(..., description="Path to the layer-stacked GeoTIFF"),
    token: Optional[str] = Query(None, description="Optional JWT token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    from app.services.downloader_service import resolve_tif_path
    resolved_path, exists = resolve_tif_path(file_path)
    if not exists or not os.path.exists(resolved_path):
        raise HTTPException(status_code=404, detail=f"Layer-stacked GeoTIFF file not found on disk: {file_path}")

    filename = os.path.basename(resolved_path)
    return FileResponse(
        path=resolved_path,
        filename=filename,
        media_type="image/tiff"
    )


@router.get("/layer-stack/history", summary="List previously generated layer-stacked GeoTIFFs")
def list_layer_stacks(
    district: Optional[str] = Query(None, description="Filter by district"),
    state: Optional[str] = Query(None, description="Filter by state"),
    season: Optional[str] = Query(None, description="Filter by season"),
    start_date: Optional[str] = Query(None, description="Filter by start date"),
    end_date: Optional[str] = Query(None, description="Filter by end date"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    from app.services.stacker_service import list_existing_layer_stacks
    return list_existing_layer_stacks(
        district=district,
        state=state,
        season=season,
        start_date=start_date,
        end_date=end_date
    )


@router.get("/admin/daily-storage", summary="Admin Daily Storage Overview")
def get_admin_daily_storage(
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint returning daily storage occupancy and request volume metrics.
    """
    from app.services.analytics_service import get_daily_storage_analytics
    return get_daily_storage_analytics(db=db, start_date=start_date, end_date=end_date)



