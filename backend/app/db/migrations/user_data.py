"""
=============================================================================
SDAP Database User Data Migration (Backward Compatibility Shim)
=============================================================================
Location: backend/app/db/migrations/user_data.py

Description:
    Re-exports UserDataMigration, run_user_data_migrations, and seed_users from
    app.db.seeds.user_seeds to preserve full backward compatibility.
=============================================================================
"""

from app.db.seeds.user_seeds import (
    UserDataMigration,
    run_user_data_migrations,
    seed_users
)

__all__ = [
    "UserDataMigration",
    "run_user_data_migrations",
    "seed_users"
]
