"""
=============================================================================
SDAP User Management API Routes
=============================================================================
Location: backend/app/routes/users.py

Description:
    Admin-only user CRUD, role assignments, user request listings,
    work telemetry breakdown, and storage analytics.
=============================================================================
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from typing import List, Optional

from app.core.database import get_db
from app.core.security import get_current_admin, hash_password
from app.models.sdap_models import UserModel, RequestModel
from app.schemas.user_schema import UserCreate, UserResponse
from app.schemas.request_schema import RequestResponse

router = APIRouter()


@router.post("/", response_model=UserResponse, status_code=status.HTTP_201_CREATED, summary="Create New User (Admin Only)")
def create_user(
    user_in: UserCreate,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to create new user accounts and assign roles (ADMIN / USER).
    """
    existing = db.query(UserModel).filter(UserModel.email == user_in.email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"User with email '{user_in.email}' already exists"
        )

    db_user = UserModel(
        email=user_in.email,
        full_name=user_in.full_name,
        hashed_password=hash_password(user_in.password),
        role=user_in.role.upper() if user_in.role else "USER",
        is_active=True
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)
    return UserResponse(
        id=db_user.id,
        email=db_user.email,
        full_name=db_user.full_name,
        role=db_user.role,
        is_active=db_user.is_active,
        created_at=db_user.created_at,
        request_count=0
    )


@router.get("/", response_model=List[UserResponse], summary="List All Users (Admin Only)")
def list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to list all users, roles, statuses, and total request counts.
    """
    users = db.query(UserModel).order_by(UserModel.id.asc()).offset(skip).limit(limit).all()

    request_counts = dict(
        db.query(RequestModel.user_id, func.count(RequestModel.id))
        .group_by(RequestModel.user_id)
        .all()
    )

    return [
        UserResponse(
            id=u.id,
            email=u.email,
            full_name=u.full_name,
            role=u.role,
            is_active=u.is_active,
            created_at=u.created_at,
            request_count=request_counts.get(u.id, 0)
        )
        for u in users
    ]


@router.patch("/{user_id}/role", response_model=UserResponse, summary="Update User Role (Admin Only)")
def update_user_role(
    user_id: int,
    role: str,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to promote/demote user roles between ADMIN and USER.
    """
    role_upper = role.upper().strip()
    if role_upper not in ["ADMIN", "USER"]:
        raise HTTPException(status_code=400, detail="Invalid role. Must be 'ADMIN' or 'USER'.")

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User account not found")

    user.role = role_upper
    db.commit()
    db.refresh(user)

    cnt = db.query(RequestModel).filter(RequestModel.user_id == user.id).count()
    return UserResponse(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
        request_count=cnt
    )


@router.get("/{user_id}/requests", response_model=List[RequestResponse], summary="List Requests of Specific User (Admin Only)")
def get_user_requests(
    user_id: int,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to inspect all satellite acquisition requests submitted by a specific user.
    """
    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User account not found")

    user_requests = db.query(RequestModel).options(
        joinedload(RequestModel.user)
    ).filter(
        RequestModel.user_id == user_id
    ).order_by(
        RequestModel.id.desc()
    ).all()

    from app.routes.requests import build_request_response
    return [build_request_response(r) for r in user_requests]


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete User Account (Admin Only)")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to delete user accounts and clear associated work.
    Prevents admin self-deletion.
    """
    if user_id == admin.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Administrators cannot delete their own active account."
        )

    user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User account not found")

    from app.models.sdap_models import ProcessJobModel, TileSceneMetadataModel, Sentinel1SceneMetadataModel
    # Cascade clean up associated process jobs and user requests
    user_reqs = db.query(RequestModel.id).filter(RequestModel.user_id == user_id).all()
    req_ids = [r[0] for r in user_reqs]
    if req_ids:
        db.query(ProcessJobModel).filter(ProcessJobModel.request_id.in_(req_ids)).delete(synchronize_session=False)
        db.query(RequestModel).filter(RequestModel.id.in_(req_ids)).delete(synchronize_session=False)

    # Detach granules or scenes downloaded by this user
    try:
        db.query(TileSceneMetadataModel).filter(TileSceneMetadataModel.downloaded_by_user_id == user_id).update({"downloaded_by_user_id": None}, synchronize_session=False)
        db.query(Sentinel1SceneMetadataModel).filter(Sentinel1SceneMetadataModel.downloaded_by_user_id == user_id).update({"downloaded_by_user_id": None}, synchronize_session=False)
    except Exception:
        pass

    db.delete(user)
    db.commit()
    return None


@router.get("/work-breakdown", summary="Get Structured User Work Breakdown (Admin Only)")
def get_work_breakdown(
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to retrieve structured work telemetry and satellite request metrics per user.
    """
    from app.db.migrations.user_data import UserDataMigration
    migration_mgr = UserDataMigration(db)
    return {
        "audit": migration_mgr.audit_user_directory(),
        "work_breakdown": migration_mgr.get_user_work_breakdown()
    }


@router.get("/analytics/daily-storage", summary="Get Daily Request & Physical Storage Analytics (Admin Only)")
def get_daily_storage_analytics_endpoint(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to retrieve daily request and physical storage occupancy metrics,
    cumulative totals, and request breakdown over time.
    """
    from app.services.analytics_service import get_daily_storage_analytics
    return get_daily_storage_analytics(db=db, start_date=start_date, end_date=end_date)

