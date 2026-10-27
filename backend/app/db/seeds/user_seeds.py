"""
=============================================================================
SDAP User & Role Seeding Module
=============================================================================
Location: backend/app/db/seeds/user_seeds.py

Description:
    Seeds default administrative and user accounts, provisions roles, and
    performs user directory audits.
=============================================================================
"""

import logging
import os
from collections import defaultdict
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.db.models.sdap_models import UserModel, RequestModel
from app.core.security import hash_password

logger = logging.getLogger("sdap.db.seeds.user_seeds")

# Admin fallback default (development only). Override via DEFAULT_ADMIN_PASSWORD in .env.
_DEFAULT_ADMIN_PASSWORD = "admin123"


class UserDataMigration:
    """Structured Manager for User Accounts, RBAC Roles, and Work Breakdown."""

    def __init__(self, db: Session):
        self.db = db

    def _seed_user(self, email: str, full_name: str, password: str,
                   role: str, label: str) -> UserModel:
        """Create the user if the email does not exist yet; otherwise return it."""
        logger.info(f"Checking {label} account ({email})...")
        user = self.db.query(UserModel).filter(UserModel.email == email).first()

        if not user:
            try:
                user = UserModel(
                    email=email,
                    full_name=full_name,
                    hashed_password=hash_password(password),
                    role=role,
                    is_active=True,
                )
                self.db.add(user)
                self.db.commit()
                self.db.refresh(user)
            except Exception:
                self.db.rollback()
                logger.exception(f"[FAILED] Could not seed {label} account: {email}")
                raise
            logger.info(f"[SUCCESS] Seeded {label} account: {email}")
        else:
            logger.info(f"[EXISTS] {label} account verified: {email}")

        return user

    def seed_administrator(
        self,
        email: Optional[str] = None,
        full_name: Optional[str] = None,
        password: Optional[str] = None,
    ) -> UserModel:
        """Ensures the primary System Administrator account exists."""
        email = email or os.getenv("DEFAULT_ADMIN_EMAIL", "admin@sdap.niruthi.in")
        full_name = full_name or os.getenv("DEFAULT_ADMIN_NAME", "SDAP System Administrator")
        password = password or os.getenv("DEFAULT_ADMIN_PASSWORD", _DEFAULT_ADMIN_PASSWORD)

        if password == _DEFAULT_ADMIN_PASSWORD:
            logger.warning("Using built-in default admin password. "
                           "Set DEFAULT_ADMIN_PASSWORD before deploying to production.")

        return self._seed_user(email, full_name, password, "ADMIN", "System Administrator")

    def seed_standard_user(
        self,
        email: Optional[str] = None,
        full_name: Optional[str] = None,
        password: Optional[str] = None,
    ) -> Optional[UserModel]:
        """Ensures a baseline standard USER account exists if credentials are provided in .env."""
        email = email or os.getenv("DEFAULT_USER_EMAIL")
        full_name = full_name or os.getenv("DEFAULT_USER_NAME", "Remote Sensing Analyst")
        password = password or os.getenv("DEFAULT_USER_PASSWORD")

        if not email or not password:
            logger.info("Skipping standard user seeding (DEFAULT_USER_EMAIL/DEFAULT_USER_PASSWORD not set in .env).")
            return None

        return self._seed_user(email, full_name, password, "USER", "standard Analyst")

    def get_user_work_breakdown(self) -> List[Dict[str, Any]]:
        """Structured work breakdown for all registered users."""
        users = self.db.query(UserModel).order_by(UserModel.id.asc()).all()

        requests_by_user: Dict[int, List[RequestModel]] = defaultdict(list)
        for req in self.db.query(RequestModel).order_by(RequestModel.id.asc()).all():
            requests_by_user[req.user_id].append(req)

        work_breakdown: List[Dict[str, Any]] = []

        for user in users:
            user_requests = requests_by_user.get(user.id, [])

            status_summary = {
                "SUBMITTED": 0,
                "ACCEPTED": 0,
                "PROCESSING": 0,
                "COMPLETED": 0,
                "FAILED": 0,
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
                        "created_at": r.created_at.isoformat() if r.created_at else None,
                    }
                    for r in user_requests
                ],
            })

        return work_breakdown

    def audit_user_directory(self) -> Dict[str, Any]:
        """Audits user directory statistics across ADMIN and USER roles."""
        total_users = self.db.query(UserModel).count()
        admin_count = self.db.query(UserModel).filter(UserModel.role == "ADMIN").count()
        user_count = self.db.query(UserModel).filter(UserModel.role == "USER").count()
        active_count = self.db.query(UserModel).filter(UserModel.is_active.is_(True)).count()

        return {
            "total_users": total_users,
            "administrators": admin_count,
            "analysts": user_count,
            "active_accounts": active_count,
            "inactive_accounts": total_users - active_count,
        }


def run_user_data_migrations(db: Session) -> Dict[str, Any]:
    """Main entry point for user data seeding and migration operations."""
    logger.info("==========================================================")
    logger.info("Executing SDAP User Data Migrations & Account Seeding...")
    logger.info("==========================================================")

    migration = UserDataMigration(db)
    migration.seed_administrator()
    migration.seed_standard_user()

    audit_results = migration.audit_user_directory()
    logger.info(f"User Migration Complete: {audit_results}")

    return audit_results


seed_users = run_user_data_migrations

