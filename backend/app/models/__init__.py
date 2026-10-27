"""
=============================================================================
SDAP Models Package (Backward Compatibility Shim)
=============================================================================
Location: backend/app/models/__init__.py

Description:
    Re-exports all models from app.db.models to preserve full compatibility
    with existing codebase imports.
=============================================================================
"""

from app.db.models import (
    UserModel,
    UserRole,
    RequestModel,
    SceneModel,
    BandFileModel,
    SceneFileModel,
    ProcessJobModel,
    DistrictTileMappingModel,
    TileSceneMetadataModel,
    Sentinel1SceneMetadataModel,
    LayerStackJobModel,
    StateBoundaryModel,
    DistrictBoundaryModel,
)

__all__ = [
    "UserModel",
    "UserRole",
    "RequestModel",
    "SceneModel",
    "BandFileModel",
    "SceneFileModel",
    "ProcessJobModel",
    "DistrictTileMappingModel",
    "TileSceneMetadataModel",
    "Sentinel1SceneMetadataModel",
    "LayerStackJobModel",
    "StateBoundaryModel",
    "DistrictBoundaryModel",
]
