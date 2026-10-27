"""
=============================================================================
SDAP User Repository (Reusable Database Queries)
=============================================================================
Location: backend/app/db/repositories/user_repo.py

Description:
    Reusable database queries for user accounts, credentials, and RBAC roles.
=============================================================================
"""

from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.db.models.sdap_models import UserModel


class UserRepository:
    """Repository encapsulating queries for the 'users' table."""

    @staticmethod
    def get_by_id(db: Session, user_id: int) -> Optional[UserModel]:
        """Fetch user by primary key ID."""
        return db.query(UserModel).filter(UserModel.id == user_id).first()

    @staticmethod
    def get_by_email(db: Session, email: str) -> Optional[UserModel]:
        """Fetch user by unique email address."""
        return db.query(UserModel).filter(UserModel.email == email).first()

    @staticmethod
    def list_users(db: Session, skip: int = 0, limit: int = 100) -> List[UserModel]:
        """Fetch a paginated list of registered users."""
        return db.query(UserModel).order_by(desc(UserModel.created_at)).offset(skip).limit(limit).all()

    @staticmethod
    def count_users(db: Session) -> int:
        """Count total registered users."""
        return db.query(UserModel).count()

