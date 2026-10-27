"""
=============================================================================
SDAP Main API Router Aggregator
=============================================================================
Location: backend/app/routes/api.py

Description:
    Aggregates modular route handlers for Health, Authentication, User Management,
    Satellite Acquisition Requests, Boundaries, Rasters, and Layer Stacking into
    a single FastAPI APIRouter.
=============================================================================
"""

from fastapi import APIRouter
from app.routes import auth, boundaries, health, requests, users

api_router = APIRouter()

# Register core application routers with standard prefixes and tags
api_router.include_router(health.router, tags=["Health"])
api_router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
api_router.include_router(users.router, prefix="/users", tags=["User Management (Admin Only)"])
api_router.include_router(requests.router, prefix="/requests", tags=["Requests (M1)"])
api_router.include_router(boundaries.router, prefix="/boundaries", tags=["Administrative Boundaries"])

