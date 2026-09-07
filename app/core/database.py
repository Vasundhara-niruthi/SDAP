from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from app.core.config import settings
import logging

logger = logging.getLogger("sdap.database")

# Synchronous Engine (for Alembic / standard queries / GeoAlchemy)
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    """Dependency that yields a database session per request."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_database_connection() -> dict:
    """Utility function to test database connectivity."""
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

