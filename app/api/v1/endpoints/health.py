from fastapi import APIRouter
from app.core.config import settings
from app.core.database import check_database_connection
from app.schemas.health_schema import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse, summary="System & Database Health Check")
def get_health():
    """
    Check server status and test PostgreSQL database connection.
    """
    db_status = check_database_connection()
    return {
        "status": "healthy" if db_status.get("status") == "connected" else "degraded",
        "project_name": settings.PROJECT_NAME,
        "api_version": settings.API_V1_STR,
        "database": db_status
    }

