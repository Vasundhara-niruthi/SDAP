"""
=============================================================================
SDAP Legacy API Router (Backward Compatibility Shim)
=============================================================================
Location: backend/app/api/v1/api.py

Description:
    Re-exports api_router from app.routes.api to ensure full compatibility
    with legacy references.
=============================================================================
"""

from app.routes.api import api_router

__all__ = ["api_router"]
