"""
=============================================================================
SDAP FastAPI Database Session Dependencies
=============================================================================
Location: backend/app/db/dependencies.py

Description:
    Provides the get_db() FastAPI dependency yielding request-scoped
    database sessions with guaranteed cleanup.
=============================================================================
"""

from typing import Generator
from sqlalchemy.orm import Session
from app.db.connection import SessionLocal


def get_db() -> Generator[Session, None, None]:
    """
    FastAPI dependency yielding a clean database session per HTTP request,
    guaranteeing session closure in the finally block.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

