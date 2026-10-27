"""
=============================================================================
SDAP Authentication & User Access API Routes
=============================================================================
Location: backend/app/routes/auth.py

Description:
    Exposes endpoints for user registration, OAuth2 password login,
    JSON payload login, profile querying, and self-service password reset.
=============================================================================
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token, get_current_user
from app.models.sdap_models import UserModel
from app.schemas.user_schema import TokenResponse, UserResponse, UserCreate, LoginRequest, PasswordResetRequest

router = APIRouter()


@router.post("/register", response_model=TokenResponse, status_code=status.HTTP_201_CREATED, summary="Public User Self-Registration (Create Account)")
def register_user(
    user_in: UserCreate,
    db: Session = Depends(get_db)
):
    """
    Public self-registration endpoint.
    Allows new users to create their own standard 'USER' account and returns a JWT access token immediately.
    """
    clean_email = user_in.email.strip().lower() if user_in.email else ""
    existing = db.query(UserModel).filter(func.lower(UserModel.email) == clean_email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"An account with email '{clean_email}' already exists. Please sign in instead."
        )

    # Force self-registered users to have standard 'USER' role for security
    db_user = UserModel(
        email=clean_email,
        full_name=user_in.full_name.strip() if user_in.full_name else "",
        hashed_password=hash_password(user_in.password.strip()),
        role="USER",
        is_active=True
    )
    db.add(db_user)
    db.commit()
    db.refresh(db_user)

    # Auto-generate JWT token for instant login upon registration
    access_token = create_access_token(data={"sub": db_user.email, "role": db_user.role})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": db_user
    }


@router.post("/login", response_model=TokenResponse, summary="OAuth2 Form Login")
def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db)
):
    """
    OAuth2 compatible login endpoint. Accepts username (email) and password.
    Returns JWT access_token and User Details.
    """
    clean_email = form_data.username.strip().lower() if form_data.username else ""
    user = db.query(UserModel).filter(func.lower(UserModel.email) == clean_email).first()
    if not user or not verify_password(form_data.password.strip(), user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not user.is_active:
        raise HTTPException(status_code=400, detail="User account is deactivated")

    access_token = create_access_token(data={"sub": user.email, "role": user.role})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user
    }


@router.post("/login/json", response_model=TokenResponse, summary="JSON Body Login")
def login_json(
    body: LoginRequest,
    db: Session = Depends(get_db)
):
    """
    JSON payload login endpoint for client applications.
    """
    clean_email = body.email.strip().lower() if body.email else ""
    user = db.query(UserModel).filter(func.lower(UserModel.email) == clean_email).first()
    if not user or not verify_password(body.password.strip(), user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
        )
    if not user.is_active:
        raise HTTPException(status_code=400, detail="User account is deactivated")

    access_token = create_access_token(data={"sub": user.email, "role": user.role})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user
    }


@router.get("/me", response_model=UserResponse, summary="Get Current Logged-in User Profile")
def get_me(current_user: UserModel = Depends(get_current_user)):
    """
    Return current user details.
    """
    return current_user


@router.post("/reset-password", summary="Reset User Account Password")
def reset_password(
    body: PasswordResetRequest,
    db: Session = Depends(get_db)
):
    """
    Password reset endpoint allowing users to securely update their account password.
    """
    if body.new_password != body.confirm_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="New password and confirm password do not match."
        )

    clean_email = body.email.strip().lower() if body.email else ""
    user = db.query(UserModel).filter(func.lower(UserModel.email) == clean_email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"No account found with email '{clean_email}'."
        )

    user.hashed_password = hash_password(body.new_password.strip())
    db.commit()

    return {"message": f"Password for account '{user.email}' updated successfully. Please sign in with your new password."}

