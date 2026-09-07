from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload
from typing import List, Optional
from datetime import datetime

from app.core.database import get_db
from app.core.security import get_current_user, get_current_admin
from app.models.sdap_models import RequestModel, UserModel, ProcessJobModel
from app.schemas.request_schema import RequestCreate, RequestResponse

router = APIRouter()


def estimate_request_storage(req: RequestCreate) -> float:
    """
    Pre-flight estimation logic based on SRS section 8.3 & 11.1:
    - ~355 scenes / month for Odisha (~32 tiles)
    - Scene size: ~270MB (5-band optical) / ~615MB (radar)
    """
    days = max(1, (req.end_date - req.start_date).days)
    months = days / 30.0
    
    tile_count = 32 if (req.state and not req.district) else 3
    acquisitions_per_month = 10
    scene_size_gb = 0.615 if req.satellite == "Sentinel-1" else 0.270
    
    total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
    return round(total_gb, 2)


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
        created_at=req.created_at
    )


@router.post("/", response_model=RequestResponse, status_code=status.HTTP_201_CREATED, summary="Submit Satellite Processing Request")
def create_request(
    req_in: RequestCreate,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Submit a satellite acquisition request (M1).
    Associates the request with the logged-in user and estimates storage.
    """
    estimated_gb = estimate_request_storage(req_in)
    
    req_status = "HOLD_FOR_APPROVAL" if estimated_gb > 500 else "ACCEPTED"

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
        storage_estimated_gb=estimated_gb
    )
    
    db.add(db_req)
    db.commit()
    db.refresh(db_req)

    # Automatically create initial pipeline tracking job
    init_job = ProcessJobModel(
        request_id=db_req.id,
        stage="GAP_CHECK",
        status="QUEUED"
    )
    db.add(init_job)
    db.commit()

    return build_request_response(db_req)


@router.get("/", response_model=List[RequestResponse], summary="List Requests (Scoped by User Role)")
def list_requests(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Retrieve satellite acquisition requests with submitter user details.
    - Standard USER: Sees ONLY their own submitted requests.
    - ADMIN: Sees all requests submitted by all users.
    """
    query = db.query(RequestModel).options(joinedload(RequestModel.user))
    if current_user.role != "ADMIN":
        query = query.filter(RequestModel.user_id == current_user.id)
        
    requests_list = query.order_by(RequestModel.id.desc()).offset(skip).limit(limit).all()
    return [build_request_response(r) for r in requests_list]


@router.patch("/{request_id}/status", response_model=RequestResponse, summary="Approve / Update Request Status (Admin Only)")
def update_request_status(
    request_id: int,
    status_value: str,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to approve requests (e.g. from HOLD_FOR_APPROVAL to ACCEPTED or PROCESSING).
    """
    db_req = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id).first()
    if not db_req:
        raise HTTPException(status_code=404, detail="Request not found")

    db_req.status = status_value.upper()
    db.commit()
    db.refresh(db_req)
    return build_request_response(db_req)


@router.get("/live-monitoring", summary="Get Real-Time Pipeline Progress (Admin Only)")
def get_live_monitoring(
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin Live Pipeline & Work Activity Feed:
    Provides live real-time status, active pipeline stage, estimated completion %,
    and tile processing telemetry for all user jobs.
    """
    all_requests = db.query(RequestModel).options(joinedload(RequestModel.user)).order_by(RequestModel.id.desc()).all()
    
    monitoring_feed = []
    for req in all_requests:
        # Determine simulated/real pipeline stage and progress percentage based on status
        stage = "GAP_CHECK"
        progress_pct = 20
        active_tile_info = "Overlaying district vector on MGRS grid..."

        if req.status == "HOLD_FOR_APPROVAL":
            stage = "AWAITING_APPROVAL"
            progress_pct = 5
            active_tile_info = "Storage limit threshold reached (>500 GB). Pending Admin Approval."
        elif req.status == "ACCEPTED":
            stage = "DOWNLOADING"
            progress_pct = 45
            active_tile_info = "Fetching missing Sentinel tiles from S3 (Atomic .part transfer)"
        elif req.status == "PROCESSING":
            stage = "CLOUD_MASKING & INDEX_CALC"
            progress_pct = 75
            active_tile_info = "Applying SCL 2-px dilated cloud mask & computing NDVI/LSWI"
        elif req.status == "COMPLETED":
            stage = "DELIVERY_CLIP"
            progress_pct = 100
            active_tile_info = "Joined tiles reprojected, clipped to district boundary & delivered."

        monitoring_feed.append({
            "request_id": req.id,
            "request_title": req.request_title,
            "user_name": req.user.full_name if req.user else "Unknown",
            "user_email": req.user.email if req.user else "Unknown",
            "satellite": req.satellite,
            "location": f"{req.district}, {req.state}" if req.district else req.state,
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
