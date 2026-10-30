"""
=============================================================================
SDAP Satellite Data Processing Request API Routes
=============================================================================
Location: backend/app/routes/requests.py

Description:
    Exposes endpoints for satellite acquisition requests:
    - Pre-submit storage & scene estimations (SRS 8.3)
    - Submitting, querying, and updating request status
    - Cancelling, re-running, and manually triggering acquisition pipelines
    - Accessing request-level GeoTIFFs and temporal composite deliverables
    - Incorporates modular sub-routers for GeoTIFF Rasters and Layer Stacking.
=============================================================================
"""

import os
import logging
import threading
from datetime import datetime
from typing import List, Optional, Dict, Any

from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, Query
try:
    from fastapi.responses import FileResponse  # type: ignore
except (ImportError, ModuleNotFoundError):
    from starlette.responses import FileResponse  # type: ignore
from sqlalchemy.orm import Session, joinedload, defer
from sqlalchemy import text, func

from app.core.database import get_db, SessionLocal
from app.core.security import get_current_user, get_current_admin
from app.models.sdap_models import RequestModel, UserModel, ProcessJobModel
from app.schemas.request_schema import (
    RequestCreate, RequestResponse, RequestEstimateResponse,
)
from app.core.config import settings

# Import modular sub-routers
from app.routes.rasters import router as rasters_router
from app.routes.layer_stack import router as layer_stack_router

logger = logging.getLogger("sdap.routes.requests")
router = APIRouter()

# ─────────────────────────────────────────────────────────────────────────────
# Thread Management & Pipeline Runner
# ─────────────────────────────────────────────────────────────────────────────
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
# Storage thresholds (SRS 8.3 & 11.2)
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

    will_require_approval = total_gb > APPROVAL_THRESHOLD_GB
    will_be_rejected = total_gb > MAX_TOTAL_STORAGE_GB

    if will_be_rejected:
        status_hint = "REJECTED"
    elif will_require_approval:
        status_hint = "HOLD_FOR_APPROVAL"
    else:
        status_hint = "ACCEPTED"

    # Calculate realistic pipeline execution duration in minutes
    import math
    step1_mins = max(2, round(1.5 + (tile_count * 0.3) + (months * 0.4)))
    if is_s1 and is_s2:
        step2_mins = max(5, round((scene_count * 0.4 * 4.0) + (scene_count * 0.6 * 1.8)))
    elif is_s1:
        step2_mins = max(5, round(scene_count * 4.0))
    else:
        step2_mins = max(5, round(scene_count * 1.8))

    num_indices = len(getattr(req, "indices", []) or []) or 2
    if is_s1 and not is_s2:
        step3_mins = round(scene_count * 4.8)
    elif is_s1 and is_s2:
        step3_mins = round((scene_count * 0.4 * 4.8) + (scene_count * 0.6 * 0.85 * (num_indices / 2.0)))
    else:
        step3_mins = round(scene_count * 0.85 * (num_indices / 2.0))

    comp_interval = (getattr(req, "composite_interval", "monthly") or "monthly").lower()
    if comp_interval == "weekly":
        comp_windows = max(1, math.ceil(days / 7))
    elif comp_interval == "fortnightly":
        comp_windows = max(1, math.ceil(days / 15))
    elif comp_interval == "monthly":
        comp_windows = max(1, math.ceil(days / 30))
    else:
        comp_windows = 0
    step4_mins = round(comp_windows * max(1, num_indices) * 3.2) if comp_windows else 0

    total_duration_mins = step1_mins + step2_mins + step3_mins + step4_mins
    if total_duration_mins < 60:
        duration_text = f"~{total_duration_mins} mins"
    else:
        hrs = total_duration_mins // 60
        rem = total_duration_mins % 60
        if rem == 0:
            duration_text = f"~{hrs} hrs ({total_duration_mins} mins)"
        else:
            duration_text = f"~{hrs} hrs {rem} mins ({total_duration_mins} mins)"

    return {
        "tile_count": tile_count,
        "acquisitions_per_month": acquisitions_per_month,
        "scene_size_gb": scene_size_gb,
        "date_span_days": days,
        "estimated_total_gb": total_gb,
        "estimated_scene_count": scene_count,
        "estimated_duration_mins": total_duration_mins,
        "estimated_duration_text": duration_text,
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

        from app.db.scripts.download_district_tiles import run_district_acquisition_pipeline
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
            req.status = "COMPLETED" if ok else "FAILED"
            db.commit()
    except Exception as e:
        logger.error(f"Error running pipeline for request {request_id}: {e}", exc_info=True)
        try:
            db.close()
        except Exception:
            pass
        try:
            fail_db = SessionLocal()
            from app.db.scripts.download_district_tiles import append_request_log
            append_request_log(fail_db, request_id, f"\n[ERROR] Pipeline crashed unexpectedly: {e}", level="ERROR")
            f_req = fail_db.query(RequestModel).filter(RequestModel.id == request_id).first()
            if f_req and f_req.status != "STOPPED":
                f_req.status = "FAILED"
                fail_db.commit()
            fail_db.close()
        except Exception as ex2:
            logger.error(f"Could not record pipeline failure state for request #{request_id}: {ex2}")
    finally:
        try:
            db.close()
        except Exception:
            pass


def build_request_response(
    req: RequestModel,
    include_logs: bool = True,
    stack_info: Optional[Dict[str, Any]] = None,
    db: Optional[Session] = None
) -> RequestResponse:
    """Helper to attach user metadata and multi-band layer stacking details to request response."""
    from app.services.stacker_service import get_layer_stacks_for_request

    if stack_info is None:
        try:
            stack_info = get_layer_stacks_for_request(req, db=db)
        except Exception:
            stack_info = {"count": 0, "status": "NOT_STARTED", "files": []}

    stk_cnt = stack_info.get("count", 0)
    stk_status = stack_info.get("status", "NOT_STARTED")
    stk_files = stack_info.get("files", [])

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
        created_at=req.created_at,
        stacking_count=stk_cnt,
        stacking_status=stk_status,
        stacked_files=stk_files
    )


# ─────────────────────────────────────────────────────────────────────────────
# Request Endpoints
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


@router.get("/daily-quota", summary="Get remaining request quota for the current user today")
def get_daily_quota(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns today's request usage and remaining quota for the logged-in user (limit: 3 requests/day).
    """
    from datetime import datetime
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    count = db.query(RequestModel).filter(
        RequestModel.user_id == current_user.id,
        RequestModel.created_at >= today_start
    ).count()
    max_limit = 3
    is_admin = (current_user.role or "").strip().upper() == "ADMIN"
    remaining = max(0, max_limit - count) if not is_admin else 999
    return {
        "user_id": current_user.id,
        "is_admin": is_admin,
        "daily_limit": max_limit if not is_admin else 999,
        "used_today": count,
        "remaining_today": remaining,
        "limit_reached": (count >= max_limit and not is_admin)
    }


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
    # ── Daily Request Rate Limit: Max 3 requests per user per calendar day ──
    from datetime import datetime
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    user_daily_requests_count = db.query(RequestModel).filter(
        RequestModel.user_id == current_user.id,
        RequestModel.created_at >= today_start
    ).count()

    MAX_DAILY_REQUESTS = 3
    is_admin = (current_user.role or "").strip().upper() == "ADMIN"
    if user_daily_requests_count >= MAX_DAILY_REQUESTS and not is_admin:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                f"Daily request limit reached: A user can submit a maximum of {MAX_DAILY_REQUESTS} requests per day. "
                f"You have already submitted {user_daily_requests_count} request(s) today. Please try again tomorrow."
            )
        )

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

    req_status = est["status_hint"]

    comp_interval = (req_in.composite_interval or "none").lower().strip()
    is_pure_s1 = "Sentinel-1" in req_in.satellite and "Sentinel-2" not in req_in.satellite
    if is_pure_s1 and comp_interval in ("weekly", "monthly"):
        comp_interval = "fortnightly"

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
        composite_interval=comp_interval,
        max_cloud_cover=getattr(req_in, "max_cloud_cover", 100.0) or 100.0,
        level=(getattr(req_in, "level", "max") or "max").lower().strip(),
        status=req_status,
        storage_estimated_gb=est["estimated_total_gb"]
    )

    db.add(db_req)
    db.commit()
    db.refresh(db_req)

    init_job = ProcessJobModel(
        request_id=db_req.id,
        stage="GAP_CHECK",
        status="QUEUED"
    )
    db.add(init_job)
    db.commit()

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
    from app.services.stacker_service import get_layer_stacks_for_requests_bulk
    bulk_stack_info = get_layer_stacks_for_requests_bulk(requests_list, db=db)
    return [build_request_response(r, include_logs=False, stack_info=bulk_stack_info.get(r.id), db=db) for r in requests_list]


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
    from app.services.stacker_service import get_layer_stacks_for_requests_bulk
    reqs = db.query(RequestModel).filter(
        func.lower(RequestModel.district) == district_name.strip().lower()
    ).order_by(RequestModel.id.desc()).all()
    bulk_stack_info = get_layer_stacks_for_requests_bulk(reqs, db=db)
    return [build_request_response(r, include_logs=False, stack_info=bulk_stack_info.get(r.id), db=db) for r in reqs]


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
    return build_request_response(req, db=db)


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


@router.get("/{request_id}/tifs", summary="Retrieve all downloaded GeoTIFF file paths for a request")
def get_request_tifs(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns all verified GeoTIFF raster file paths (.tif / .tiff) downloaded for a specific request.
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

    search_dirs = [
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, year_str, interval.lower()),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, interval.lower()),
        os.path.join(settings.DELIVERY_DIR, f"request_{request_id}")
    ]

    composites = []
    seen = set()

    def _add_comp_file(f: str, full_p: str):
        if full_p in seen:
            return
        seen.add(full_p)
        try:
            size_mb = os.path.getsize(full_p) / (1024 * 1024)
        except Exception:
            size_mb = 0.0
        f_u = f.upper()
        if "VV_VH" in f_u:
            idx_type = "VV_VH"
        elif "_VV_" in f_u or f_u.startswith("COMPOSITE_VV_"):
            idx_type = "VV"
        elif "_VH_" in f_u or f_u.startswith("COMPOSITE_VH_"):
            idx_type = "VH"
        elif "LSWI" in f_u:
            idx_type = "LSWI"
        elif "NDVI" in f_u:
            idx_type = "NDVI"
        else:
            idx_type = "INDEX"
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

    for s_dir in search_dirs:
        if os.path.isdir(s_dir):
            try:
                for entry in os.scandir(s_dir):
                    if entry.is_file() and (entry.name.lower().endswith(".tif") or entry.name.lower().endswith(".tiff")):
                        _add_comp_file(entry.name, entry.path)
            except Exception:
                pass

    if not composites:
        parent_dir = os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name)
        if os.path.isdir(parent_dir):
            try:
                for root, dirs, files in os.walk(parent_dir):
                    if "stack" in root.lower():
                        continue
                    for f in files:
                        if f.lower().endswith((".tif", ".tiff")):
                            _add_comp_file(f, os.path.join(root, f))
            except Exception:
                pass

    return {
        "request_id": request_id,
        "district": district_name,
        "composite_interval": interval,
        "total_composites": len(composites),
        "composites": composites
    }


@router.get("/{request_id}/stack-logs", summary="Get layer stacking execution jobs and logs for a request")
def get_request_stack_logs(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Retrieves all layer stacking jobs, live statuses, progress percentages,
    and execution logs for a specific user request.
    """
    from app.services.stacker_service import STACK_JOBS, STACK_JOBS_LOCK
    from app.models import LayerStackJobModel

    jobs = db.query(LayerStackJobModel).filter(
        LayerStackJobModel.request_id == request_id
    ).order_by(LayerStackJobModel.id.desc()).all()

    results = []
    for j in jobs:
        live_job = None
        with STACK_JOBS_LOCK:
            live_job = STACK_JOBS.get(j.task_id)

        status = live_job["status"] if live_job else j.status
        progress = live_job["progress"] if live_job else j.progress
        step = live_job["step"] if live_job else j.step
        logs = live_job["logs"] if live_job and live_job.get("logs") else (j.logs_json or [])
        exec_logs = (live_job.get("execution_logs") if live_job else None) or j.execution_logs or ""

        results.append({
            "task_id": j.task_id,
            "request_id": j.request_id,
            "status": status,
            "progress": progress,
            "step": step,
            "district": j.district,
            "state": j.state,
            "season": j.season,
            "layers": j.layers or [],
            "filename": j.filename,
            "output_path": j.output_path,
            "file_size_mb": j.file_size_mb,
            "total_bands": j.total_bands,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "updated_at": j.updated_at.isoformat() if j.updated_at else None,
            "error": live_job.get("error") if live_job else j.error,
            "logs": logs,
            "execution_logs": exec_logs
        })

    return {
        "request_id": request_id,
        "total_jobs": len(results),
        "jobs": results
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


# ─────────────────────────────────────────────────────────────────────────────
# Mount Sub-Routers
# ─────────────────────────────────────────────────────────────────────────────
# Incorporates rasters endpoints (/tifs/...) and layer stacking endpoints (/layer-stack/...)
# directly under the /requests router namespace to preserve 100% backward compatibility.
router.include_router(rasters_router)
router.include_router(layer_stack_router)

