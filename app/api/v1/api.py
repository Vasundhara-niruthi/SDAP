from fastapi import APIRouter
from app.api.v1.endpoints import health, requests
from app.api.v1.endpoints import health, auth, users, requests

api_router = APIRouter()

api_router.include_router(health.router, tags=["Health"])
api_router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
api_router.include_router(users.router, prefix="/users", tags=["User Management (Admin Only)"])
api_router.include_router(requests.router, prefix="/requests", tags=["Requests (M1)"])

