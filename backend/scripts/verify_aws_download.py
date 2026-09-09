"""
=============================================================================
SDAP AWS Open Data Download & Verification Tester
=============================================================================
Location: backend/scripts/verify_aws_download.py

Description:
    Demonstrates and verifies downloading Sentinel-2 COG raster files from
    AWS Open Data S3 (sentinel-cogs bucket), checking:
      1. S3 Metadata Head Object (ContentLength in bytes)
      2. Local File Byte Size Matching
      3. Rasterio Sub-sampled Array Read Test (Header & Data Integrity)
      4. Database Record Entry in PostgreSQL ('scene' and 'band_file' tables)
=============================================================================
"""

import os
import sys
import json
import time
import logging

# Ensure backend root is registered in Python path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import boto3
import rasterio
from botocore import UNSIGNED
from botocore.config import Config
from sqlalchemy import create_engine, text
from app.core.config import settings

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.verify_aws")

BUCKET = "sentinel-cogs"
REGION = "us-west-2"

s3_client = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(signature_version=UNSIGNED)
)


def verify_aws_scene_download(sample_tile: str = "44QLD"):
    """Demonstrates downloading a scene for sample_tile and performing 3-step verification."""
    logger.info(f"--- Starting AWS Open Data Verification Test for Tile '{sample_tile}' ---")

    # Sample S3 COG key (Sentinel-2 L2A scene for tile 44QLD)
    sample_prefix = f"sentinel-s2-l2a-cogs/44/Q/LD/2025/1/S2A_44QLD_20250102_0_L2A/"
    band_name = "B04.tif"
    s3_key = f"{sample_prefix}{band_name}"

    target_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "raw_archive", sample_tile, "2025", "1", "S2A_44QLD_20250102_0_L2A")

    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, band_name)
    temp_path = target_path + ".part"

    # Step 1: Query AWS S3 Object Metadata
    logger.info(f"1. Querying AWS S3 Head Object for key '{s3_key}'...")
    s3_meta = s3_client.head_object(Bucket=BUCKET, Key=s3_key)
    aws_size = s3_meta.get("ContentLength", 0)
    aws_etag = s3_meta.get("ETag", "").strip('"')
    logger.info(f"   [AWS S3] Bucket: '{BUCKET}', Size: {aws_size:,} bytes ({aws_size/1024/1024:.2f} MB), ETag: {aws_etag}")

    # Step 2: Download File (Atomic .part transfer)
    logger.info(f"2. Downloading object from AWS S3 to '{temp_path}'...")
    t0 = time.time()
    s3_client.download_file(BUCKET, s3_key, temp_path)
    download_time = time.time() - t0
    
    local_size = os.path.getsize(temp_path)
    logger.info(f"   Download finished in {download_time:.2f}s (Speed: {local_size/1024/1024/download_time:.2f} MB/s)")

    # Size Verification
    if local_size == aws_size:
        logger.info(f"   [VERIFIED - MATCH] Local byte size ({local_size:,} B) EXACTLY matches AWS S3 size ({aws_size:,} B).")
        os.replace(temp_path, target_path)
    else:
        logger.error(f"   [FAILED] Size mismatch: AWS = {aws_size}, Local = {local_size}")
        if os.path.exists(temp_path): os.remove(temp_path)
        return False

    # Step 3: Raster Integrity Check via rasterio
    logger.info(f"3. Running rasterio integrity test on downloaded file '{target_path}'...")
    with rasterio.open(target_path) as source:
        w, h = source.width, source.height
        crs = source.crs
        count = source.count
        dtype = source.dtypes[0]
        # Read 64x64 window test
        sample_pixels = source.read(1, window=((0, min(64, h)), (0, min(64, w))))
        pixel_min, pixel_max = sample_pixels.min(), sample_pixels.max()

    logger.info(f"   [RASTERIO VERIFIED] Dimensions: {w}x{h}, Bands: {count}, CRS: {crs}, Type: {dtype}")
    logger.info(f"   [PIXEL TEST] Sample 64x64 window read successful! Pixel values min={pixel_min}, max={pixel_max}")

    # Step 4: Record in PostgreSQL Database
    logger.info("4. Recording verified scene and band_file entry in PostgreSQL 'sdap_db'...")
    engine = create_engine(settings.database_url)
    with engine.connect() as conn:
        conn.execute(
            text("""
                INSERT INTO scene (scene_id, tile, sensing_date, satellite, folder, prefix, status, archive_path)
                VALUES (:s_id, :tile, :s_date, :sat, :folder, :prefix, 'HELD', :arch)
                ON CONFLICT (scene_id) DO UPDATE SET status = 'HELD';
            """),
            {
                "s_id": "S2A_44QLD_20250102_0_L2A",
                "tile": sample_tile,
                "s_date": "2025-01-02",
                "sat": "Sentinel-2",
                "folder": "S2A_44QLD_20250102_0_L2A",
                "prefix": sample_prefix,
                "arch": target_dir
            }
        )
        conn.execute(
            text("""
                INSERT INTO band_file (scene_id, tile, sensing_date, satellite, band, path, size_bytes, verified)
                VALUES (:s_id, :tile, :s_date, :sat, :band, :path, :size, 1);
            """),
            {
                "s_id": "S2A_44QLD_20250102_0_L2A",
                "tile": sample_tile,
                "s_date": "2025-01-02",
                "sat": "Sentinel-2",
                "band": band_name,
                "path": target_path,
                "size": local_size
            }
        )
        conn.commit()

    logger.info("=========================================================================")
    logger.info("[SUCCESS] AWS Download & Multi-Layer Integrity Verification Complete!")
    logger.info(f"  - Local Path: {target_path}")
    logger.info(f"  - File Size: {local_size:,} bytes")
    logger.info(f"  - AWS S3 Byte Match: YES")
    logger.info(f"  - Rasterio Read Test: PASSED")
    logger.info("=========================================================================")
    return True


if __name__ == "__main__":
    verify_aws_scene_download()
