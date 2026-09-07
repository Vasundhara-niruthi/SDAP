from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from typing import List

from app.core.database import get_db
from app.core.security import get_current_admin, hash_password
from app.models.sdap_models import UserModel, RequestModel
from app.schemas.user_schema import UserCreate, UserResponse

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
    return db_user


@router.get("/", response_model=List[UserResponse], summary="List All Users (Admin Only)")
def list_users(
    skip: int = 0,
    limit: int = 100,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to list all users and view their roles & statuses.
    """
    return db.query(UserModel).offset(skip).limit(limit).all()


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
