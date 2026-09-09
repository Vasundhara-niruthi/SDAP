"""
SDAP Step 4 Downloader & Raster Integrity Service
Implements failure-safe atomic downloading, rasterio verification, and radiometry check.
"""
import os
import json
import time
import logging
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import boto3
import rasterio
from botocore import UNSIGNED
from botocore.config import Config
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.sdap_models import SceneModel, BandFileModel

logger = logging.getLogger("sdap.downloader")

# Silence benign urllib3 connection pool overflow warnings (connections are closed cleanly)
logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)

BUCKET = "sentinel-cogs"
REGION = "us-west-2"
EXPECTED_OFFSET_APPLIED = True
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 3
BAND_WORKERS = 5

DEFAULT_BANDS = ["B03.tif", "B04.tif", "B08.tif", "B8A.tif", "B11.tif", "SCL.tif"]

# AWS S3 Unsigned Client for public open data bucket
s3_client = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=128)
)


def fetch_s3_object(key: str, target_path: str) -> bool:
    """
    Download one object with retries, exponential backoff, and AWS S3 byte-size verification.
    Atomically swaps .part file to target path upon successful byte-matching.
    """
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    temp_path = target_path + ".part"

    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            # 1. Fetch AWS S3 Object metadata for exact byte size comparison
            s3_meta = s3_client.head_object(Bucket=BUCKET, Key=key)
            expected_size = s3_meta.get("ContentLength", 0)

            # 2. Download COG raster to temporary .part file
            s3_client.download_file(BUCKET, key, temp_path)
            downloaded_size = os.path.getsize(temp_path)

            # 3. Exact Byte-for-Byte Check against AWS S3
            if expected_size > 0 and downloaded_size != expected_size:
                raise ValueError(f"Byte mismatch for {key}: AWS S3 size = {expected_size}, Local downloaded size = {downloaded_size}")

            # 4. Atomic swap upon verified download
            os.replace(temp_path, target_path)
            return True
        except Exception as error:
            if os.path.exists(temp_path):
                os.remove(temp_path)
            if attempt == MAX_ATTEMPTS:
                logger.error(f"Failed fetching {key} after {attempt} attempts: {error}")
                return False
            delay = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
            time.sleep(delay)
    return False



def verify_raster(path: str) -> tuple[bool, int, str]:
    """
    Confirm downloaded raster is a readable raster with valid dimensions and CRS.
    Performs a 64x64 window read test to detect truncated COG data.
    Returns (ok: bool, size_bytes: int, note: str).
    """
    if not os.path.exists(path):
        return False, 0, "missing"

    size = os.path.getsize(path)
    if size == 0:
        return False, 0, "empty"

    try:
        with rasterio.open(path) as source:
            if source.width == 0 or source.height == 0:
                return False, size, "zero dimensions"
            if source.crs is None:
                return False, size, "no coordinate reference system"
            # Read small window to verify image data integrity behind header
            source.read(1, window=((0, min(64, source.height)), (0, min(64, source.width))))
    except Exception as error:
        return False, size, f"unreadable: {type(error).__name__}"

    return True, size, "ok"


def read_radiometry_metadata(prefix: str, folder: str) -> tuple[bool | None, str | None, str]:
    """
    Fetch scene metadata JSON from S3 and return radiometric parameters.
    """
    key = f"{prefix}{folder}.json"
    try:
        body = s3_client.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        item = json.loads(body)
    except Exception as error:
        return None, None, f"metadata unreadable: {error}"

    properties = item.get("properties", {})
    applied = properties.get("earthsearch:boa_offset_applied")
    baseline = properties.get("s2:processing_baseline")

    return applied, baseline, "ok"


def download_and_verify_scene(db: Session, scene: SceneModel, bands: list[str] = DEFAULT_BANDS) -> tuple[bool, list[dict]]:
    """
    Fetch every required band for a scene, verify each raster, and record.
    Marks scene status='HELD' only when ALL bands are verified.
    """
    tile = scene.tile
    sensing_date = scene.sensing_date
    satellite = scene.satellite
    folder = scene.folder
    prefix = scene.prefix

    year = sensing_date[0:4]
    month = str(int(sensing_date[5:7]))
    
    staging_dir = settings.STAGING_DIR
    archive_dir = settings.RAW_ARCHIVE_DIR

    scene_archive_dir = os.path.join(archive_dir, tile, year, month, folder)

    # 1. Radiometry Metadata Check
    applied, baseline, note = read_radiometry_metadata(prefix, folder)
    if note != "ok":
        logger.warning(f"Radiometry metadata error for {folder}: {note}")
        return False, []

    if applied != EXPECTED_OFFSET_APPLIED:
        logger.error(f"HALT: boa_offset_applied is {applied!r}, expected {EXPECTED_OFFSET_APPLIED!r}")
        scene.status = "FAILED"
        db.commit()
        return False, []

    # 2. Check already verified bands from database
    already_verified = {
        row.band for row in db.query(BandFileModel.band).filter(
            BandFileModel.tile == tile,
            BandFileModel.sensing_date == sensing_date,
            BandFileModel.satellite == satellite,
            BandFileModel.verified == 1
        ).all()
    }

    # 3. Download & Verify worker for one band
    def process_one_band(band_name: str):
        target_path = os.path.join(scene_archive_dir, band_name)

        # Check if already verified in DB or already valid on disk (skip re-download)
        if (band_name in already_verified or os.path.exists(target_path)) and verify_raster(target_path)[0]:
            return band_name, True, os.path.getsize(target_path), "cached"

        staged_path = os.path.join(staging_dir, folder, band_name)
        s3_key = f"{prefix}{band_name}"

        if not fetch_s3_object(s3_key, staged_path):
            return band_name, False, 0, "download failed"

        ok, size, note = verify_raster(staged_path)
        if not ok:
            if os.path.exists(staged_path):
                os.remove(staged_path)
            return band_name, False, size, note

        os.makedirs(scene_archive_dir, exist_ok=True)
        os.replace(staged_path, target_path)
        return band_name, True, size, "ok"

    with ThreadPoolExecutor(max_workers=BAND_WORKERS) as pool:
        results = list(pool.map(process_one_band, bands))

    now = datetime.utcnow()
    band_details = []
    for band_name, ok, size, note in results:
        target_path = os.path.join(scene_archive_dir, band_name)
        band_details.append({
            "band": band_name,
            "ok": ok,
            "size_bytes": size,
            "status": note,
            "path": target_path
        })
        
        # Insert or update band_file record
        existing_bf = db.query(BandFileModel).filter(
            BandFileModel.scene_id == scene.scene_id,
            BandFileModel.band == band_name
        ).first()

        if existing_bf:
            existing_bf.path = target_path
            existing_bf.size_bytes = size
            existing_bf.verified = 1 if ok else 0
            existing_bf.downloaded_at = now
        else:
            db.add(BandFileModel(
                scene_id=scene.scene_id,
                tile=tile,
                sensing_date=sensing_date,
                satellite=satellite,
                band=band_name,
                path=target_path,
                size_bytes=size,
                verified=1 if ok else 0,
                downloaded_at=now
            ))

    db.commit()

    # Check if ALL bands passed verification
    if not all(ok for _, ok, _, _ in results):
        missing_bands = [b for b, ok, _, _ in results if not ok]
        logger.warning(f"Scene {folder} incomplete missing {missing_bands} - remains PENDING")
        return False, band_details

    # Mark scene HELD only when the complete band set is verified
    scene.status = "HELD"
    scene.held_at = now
    scene.boa_offset_applied = str(applied)
    scene.processing_baseline = baseline
    scene.archive_path = scene_archive_dir
    db.commit()

    logger.info(f"Scene {folder} successfully HELD ({len(results)} bands verified).")
    return True, band_details

