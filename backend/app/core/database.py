"""
=============================================================================
SDAP Core Database Layer (Backward Compatibility Shim)
=============================================================================
Location: backend/app/core/database.py

Description:
    Re-exports engine, SessionLocal, Base, get_db, and check_database_connection
    from the modularized app.db package for legacy import compatibility.
=============================================================================
"""

from app.db.connection import engine, SessionLocal, Base, check_database_connection
from app.db.dependencies import get_db

__all__ = [
    "engine",
    "SessionLocal",
    "Base",
    "check_database_connection",
    "get_db",
]
