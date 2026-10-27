"""
=============================================================================
SDAP PostGIS Administrative Boundary Models
=============================================================================
Location: backend/app/db/models/boundaries.py

Description:
    SQLAlchemy ORM models for PostGIS administrative boundaries:
    - StateBoundaryModel ('state_boundaries')
    - DistrictBoundaryModel ('district_boundaries')
=============================================================================
"""

from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime
from geoalchemy2 import Geometry

from app.db.connection import Base


class StateBoundaryModel(Base):
    """
    State / Union Territory administrative boundary table with PostGIS geometry.
    """
    __tablename__ = "state_boundaries"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    state_name = Column(String(100), nullable=False, unique=True, index=True)
    district_count = Column(Integer, nullable=True, default=0)
    geometry = Column(Geometry(geometry_type="GEOMETRY", srid=4326), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class DistrictBoundaryModel(Base):
    """
    District administrative boundary table with PostGIS geometry and spatial indexes.
    """
    __tablename__ = "district_boundaries"

    id = Column(Integer, primary_key=True, autoincrement=True, index=True)
    district_uid = Column(String(50), nullable=True, index=True)
    district_name = Column(String(100), nullable=False, index=True)
    state_name = Column(String(100), nullable=False, index=True)
    geometry = Column(Geometry(geometry_type="GEOMETRY", srid=4326), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

