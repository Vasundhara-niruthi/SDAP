from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    PROJECT_NAME: str = "SDAP Server - Satellite Data Acquisition & Processing"
    API_V1_STR: str = "/api/v1"
    DEBUG: bool = True

    # JWT Authentication Settings
    SECRET_KEY: str = "sdap_niruthi_secret_key_super_secure_jwt_token_key"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440 # 24 hours

    # PostgreSQL Database Settings
    POSTGRES_SERVER: str = "localhost"
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str = "postgres"
    POSTGRES_PASSWORD: str = "vassu"
    POSTGRES_DB: str = "sdap_db"
    
    # Custom Database URI Override (optional)
    SQLALCHEMY_DATABASE_URI: Optional[str] = None

    @property
    def database_url(self) -> str:
        if self.SQLALCHEMY_DATABASE_URI:
            return self.SQLALCHEMY_DATABASE_URI
        return f"postgresql://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"

    @property
    def async_database_url(self) -> str:
        return f"postgresql+asyncpg://{self.POSTGRES_USER}:{self.POSTGRES_PASSWORD}@{self.POSTGRES_SERVER}:{self.POSTGRES_PORT}/{self.POSTGRES_DB}"

    # Storage Paths (Dynamic project-local storage)
    BASE_DATA_DIR: str = "data"
    STAGING_DIR: str = "data/staging"
    RAW_ARCHIVE_DIR: str = "data/archive"
    OUTPUT_INDEX_DIR: str = "data/output"
    DELIVERY_DIR: str = "data/delivery"

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

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()

# Ensure local storage directories exist on startup
import os
import logging
_cfg_logger = logging.getLogger("sdap.config")

for _path in [settings.STAGING_DIR, settings.RAW_ARCHIVE_DIR, settings.OUTPUT_INDEX_DIR, settings.DELIVERY_DIR]:
    if _path:
        try:
            os.makedirs(_path, exist_ok=True)
        except Exception as _err:
            _cfg_logger.warning(f"Could not pre-create storage directory '{_path}': {_err}")


