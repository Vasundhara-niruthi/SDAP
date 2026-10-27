"""
=============================================================================
SDAP Database Package
=============================================================================
Location: backend/app/db/__init__.py

Description:
    Primary access point for database engine, connections, session dependencies,
    ORM models, query repositories, seeds, and operational scripts.
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
