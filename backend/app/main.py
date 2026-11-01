from sqlalchemy import func
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
        Base.metadata.create_all(bind=engine)
        logger.info("PostgreSQL Database tables created/verified successfully.")

        # Ensure the default admin account exists (create-only; never overwrite an existing password)
        try:
            from app.db import SessionLocal
            from app.db.models.sdap_models import UserModel
            from app.core.security import hash_password
            with SessionLocal() as db_session:
                admin_email = (settings.DEFAULT_ADMIN_EMAIL or "admin@sdap.niruthi.in").strip().lower()
                admin_pass = (settings.DEFAULT_ADMIN_PASSWORD or "").strip()
                admin_name = (settings.DEFAULT_ADMIN_NAME or "SDAP System Administrator").strip()
                admin = db_session.query(UserModel).filter(func.lower(UserModel.email) == admin_email).first()
                if admin:
                    logger.info(f"Default admin account present: {admin_email} (password left unchanged)")
                elif not admin_pass:
                    logger.warning(
                        f"Default admin account '{admin_email}' does not exist and DEFAULT_ADMIN_PASSWORD "
                        "is not set; skipping admin creation. Set DEFAULT_ADMIN_PASSWORD in backend/.env "
                        "and restart to create it."
                    )
                else:
                    db_session.add(UserModel(
                        email=admin_email,
                        full_name=admin_name,
                        hashed_password=hash_password(admin_pass),
                        role="ADMIN",
                        is_active=True
                    ))
                    db_session.commit()
                    logger.info(f"Default admin user created: {admin_email}")
        except Exception as admin_err:
            logger.warning(f"Admin seeding check deferred or failed: {admin_err}")
        
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
    allow_origins=settings.cors_origins_list,  # explicit list; never '*' with credentials (CORS_ORIGINS env)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

