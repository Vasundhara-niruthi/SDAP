from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import logging

from app.core.config import settings
from app.db import engine, Base
from app.routes import api_router
from app.db.models import RequestModel, SceneModel, SceneFileModel, ProcessJobModel # ensure models are registered

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("sdap.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application Lifespan Context Manager.
    Handles startup table creation & database connectivity check.
    """
    logger.info("Initializing SDAP Server tables in PostgreSQL...")
    try:
        # Create tables if they do not exist
        Base.metadata.create_all(bind=engine)
        logger.info("PostgreSQL Database tables created/verified successfully.")
    except Exception as e:
        logger.warning(f"Database table initialization deferred or failed: {e}")

    yield

    logger.info("SDAP Server shutting down...")


app = FastAPI(
    title=settings.PROJECT_NAME,
    version="1.0.0",
    description="SDAP (Satellite Data Acquisition & Processing Platform) Backend API Server",
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan
)

# CORS Configuration for React Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include API v1 Router
app.include_router(api_router, prefix=settings.API_V1_STR)


@app.get("/", summary="Root Endpoint")
def root():
    return {
        "message": "Welcome to SDAP API Server",
        "docs": "/docs",
        "api_v1": f"{settings.API_V1_STR}"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)

