"""
=============================================================================
SDAP Sentinel Metadata Repository (Reusable Database Queries)
=============================================================================
Location: backend/app/db/repositories/sentinel_repo.py

Description:
    Reusable database queries for Sentinel-1 and Sentinel-2 scene metadata,
    tile coverage, and district-to-tile spatial mappings.
=============================================================================
"""

from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.db.models.sdap_models import (
    TileSceneMetadataModel,
    Sentinel1SceneMetadataModel,
    DistrictTileMappingModel,
    BandFileModel
)


class SentinelRepository:
    """Repository encapsulating queries for Sentinel data and metadata tables."""

    @staticmethod
    def get_s2_tiles_for_district(db: Session, district_name: str) -> List[str]:
        """Fetch all unique tile IDs covering a given district."""
        mappings = db.query(DistrictTileMappingModel.tile_id).filter(
            DistrictTileMappingModel.district_name.ilike(district_name)
        ).distinct().all()
        return [m[0] for m in mappings]

    @staticmethod
    def get_s2_metadata(
        db: Session,
        tile_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> List[TileSceneMetadataModel]:
        """Fetch Sentinel-2 metadata records for a tile within a date range."""
        query = db.query(TileSceneMetadataModel).filter(TileSceneMetadataModel.tile_id == tile_id)
        if start_date:
            query = query.filter(TileSceneMetadataModel.sensing_date >= start_date)
        if end_date:
            query = query.filter(TileSceneMetadataModel.sensing_date <= end_date)
        return query.order_by(desc(TileSceneMetadataModel.sensing_date)).all()

    @staticmethod
    def get_s1_metadata(
        db: Session,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        mode: Optional[str] = None
    ) -> List[Sentinel1SceneMetadataModel]:
        """Fetch Sentinel-1 SAR metadata records."""
        query = db.query(Sentinel1SceneMetadataModel)
        if start_date:
            query = query.filter(Sentinel1SceneMetadataModel.sensing_date >= start_date)
        if end_date:
            query = query.filter(Sentinel1SceneMetadataModel.sensing_date <= end_date)
        if mode:
            query = query.filter(Sentinel1SceneMetadataModel.mode == mode)
        return query.order_by(desc(Sentinel1SceneMetadataModel.sensing_date)).all()

    @staticmethod
    def get_downloaded_bands_for_tile(
        db: Session,
        tile: str,
        sensing_date: str,
        satellite: str = "Sentinel-2"
    ) -> List[BandFileModel]:
        """Fetch all downloaded band file records for a tile and sensing date."""
        return db.query(BandFileModel).filter(
            BandFileModel.tile == tile,
            BandFileModel.sensing_date == sensing_date,
            BandFileModel.satellite == satellite
        ).all()

