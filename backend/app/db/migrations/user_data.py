"""
=============================================================================
SDAP Database User Data Migration & Seeding Module
=============================================================================
Location: app/db/migrations/user_data.py

Description:
    Structured database migration and seeding manager for user accounts,
    RBAC privileges, user work tracking, and activity summaries in SDAP.

Key Capabilities:
    1. Seed System Administrator (admin@sdap.niruthi.in)
    2. Seed Standard Analyst User (user@sdap.niruthi.in)
    3. Audit User Directory & Work Summary
    4. Provide Structured Work Breakdown for Admin Telemetry
=============================================================================
"""

import logging
from typing import Dict, List, Any, Optional
from sqlalchemy.orm import Session

from app.models.sdap_models import UserModel, RequestModel, ProcessJobModel
from app.core.security import hash_password

# Configure Structured Logger
logger = logging.getLogger("sdap.migrations.user_data")


class UserDataMigration:
    """
    Structured Manager for User Accounts, RBAC Roles, and Work Breakdown.
    """

    def __init__(self, db: Session):
        self.db = db

    def seed_administrator(
        self,
        email: str = "admin@sdap.niruthi.in",
        full_name: str = "SDAP System Administrator",
        password: str = "Admin@123456"
    ) -> UserModel:
        """
        Ensures the primary System Administrator account exists in PostgreSQL.

        Args:
            email (str): Admin email address.
            full_name (str): Admin display name.
            password (str): Admin initial password.

        Returns:
            UserModel: The seeded or existing Admin user instance.
        """
        logger.info(f"Checking System Administrator account ({email})...")
        admin = self.db.query(UserModel).filter(UserModel.email == email).first()

        if not admin:
            admin = UserModel(
                email=email,
                full_name=full_name,
                hashed_password=hash_password(password),
                role="ADMIN",
                is_active=True
            )
            self.db.add(admin)
            self.db.commit()
            self.db.refresh(admin)
            logger.info(f"[SUCCESS] Seeded System Administrator account: {email}")
        else:
            logger.info(f"[EXISTS] System Administrator account verified: {email}")

        return admin

    def seed_standard_user(
        self,
        email: str = "user@sdap.niruthi.in",
        full_name: str = "Remote Sensing Analyst",
        password: str = "User@123456"
    ) -> UserModel:
        """
        Ensures a baseline standard USER account exists in PostgreSQL.

        Args:
            email (str): Analyst email address.
            full_name (str): Analyst display name.
            password (str): Analyst initial password.

        Returns:
            UserModel: The seeded or existing standard user instance.
        """
        logger.info(f"Checking standard Analyst user account ({email})...")
        user = self.db.query(UserModel).filter(UserModel.email == email).first()

        if not user:
            user = UserModel(
                email=email,
                full_name=full_name,
                hashed_password=hash_password(password),
                role="USER",
                is_active=True
            )
            self.db.add(user)
            self.db.commit()
            self.db.refresh(user)
            logger.info(f"[SUCCESS] Seeded standard Analyst account: {email}")
        else:
            logger.info(f"[EXISTS] Standard Analyst account verified: {email}")

        return user

    def get_user_work_breakdown(self) -> List[Dict[str, Any]]:
        """
        Generates a structured work breakdown for all registered users.
        Includes request counts, status counts, and satellite acquisition details.

        Returns:
            List[Dict[str, Any]]: Array of user profiles with attached work history.
        """
        users = self.db.query(UserModel).order_by(UserModel.id.asc()).all()
        work_breakdown = []

        for user in users:
            user_requests = self.db.query(RequestModel).filter(RequestModel.user_id == user.id).all()
            
            # Status count aggregation
            status_summary = {
                "SUBMITTED": 0,
                "ACCEPTED": 0,
                "PROCESSING": 0,
                "COMPLETED": 0,
                "FAILED": 0
            }
            for req in user_requests:
                status_summary[req.status] = status_summary.get(req.status, 0) + 1

            work_breakdown.append({
                "user_id": user.id,
                "email": user.email,
                "full_name": user.full_name,
                "role": user.role,
                "is_active": user.is_active,
                "created_at": user.created_at.isoformat() if user.created_at else None,
                "total_requests": len(user_requests),
                "status_summary": status_summary,
                "requests": [
                    {
                        "request_id": r.id,
                        "title": r.request_title,
                        "district": r.district,
                        "state": r.state,
                        "satellite": r.satellite,
                        "status": r.status,
                        "created_at": r.created_at.isoformat() if r.created_at else None
                    }
                    for r in user_requests
                ]
            })

        return work_breakdown

    def audit_user_directory(self) -> Dict[str, Any]:
        """
        Audits user directory statistics across ADMIN and USER roles.

        Returns:
            Dict[str, Any]: Summary dictionary containing account metrics.
        """
        total_users = self.db.query(UserModel).count()
        admin_count = self.db.query(UserModel).filter(UserModel.role == "ADMIN").count()
        user_count = self.db.query(UserModel).filter(UserModel.role == "USER").count()
        active_count = self.db.query(UserModel).filter(UserModel.is_active == True).count()

        return {
            "total_users": total_users,
            "administrators": admin_count,
            "analysts": user_count,
            "active_accounts": active_count,
            "inactive_accounts": total_users - active_count
        }


def run_user_data_migrations(db: Session) -> Dict[str, Any]:
    """
    Main entry point for executing user data seeding and migration operations.

    Args:
        db (Session): Active SQLAlchemy database session.

    Returns:
        Dict[str, Any]: Audit results after completing migrations.
    """
    logger.info("==========================================================")
    logger.info("Executing SDAP User Data Migrations & Account Seeding...")
    logger.info("==========================================================")

    migration = UserDataMigration(db)

    # 1. Seed System Administrator
    migration.seed_administrator()

    # 2. Seed Standard Analyst User
    migration.seed_standard_user()

    # 3. Perform Directory Audit
    audit_results = migration.audit_user_directory()
    logger.info(f"User Migration Complete: {audit_results}")

    return audit_results

