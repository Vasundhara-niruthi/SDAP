"""SDAP Routes Package

Exposes modular route definitions and the primary api_router.
"""

from app.routes.api import api_router
from app.routes import auth, boundaries, health, requests, users, rasters, layer_stack

__all__ = [
    "api_router",
    "auth",
    "boundaries",
    "health",
    "requests",
    "users",
    "rasters",
    "layer_stack",
]

