"""
=============================================================================
SDAP Database Engine & Connection Pooling
=============================================================================
Location: backend/app/db/connection.py

Description:
    Configures PostgreSQL connection parameters, pooling, synchronous engine,
    SQLAlchemy session factory, and database diagnostic health checks.
=============================================================================
"""

import logging
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.core.config import settings

logger = logging.getLogger("sdap.db.connection")

# Synchronous PostgreSQL Engine with connection pooling
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20
)

# Thread-local / request session maker
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    """Base declarative class for all SQLAlchemy ORM models."""
    pass


def check_database_connection() -> dict:
    """
    Test PostgreSQL database connectivity and report database server version.
    """
    try:
        with engine.connect() as connection:
            result = connection.execute(text("SELECT version();"))
            version = result.scalar()
            return {
                "status": "connected",
                "database": settings.POSTGRES_DB,
                "server_version": version
            }
    except Exception as e:
        logger.error(f"Database connection error: {str(e)}")
        return {
            "status": "disconnected",
            "error": str(e)
        }

