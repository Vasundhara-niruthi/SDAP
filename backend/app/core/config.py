import os
import logging
from urllib.parse import quote_plus
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

# Absolute Project Root (e.g. c:\Users\vasundharak\Desktop\SDAP)
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

# Single unified data directory default
UNIFIED_DATA_DIR = os.path.join(PROJECT_ROOT, "data")
_ENV_FILE_PATH = os.path.join(PROJECT_ROOT, "backend", ".env")

_cfg_logger = logging.getLogger("sdap.config")


class Settings(BaseSettings):
    PROJECT_NAME: str = "SDAP Server - Satellite Data Acquisition & Processing"
    API_V1_STR: str = "/api/v1"
    DEBUG: bool = True

    # JWT Authentication Settings (Loaded dynamically from .env)
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours

    # PostgreSQL Database Settings (Loaded dynamically from .env)
    POSTGRES_SERVER: str = ""
    POSTGRES_PORT: Optional[int] = None
    POSTGRES_USER: str = ""
    POSTGRES_PASSWORD: str = ""
    POSTGRES_DB: str = ""

    # Custom Database URI Override (optional)
    SQLALCHEMY_DATABASE_URI: Optional[str] = None

    @property
    def database_url(self) -> str:
        if self.SQLALCHEMY_DATABASE_URI:
            return self.SQLALCHEMY_DATABASE_URI
        pwd_encoded = quote_plus(self.POSTGRES_PASSWORD or "", safe='')
        user_encoded = quote_plus(self.POSTGRES_USER or "", safe='')
        port_part = f":{self.POSTGRES_PORT}" if self.POSTGRES_PORT else ""
        return f"postgresql://{user_encoded}:{pwd_encoded}@{self.POSTGRES_SERVER}{port_part}/{self.POSTGRES_DB}"

    @property
    def async_database_url(self) -> str:
        pwd_encoded = quote_plus(self.POSTGRES_PASSWORD or "", safe='')
        user_encoded = quote_plus(self.POSTGRES_USER or "", safe='')
        port_part = f":{self.POSTGRES_PORT}" if self.POSTGRES_PORT else ""
        return f"postgresql+asyncpg://{user_encoded}:{pwd_encoded}@{self.POSTGRES_SERVER}{port_part}/{self.POSTGRES_DB}"

    # Storage Paths — Configurable via .env, defaults to project root / data subfolders
    BASE_DATA_DIR: Optional[str] = None
    STAGING_DIR: Optional[str] = None
    RAW_ARCHIVE_DIR: Optional[str] = None
    OUTPUT_INDEX_DIR: Optional[str] = None
    DELIVERY_DIR: Optional[str] = None

    # NAS Network Credentials & Persistent Storage Settings (Loaded dynamically from .env)
    NAS_STORAGE_PATH: Optional[str] = None
    NAS_SERVER_IP: Optional[str] = None
    NAS_SHARE_NAME: Optional[str] = None
    NAS_DRIVE_LETTER: Optional[str] = None
    NAS_USER: Optional[str] = None
    NAS_PASSWORD: Optional[str] = None

    # AWS Open Data Registry - Sentinel-2 COGs (Loaded dynamically from .env)
    AWS_SENTINEL_BUCKET: Optional[str] = None
    AWS_REGION: Optional[str] = None
    AWS_SENTINEL_COGS_BUCKET: Optional[str] = None
    AWS_COGS_REGION: Optional[str] = None
    AWS_SENTINEL_L1C_BUCKET: Optional[str] = None
    AWS_SENTINEL_SNS_TOPIC_L2A: Optional[str] = None
    AWS_SENTINEL_SNS_TOPIC_L1C: Optional[str] = None

    # AWS Open Data Registry - Sentinel-1 GRD (Loaded dynamically from .env)
    AWS_SENTINEL_1_BUCKET: Optional[str] = None
    AWS_SENTINEL_1_REGION: Optional[str] = None

    # ESA SNAP GPT Engine Path for Sentinel-1 Processing (Loaded dynamically from .env)
    SNAP_GPT_PATH: Optional[str] = None

    # Default Admin Account for DB Initialization (Loaded dynamically from .env)
    DEFAULT_ADMIN_EMAIL: Optional[str] = None
    DEFAULT_ADMIN_PASSWORD: Optional[str] = None
    DEFAULT_ADMIN_NAME: Optional[str] = None

    model_config = SettingsConfigDict(
        env_file=[_ENV_FILE_PATH, "backend/.env", ".env"],
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()

# Force single absolute path resolution across all services regardless of launch CWD
if not settings.BASE_DATA_DIR or settings.BASE_DATA_DIR.strip() == "":
    settings.BASE_DATA_DIR = UNIFIED_DATA_DIR
elif not os.path.isabs(settings.BASE_DATA_DIR):
    settings.BASE_DATA_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.BASE_DATA_DIR))

if not settings.STAGING_DIR or settings.STAGING_DIR.strip() == "":
    settings.STAGING_DIR = os.path.join(settings.BASE_DATA_DIR, "staging")
elif not os.path.isabs(settings.STAGING_DIR):
    settings.STAGING_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.STAGING_DIR))

if not settings.OUTPUT_INDEX_DIR or settings.OUTPUT_INDEX_DIR.strip() == "":
    settings.OUTPUT_INDEX_DIR = os.path.join(settings.BASE_DATA_DIR, "output")
elif not os.path.isabs(settings.OUTPUT_INDEX_DIR):
    settings.OUTPUT_INDEX_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.OUTPUT_INDEX_DIR))

if not settings.DELIVERY_DIR or settings.DELIVERY_DIR.strip() == "":
    settings.DELIVERY_DIR = os.path.join(settings.BASE_DATA_DIR, "delivery")
elif not os.path.isabs(settings.DELIVERY_DIR):
    settings.DELIVERY_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.DELIVERY_DIR))

if not settings.RAW_ARCHIVE_DIR or settings.RAW_ARCHIVE_DIR.strip() == "":
    settings.RAW_ARCHIVE_DIR = os.path.join(settings.BASE_DATA_DIR, "archive")
elif not settings.RAW_ARCHIVE_DIR.startswith("\\\\") and not os.path.isabs(settings.RAW_ARCHIVE_DIR):
    settings.RAW_ARCHIVE_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.RAW_ARCHIVE_DIR))

# Ensure single root storage directories exist on startup
for _path in [settings.STAGING_DIR, settings.OUTPUT_INDEX_DIR, settings.DELIVERY_DIR]:
    if _path and not _path.startswith("\\\\"):
        try:
            os.makedirs(_path, exist_ok=True)
        except Exception as _err:
            _cfg_logger.warning(f"Could not pre-create storage directory '{_path}': {_err}")
