"""
=============================================================================
SDAP Models Module (Backward Compatibility Shim)
=============================================================================
Location: backend/app/models/sdap_models.py

Description:
    Re-exports models from app.db.models.sdap_models to preserve full
    compatibility with legacy imports.
=============================================================================
"""

from app.db.models.sdap_models import (
    UserRole,
    UserModel,
    RequestModel,
    SceneModel,
    BandFileModel,
    ProcessJobModel,
    DistrictTileMappingModel,
    TileSceneMetadataModel,
    Sentinel1SceneMetadataModel,
    LayerStackJobModel,
)

__all__ = [
    "UserRole",
    "UserModel",
    "RequestModel",
    "SceneModel",
    "BandFileModel",
    "ProcessJobModel",
    "DistrictTileMappingModel",
    "TileSceneMetadataModel",
    "Sentinel1SceneMetadataModel",
    "LayerStackJobModel",
]
