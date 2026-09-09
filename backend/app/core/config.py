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
    POSTGRES_PASSWORD: str = "postgres"
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

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()

# Ensure local storage directories exist on startup
import os
for _path in [settings.STAGING_DIR, settings.RAW_ARCHIVE_DIR, settings.OUTPUT_INDEX_DIR, settings.DELIVERY_DIR]:
    os.makedirs(_path, exist_ok=True)


