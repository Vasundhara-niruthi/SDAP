from fastapi import APIRouter, Depends, HTTPException, status, BackgroundTasks, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import text
from typing import List, Optional
from datetime import datetime

from app.core.database import get_db, SessionLocal
from app.core.security import get_current_user, get_current_admin
from app.models.sdap_models import RequestModel, UserModel, ProcessJobModel
from app.schemas.request_schema import RequestCreate, RequestResponse, RequestEstimateResponse

router = APIRouter()

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

    total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
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

        district_name = req.district or req.state or "Khammam"
        start_str = req.start_date.strftime("%Y-%m-%d")
        end_str = req.end_date.strftime("%Y-%m-%d")
        indices = req.indices if isinstance(req.indices, list) and req.indices else ["NDVI", "LSWI"]

        from scripts.download_district_tiles import run_district_acquisition_pipeline
        ok = run_district_acquisition_pipeline(
            district_name=district_name,
            start_date=start_str,
            end_date=end_str,
            satellite=req.satellite,
            indices=indices,
            request_id=req.id
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


def build_request_response(req: RequestModel) -> RequestResponse:
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
        priority=req.priority,
        status=req.status,
        storage_estimated_gb=req.storage_estimated_gb,
        execution_logs=req.execution_logs,
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

    if satellite not in {"Sentinel-1", "Sentinel-2"}:
        raise HTTPException(status_code=422, detail="satellite must be 'Sentinel-1' or 'Sentinel-2'.")

    # Build a lightweight object for the estimator
    class _Req:
        pass
    r = _Req()
    r.state = state
    r.district = district
    r.satellite = satellite
    r.start_date = start_dt
    r.end_date = end_dt

    est = estimate_request_storage(r, db)

    return RequestEstimateResponse(
        state=state,
        district=district,
        satellite=satellite,
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
        priority=req_in.priority,
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
        background_tasks.add_task(run_pipeline_background, db_req.id)

    return build_request_response(db_req)


@router.get("/", response_model=List[RequestResponse], summary="List Requests (Scoped by User Role)")
def list_requests(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Retrieve satellite acquisition requests.
    - Standard USER: sees ONLY their own submitted requests.
    - ADMIN: sees all requests from all users.
    """
    query = db.query(RequestModel).options(joinedload(RequestModel.user))
    if current_user.role != "ADMIN":
        query = query.filter(RequestModel.user_id == current_user.id)

    requests_list = query.order_by(RequestModel.id.desc()).offset(skip).limit(limit).all()
    return [build_request_response(r) for r in requests_list]


@router.get("/{request_id}", response_model=RequestResponse, summary="Get Request by ID")
def get_request(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Retrieve details and execution logs for a specific request."""
    query = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id)
    if current_user.role != "ADMIN":
        query = query.filter(RequestModel.user_id == current_user.id)
    req = query.first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")
    return build_request_response(req)


@router.get("/live-monitoring", summary="Get Real-Time Pipeline Progress (Admin Only)")
def get_live_monitoring(
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin Live Pipeline & Work Activity Feed.
    Provides real-time status, active pipeline stage, estimated completion %,
    and tile processing telemetry for all user jobs.
    """
    all_requests = db.query(RequestModel).options(joinedload(RequestModel.user)).order_by(RequestModel.id.desc()).all()

    monitoring_feed = []
    for req in all_requests:
        # Query the most recent job for this request
        job = db.query(ProcessJobModel).filter(
            ProcessJobModel.request_id == req.id
        ).order_by(ProcessJobModel.job_id.desc()).first()

        if job:
            stage = job.stage
            # Derive progress from stage + completion status
            if job.status == "COMPLETED":
                progress_pct = 100.0 if stage == "DELIVERY_CLIP" else STAGE_PROGRESS.get(stage, 0.0) + 5.0
            elif job.status == "FAILED":
                progress_pct = STAGE_PROGRESS.get(stage, 0.0)
            else:
                progress_pct = STAGE_PROGRESS.get(stage, 0.0)

            active_tile_info = job.error_log or f"Stage: {stage} | Job Status: {job.status}"
        else:
            # Derive from request status when no job record exists
            status_map = {
                "HOLD_FOR_APPROVAL": ("AWAITING_APPROVAL", 0.0, "Request pending Admin approval (Storage > 2,000 GB)."),
                "ACCEPTED": ("QUEUED", 0.0, "Queued for tile discovery and AWS S3 acquisition."),
                "PROCESSING": ("PROCESSING", 50.0, "Tile processing in progress."),
                "COMPLETED": ("COMPLETED", 100.0, "Processing complete. Clipped rasters archived and delivered."),
                "STOPPED": ("STOPPED", 0.0, "Pipeline execution stopped by user."),
                "REJECTED": ("REJECTED", 0.0, "Request rejected — exceeds storage limits."),
            }
            info = status_map.get(req.status, ("SUBMITTED", 0.0, f"Request status: {req.status}"))
            stage, progress_pct, active_tile_info = info

        monitoring_feed.append({
            "request_id": req.id,
            "request_title": req.request_title,
            "user_name": req.user.full_name if req.user else "Unknown",
            "user_email": req.user.email if req.user else "Unknown",
            "satellite": req.satellite,
            "location": f"{req.district}, {req.state}" if req.district else (req.state or "—"),
            "estimated_gb": req.storage_estimated_gb,
            "status": req.status,
            "pipeline_stage": stage,
            "progress_pct": progress_pct,
            "live_telemetry": active_tile_info,
            "submitted_at": req.created_at
        })

    return {
        "timestamp": datetime.utcnow().isoformat(),
        "total_active_jobs": len(all_requests),
        "live_feed": monitoring_feed
    }


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
        background_tasks.add_task(run_pipeline_background, db_req.id)

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

    background_tasks.add_task(run_pipeline_background, request_id)
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

    background_tasks.add_task(run_pipeline_background, request_id)
    return {"request_id": req.id, "status": req.status, "message": f"Pipeline triggered for request #{req.id}."}
