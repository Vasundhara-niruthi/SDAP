from app.core.database import Base
from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Text, ForeignKey, JSON
from sqlalchemy.orm import relationship
from datetime import datetime


class UserModel(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    full_name = Column(String(255), nullable=False)
    hashed_password = Column(String(255), nullable=False)
    role = Column(String(20), nullable=False, default="USER") # 'ADMIN' or 'USER'
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
    priority = Column(String(20), default="normal") # 'high', 'normal', 'low'
    status = Column(String(50), default="SUBMITTED") # 'SUBMITTED', 'ACCEPTED', 'HOLD_FOR_APPROVAL', 'REJECTED', 'PROCESSING', 'COMPLETED'
    storage_estimated_gb = Column(Float, nullable=True)
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
