import os
import logging
from urllib.parse import quote_plus
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional

# Absolute Project Root (c:\Users\vasundharak\Desktop\SDAP)
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))

# Single unified data directory
UNIFIED_DATA_DIR = os.path.join(PROJECT_ROOT, "data")
_ENV_FILE_PATH = os.path.join(PROJECT_ROOT, "backend", ".env")

_cfg_logger = logging.getLogger("sdap.config")


class Settings(BaseSettings):
    PROJECT_NAME: str = "SDAP Server - Satellite Data Acquisition & Processing"
    API_V1_STR: str = "/api/v1"
    DEBUG: bool = True

    # JWT Authentication Settings
    SECRET_KEY: str = "sdap_niruthi_secret_key_super_secure_jwt_token_key"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440  # 24 hours

    # PostgreSQL Database Settings (Read dynamically from .env or environment)
    POSTGRES_SERVER: str = "172.16.16.213"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "postgres"
    POSTGRES_PASSWORD: str = ""
    POSTGRES_DB: str = "sdap_db"

    # Custom Database URI Override (optional)
    SQLALCHEMY_DATABASE_URI: Optional[str] = None

    @property
    def database_url(self) -> str:
        if self.SQLALCHEMY_DATABASE_URI:
            return self.SQLALCHEMY_DATABASE_URI
        pwd_encoded = quote_plus(self.POSTGRES_PASSWORD, safe='')
        user_encoded = quote_plus(self.POSTGRES_USER, safe='')
        return f"postgresql://{user_encoded}:{pwd_encoded}@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"

    @property
    def async_database_url(self) -> str:
        pwd_encoded = quote_plus(self.POSTGRES_PASSWORD, safe='')
        user_encoded = quote_plus(self.POSTGRES_USER, safe='')
        return f"postgresql+asyncpg://{user_encoded}:{pwd_encoded}@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"

    # Storage Paths — Grounded in single root data directory (c:\Users\vasundharak\Desktop\SDAP\data)
    BASE_DATA_DIR: str = UNIFIED_DATA_DIR
    STAGING_DIR: str = os.path.join(UNIFIED_DATA_DIR, "staging")
    RAW_ARCHIVE_DIR: str = os.path.join(UNIFIED_DATA_DIR, "archive")
    OUTPUT_INDEX_DIR: str = os.path.join(UNIFIED_DATA_DIR, "output")
    DELIVERY_DIR: str = os.path.join(UNIFIED_DATA_DIR, "delivery")

    # NAS Network Credentials & Persistent Storage Settings
    NAS_SERVER_IP: str = "172.16.16.52"
    NAS_SHARE_NAME: str = "Remote-sensing"
    NAS_DRIVE_LETTER: str = "Y:"
    NAS_USER: Optional[str] = None
    NAS_PASSWORD: Optional[str] = None

    # AWS Open Data Registry - Sentinel-2 COGs (https://registry.opendata.aws/sentinel-2-l2a-cogs/)
    AWS_SENTINEL_BUCKET: str = "sentinel-cogs"
    AWS_REGION: str = "us-west-2"
    AWS_SENTINEL_COGS_BUCKET: str = "sentinel-cogs"
    AWS_COGS_REGION: str = "us-west-2"
    AWS_SENTINEL_L1C_BUCKET: str = "sentinel-s2-l1c"
    AWS_SENTINEL_SNS_TOPIC_L2A: str = "arn:aws:sns:eu-central-1:214830741341:SentinelS2L2A"
    AWS_SENTINEL_SNS_TOPIC_L1C: str = "arn:aws:sns:eu-west-1:214830741341:NewSentinel2Product"

    # AWS Open Data Registry - Sentinel-1 GRD (https://registry.opendata.aws/sentinel-1/)
    AWS_SENTINEL_1_BUCKET: str = "sentinel-s1-l1c"
    AWS_SENTINEL_1_REGION: str = "eu-central-1"

    model_config = SettingsConfigDict(
        env_file=[_ENV_FILE_PATH, "backend/.env", ".env"],
        env_file_encoding="utf-8",
        extra="ignore"
    )


settings = Settings()

# Force single absolute path resolution across all services regardless of launch CWD
if not os.path.isabs(settings.STAGING_DIR):
    settings.STAGING_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.STAGING_DIR))

if not os.path.isabs(settings.OUTPUT_INDEX_DIR):
    settings.OUTPUT_INDEX_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.OUTPUT_INDEX_DIR))

if not os.path.isabs(settings.DELIVERY_DIR):
    settings.DELIVERY_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.DELIVERY_DIR))

if not os.path.isabs(settings.BASE_DATA_DIR):
    settings.BASE_DATA_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.BASE_DATA_DIR))

if not settings.RAW_ARCHIVE_DIR.startswith("\\\\") and not os.path.isabs(settings.RAW_ARCHIVE_DIR):
    settings.RAW_ARCHIVE_DIR = os.path.abspath(os.path.join(PROJECT_ROOT, settings.RAW_ARCHIVE_DIR))

# Ensure single root storage directories exist on startup
for _path in [settings.STAGING_DIR, settings.OUTPUT_INDEX_DIR, settings.DELIVERY_DIR]:
    if _path and not _path.startswith("\\\\"):
        try:
            os.makedirs(_path, exist_ok=True)
        except Exception as _err:
            _cfg_logger.warning(f"Could not pre-create storage directory '{_path}': {_err}")
