import os
import logging
from typing import List, Optional
from urllib.parse import quote_plus

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repository root (parent of backend/)
PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_ENV_FILE_PATH = os.path.join(PROJECT_ROOT, "backend", ".env")
_MIN_SECRET_KEY_LENGTH = 32

_cfg_logger = logging.getLogger("sdap.config")


class Settings(BaseSettings):
    PROJECT_NAME: str = "SDAP Server - Satellite Data Acquisition & Processing"
    API_V1_STR: str = "/api/v1"

    # JWT (SECRET_KEY is required; validated below)
    SECRET_KEY: str = ""
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 1440

    # PostgreSQL; SQLALCHEMY_DATABASE_URI overrides the parts below when set
    POSTGRES_SERVER: str = ""
    POSTGRES_PORT: Optional[int] = None
    POSTGRES_USER: str = ""
    POSTGRES_PASSWORD: str = ""
    POSTGRES_DB: str = ""
    SQLALCHEMY_DATABASE_URI: Optional[str] = None

    # Storage roots (relative paths resolve against the repository root)
    BASE_DATA_DIR: Optional[str] = None
    STAGING_DIR: Optional[str] = None
    RAW_ARCHIVE_DIR: Optional[str] = None
    OUTPUT_INDEX_DIR: Optional[str] = None
    DELIVERY_DIR: Optional[str] = None

    # NAS (SMB/UNC share)
    NAS_STORAGE_PATH: Optional[str] = None
    NAS_SERVER_IP: Optional[str] = None
    NAS_SHARE_NAME: Optional[str] = None
    NAS_DRIVE_LETTER: Optional[str] = None
    NAS_USER: Optional[str] = None
    NAS_PASSWORD: Optional[str] = None

    # AWS Open Data: Sentinel-2 COGs and Sentinel-1 GRD
    AWS_SENTINEL_COGS_BUCKET: Optional[str] = None
    AWS_COGS_REGION: Optional[str] = None
    AWS_SENTINEL_1_BUCKET: Optional[str] = None
    AWS_SENTINEL_1_REGION: Optional[str] = None

    # ESA SNAP GPT executable (Sentinel-1 processing)
    SNAP_GPT_PATH: Optional[str] = None

    # Admin account created at startup only if missing
    DEFAULT_ADMIN_EMAIL: Optional[str] = None
    DEFAULT_ADMIN_PASSWORD: Optional[str] = None
    DEFAULT_ADMIN_NAME: Optional[str] = None

    # Concurrent pipeline workers (default chosen in routes/requests.py)
    PIPELINE_MAX_WORKERS: Optional[int] = None

    # Comma-separated browser origins; '*' is never allowed because credentials are enabled
    CORS_ORIGINS: str = "http://localhost:5173,http://127.0.0.1:5173"

    model_config = SettingsConfigDict(
        env_file=[_ENV_FILE_PATH, ".env"],
        env_file_encoding="utf-8",
        extra="ignore"
    )

    @property
    def database_url(self) -> str:
        if self.SQLALCHEMY_DATABASE_URI:
            return self.SQLALCHEMY_DATABASE_URI
        user = quote_plus(self.POSTGRES_USER or "", safe="")
        password = quote_plus(self.POSTGRES_PASSWORD or "", safe="")
        port = f":{self.POSTGRES_PORT}" if self.POSTGRES_PORT else ""
        return f"postgresql://{user}:{password}@{self.POSTGRES_SERVER}{port}/{self.POSTGRES_DB}"

    @property
    def cors_origins_list(self) -> List[str]:
        origins = [o.strip().rstrip("/") for o in (self.CORS_ORIGINS or "").split(",")]
        return [o for o in origins if o and o != "*"]


def _resolve_dir(value: Optional[str], default: str) -> str:
    """Return `default` when unset, UNC/absolute paths unchanged, else the path under PROJECT_ROOT."""
    if not value or not value.strip():
        return default
    if value.startswith("\\\\") or os.path.isabs(value):
        return value
    return os.path.abspath(os.path.join(PROJECT_ROOT, value))


settings = Settings()

# JWTs signed with an empty or short key are forgeable, so refuse to start.
if len(settings.SECRET_KEY.strip()) < _MIN_SECRET_KEY_LENGTH:
    raise RuntimeError(
        f"SECRET_KEY is missing or shorter than {_MIN_SECRET_KEY_LENGTH} characters. "
        "Set a strong random SECRET_KEY in backend/.env or the environment "
        "(e.g. python -c \"import secrets; print(secrets.token_urlsafe(48))\")."
    )

# Resolve every storage root to one absolute path regardless of the launch directory
settings.BASE_DATA_DIR = _resolve_dir(settings.BASE_DATA_DIR, os.path.join(PROJECT_ROOT, "data"))
settings.STAGING_DIR = _resolve_dir(settings.STAGING_DIR, os.path.join(settings.BASE_DATA_DIR, "staging"))
settings.OUTPUT_INDEX_DIR = _resolve_dir(settings.OUTPUT_INDEX_DIR, os.path.join(settings.BASE_DATA_DIR, "output"))
settings.DELIVERY_DIR = _resolve_dir(settings.DELIVERY_DIR, os.path.join(settings.BASE_DATA_DIR, "delivery"))
settings.RAW_ARCHIVE_DIR = _resolve_dir(settings.RAW_ARCHIVE_DIR, os.path.join(settings.BASE_DATA_DIR, "archive"))

# Create the local roots (the archive is NAS-backed and created on demand)
for _path in (settings.STAGING_DIR, settings.OUTPUT_INDEX_DIR, settings.DELIVERY_DIR):
    if not _path.startswith("\\\\"):
        try:
            os.makedirs(_path, exist_ok=True)
        except OSError as _err:
            _cfg_logger.warning(f"Could not pre-create storage directory '{_path}': {_err}")
