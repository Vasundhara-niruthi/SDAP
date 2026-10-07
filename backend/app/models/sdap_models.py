import enum
from app.core.database import Base
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey, JSON, Enum as SQLEnum
from sqlalchemy.orm import relationship
from datetime import datetime


class UserRole(str, enum.Enum):
    """
    Role-Based Access Control (RBAC) System Roles.
    Can be expanded in the future (e.g. ANALYST, MANAGER, AUDITOR).
    """
    ADMIN = "ADMIN"
    USER = "USER"


class UserModel(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    full_name = Column(String(255), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(SQLEnum(UserRole, name="userrole"), nullable=False, default=UserRole.USER)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    requests = relationship("RequestModel", back_populates="user", cascade="all, delete-orphan")



class RequestModel(Base):
    __tablename__ = "requests"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=True) # Linked User
    request_title = Column(String(255), nullable=False)
    area_type = Column(String(50), nullable=False)  # 'Administrative Unit', 'Uploaded Boundary', 'BBox'
    state = Column(String(100), nullable=True)
    district = Column(String(100), nullable=True)
    season = Column(String(50), nullable=True)     # 'Kharif', 'Rabi', 'Zaid', 'Annual'
    start_date = Column(DateTime, nullable=False)
    end_date = Column(DateTime, nullable=False)
    satellite = Column(String(50), nullable=False) # 'Sentinel-2', 'Sentinel-1'
    bands = Column(JSON, nullable=True)             # List of requested bands
    indices = Column(JSON, nullable=True)           # List of requested indices ['NDVI', 'LSWI', 'VV/VH']
    composite_interval = Column(String(50), nullable=True, default="none") # 'none', 'weekly', 'fortnightly', 'monthly'
    max_cloud_cover = Column(Integer, nullable=True, default=20) # Allowed cloud cover 0-100%
    level = Column(String(20), nullable=True, default="max") # 'max', 'min', 'mean' calculation level for NDVI/LSWI
    status = Column(String(50), default="SUBMITTED") # 'SUBMITTED', 'ACCEPTED', 'HOLD_FOR_APPROVAL', 'REJECTED', 'PROCESSING', 'COMPLETED'
    storage_estimated_gb = Column(Float, nullable=True)
    execution_logs = Column(Text, nullable=True) # Persistent execution and download logs
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("UserModel", back_populates="requests")
    jobs = relationship("ProcessJobModel", back_populates="request", cascade="all, delete-orphan")


class SceneModel(Base):
    __tablename__ = "scene"

    scene_id = Column(String(100), primary_key=True, index=True)
    tile = Column(String(50), nullable=False, index=True)      # e.g. 44QQH
    sensing_date = Column(String(20), nullable=False, index=True) # e.g. 2025-06-15
    satellite = Column(String(50), nullable=False)            # 'Sentinel-2' or 'Sentinel-1'
    folder = Column(String(255), nullable=True)
    prefix = Column(Text, nullable=True)
    cloud_cover_percentage = Column(Float, nullable=True)
    status = Column(String(50), default="PENDING")             # 'PENDING', 'HELD', 'FAILED'
    held_at = Column(DateTime, nullable=True)
    boa_offset_applied = Column(String(20), nullable=True)
    processing_baseline = Column(String(50), nullable=True)
    archive_path = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    files = relationship("BandFileModel", back_populates="scene", cascade="all, delete-orphan")
    jobs = relationship("ProcessJobModel", back_populates="scene")


class BandFileModel(Base):
    __tablename__ = "band_file"

    id = Column(Integer, primary_key=True, autoincrement=True)
    scene_id = Column(String(100), ForeignKey("scene.scene_id", ondelete="CASCADE"), nullable=False)
    tile = Column(String(50), nullable=False)
    sensing_date = Column(String(20), nullable=False)
    satellite = Column(String(50), nullable=False)
    band = Column(String(20), nullable=False)
    path = Column(Text, nullable=False)
    size_bytes = Column(Integer, nullable=False, default=0)
    verified = Column(Integer, nullable=False, default=0)       # 1 if verified, 0 if failed
    downloaded_at = Column(DateTime, default=datetime.utcnow)

    scene = relationship("SceneModel", back_populates="files")


class ProcessJobModel(Base):
    __tablename__ = "process_jobs"

    job_id = Column(Integer, primary_key=True, autoincrement=True)
    request_id = Column(Integer, ForeignKey("requests.id", ondelete="CASCADE"), nullable=True)
    scene_id = Column(String(100), ForeignKey("scene.scene_id", ondelete="SET NULL"), nullable=True)
    stage = Column(String(50), nullable=False)  # 'GAP_CHECK', 'DOWNLOAD', 'TILE_INDEX', 'DELIVERY_CLIP'
    status = Column(String(30), default="QUEUED")# 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED'
    error_log = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    request = relationship("RequestModel", back_populates="jobs")
    scene = relationship("SceneModel", back_populates="jobs")


class DistrictTileMappingModel(Base):
    __tablename__ = "district_tiles_mapping"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    district_id = Column(Integer, nullable=False, index=True)
    district_uid = Column(String(50), nullable=True, index=True)
    district_name = Column(String(100), nullable=True, index=True)
    state_name = Column(String(100), nullable=True, index=True)
    tile_id = Column(String(50), nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class TileSceneMetadataModel(Base):
    """
    Model for tracking Sentinel-2 Open Data Registry tile hierarchy and metadata.
    Path structure: tiles/{utm_zone}/{latitude_band}/{grid_square}/{year}/{month}/{day}/{sequence}/
    Stores both raw metadata.xml (100% fidelity) and split structured JSON (fast SQL queryability).
    Tracks download status, user identity, and local storage archive path for deduplication.
    """
    __tablename__ = "tile_scene_metadata"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    utm_zone = Column(String(10), nullable=False, index=True)
    latitude_band = Column(String(5), nullable=False, index=True)
    grid_square = Column(String(10), nullable=False, index=True)
    year = Column(Integer, nullable=False, index=True)
    month = Column(Integer, nullable=False, index=True)
    day = Column(Integer, nullable=False, index=True)
    sequence = Column(Integer, nullable=False, default=0, index=True)
    tile_path = Column(String(255), unique=True, nullable=False, index=True) # e.g. "tiles/44/Q/LD/2025/1/12/0/"
    tile_id = Column(String(50), nullable=False, index=True) # e.g. "44QLD"
    sensing_date = Column(String(20), nullable=False, index=True) # e.g. "2025-01-12"
    product_name = Column(String(255), nullable=True) # e.g. "S2A_MSIL2A_20250112T051151_N0511_R019_T44QLD_20250112T094050"
    cloud_coverage_percentage = Column(Float, nullable=True)
    data_coverage_percentage = Column(Float, nullable=True)
    epsg_code = Column(String(50), nullable=True) # e.g. "EPSG:32644"
    download_status = Column(String(50), default="NOT_DOWNLOADED", index=True) # 'NOT_DOWNLOADED', 'DOWNLOADED', 'FAILED'
    downloaded_at = Column(DateTime, nullable=True)
    downloaded_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    archive_path = Column(Text, nullable=True)
    raw_metadata_xml = Column(Text, nullable=True) # Complete original XML string
    parsed_metadata = Column(JSON, nullable=True) # Split structured key fields
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    downloaded_by_user = relationship("UserModel")


class Sentinel1SceneMetadataModel(Base):
    """
    Model for tracking Sentinel-1 Open Data Registry GRD SAR products and metadata.
    Path structure: GRD/{year}/{month}/{day}/{mode}/{polarization}/{product_name}/
    Stores both raw manifest.safe XML (100% fidelity lossless archival) and split structured JSON.
    Tracks download status, user identity, and local storage archive path for deduplication.
    """
    __tablename__ = "sentinel1_scene_metadata"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    year = Column(Integer, nullable=False, index=True)
    month = Column(Integer, nullable=False, index=True)
    day = Column(Integer, nullable=False, index=True)
    mode = Column(String(20), nullable=False, index=True)            # 'IW', 'EW', 'SM'
    polarization = Column(String(20), nullable=False, index=True)    # 'DV', 'DH', 'SV', 'SH'
    product_name = Column(String(255), nullable=False, index=True)   # e.g. 'S1A_IW_GRDH_1SDV_...'
    scene_path = Column(String(255), unique=True, nullable=False, index=True) # e.g. 'GRD/2024/10/15/IW/DV/S1A_.../'
    satellite_mission = Column(String(20), nullable=True)            # 'Sentinel-1A' or 'Sentinel-1B'
    polarization_channels = Column(String(50), nullable=True)        # 'VV, VH' or 'HH, HV'
    orbit_direction = Column(String(20), nullable=True, index=True)  # 'ASCENDING' or 'DESCENDING'
    relative_orbit = Column(Integer, nullable=True, index=True)      # Track repeat cycle 1 - 175
    absolute_orbit = Column(Integer, nullable=True)
    slice_number = Column(Integer, nullable=True)
    sensing_date = Column(String(20), nullable=False, index=True)    # 'YYYY-MM-DD'
    start_time = Column(String(50), nullable=True)
    stop_time = Column(String(50), nullable=True)
    footprint_geojson = Column(JSON, nullable=True)                  # GeoJSON boundary polygon coordinates
    epsg_code = Column(String(50), nullable=True, default="EPSG:4326")
    download_status = Column(String(50), default="NOT_DOWNLOADED", index=True) # 'NOT_DOWNLOADED', 'DOWNLOADED', 'FAILED'
    downloaded_at = Column(DateTime, nullable=True)
    downloaded_by_user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    archive_path = Column(Text, nullable=True)
    raw_manifest_xml = Column(Text, nullable=True)                   # Complete original manifest.safe XML string
    parsed_metadata = Column(JSON, nullable=True)                    # Split structured key fields
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    downloaded_by_user = relationship("UserModel")


