from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import func
from typing import List

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
    users_with_counts = db.query(
        UserModel,
        func.count(RequestModel.id).label("request_count")
    ).outerjoin(
        RequestModel, UserModel.id == RequestModel.user_id
    ).group_by(
        UserModel.id
    ).order_by(
        UserModel.id.asc()
    ).offset(skip).limit(limit).all()

    response = []
    for user, count in users_with_counts:
        response.append(UserResponse(
            id=user.id,
            email=user.email,
            full_name=user.full_name,
            role=user.role,
            is_active=user.is_active,
            created_at=user.created_at,
            request_count=count
        ))
    return response


@router.get("/{user_id}/requests", response_model=List[RequestResponse], summary="Get Specific User's Requests (Admin Only)")
def get_user_requests(
    user_id: int,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to retrieve all satellite acquisition requests and logs for a specific user.
    """
    target_user = db.query(UserModel).filter(UserModel.id == user_id).first()
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")

    user_requests = db.query(RequestModel).options(
        joinedload(RequestModel.user)
    ).filter(
        RequestModel.user_id == user_id
    ).order_by(
        RequestModel.id.desc()
    ).all()

    from app.api.v1.endpoints.requests import build_request_response
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

    # Cascade delete associated user requests
    db.query(RequestModel).filter(RequestModel.user_id == user_id).delete()
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

