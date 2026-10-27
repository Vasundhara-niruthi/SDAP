"""
=============================================================================
SDAP Database Models Package
=============================================================================
Location: backend/app/db/models/__init__.py

Description:
    Exposes all ORM entity models, enums, PostGIS geometry models, and
    compatibility aliases.
=============================================================================
"""

from app.db.models.sdap_models import (
    UserModel,
    UserRole,
    RequestModel,
    SceneModel,
    BandFileModel,
    ProcessJobModel,
    DistrictTileMappingModel,
    TileSceneMetadataModel,
    Sentinel1SceneMetadataModel,
    LayerStackJobModel,
)
from app.db.models.boundaries import (
    StateBoundaryModel,
    DistrictBoundaryModel,
)

# Alias for backwards compatibility
SceneFileModel = BandFileModel

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

