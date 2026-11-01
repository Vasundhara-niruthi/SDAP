"""SDAP Health Check API Route

Exposes system and database health diagnostics for uptime monitors.
"""

from fastapi import APIRouter
from app.core.config import settings
from app.db import check_database_connection
from app.schemas.health_schema import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, summary="System & Database Health Check")
def get_health():
    """
    Check server status and test PostgreSQL database connection.
    """
    db_status = check_database_connection()
    connected = db_status.get("status") == "connected"
    # Public endpoint: expose only connectivity state, never server version or raw error text
    # (details are already logged server-side by check_database_connection).
    return {
        "status": "healthy" if connected else "degraded",
        "project_name": settings.PROJECT_NAME,
        "api_version": settings.API_V1_STR,
        "database": {"status": "connected" if connected else "disconnected"}
    }

