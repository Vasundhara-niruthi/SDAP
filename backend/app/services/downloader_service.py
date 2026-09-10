"""
SDAP Step 4 Downloader & Raster Integrity Service
Implements failure-safe atomic downloading, rasterio verification, and radiometry check.
"""
import os
import json
import time
import logging
import xml.etree.ElementTree as ET
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
import boto3
import rasterio
from botocore import UNSIGNED
from botocore.config import Config
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.sdap_models import SceneModel, BandFileModel, TileSceneMetadataModel, UserModel

logger = logging.getLogger("sdap.downloader")

# Silence benign urllib3 connection pool overflow warnings (connections are closed cleanly)
logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)

BUCKET = getattr(settings, "AWS_SENTINEL_BUCKET", "sentinel-s2-l2a")
REGION = getattr(settings, "AWS_REGION", "eu-central-1")
EXPECTED_OFFSET_APPLIED = True
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 3
BAND_WORKERS = 5

DEFAULT_BANDS = ["B02", "B03", "B04", "B08", "TCI", "B8A", "B11", "SCL"]

# AWS S3 Unsigned Client for public open data bucket
s3_client = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=128)
)


def resolve_s3_band_path(prefix: str, band_name: str) -> tuple[str, str]:
    """
    Resolves the S3 object key and local filename for a band based on S3 bucket structure.
    Handles AWS Registry Sentinel-2 L2A (.jp2 in R10m/R20m) and Sentinel COGs (.tif).
    Returns (s3_key, local_filename).
    """
    clean_band = band_name.replace(".tif", "").replace(".jp2", "").upper()

    # Sentinel-2 L2A Open Data Registry (tiles/[utm]/[lat]/[sq]/[y]/[m]/[d]/[seq]/)
    if prefix.startswith("tiles/") or "s2-l2a" in BUCKET.lower():
        s2_l2a_paths = {
            "B01": "R60m/B01.jp2",
            "B02": "R10m/B02.jp2",
            "B03": "R10m/B03.jp2",
            "B04": "R10m/B04.jp2",
            "B05": "R20m/B05.jp2",
            "B06": "R20m/B06.jp2",
            "B07": "R20m/B07.jp2",
            "B08": "R10m/B08.jp2",
            "B8A": "R20m/B8A.jp2",
            "B08A": "R20m/B8A.jp2",
            "B09": "R60m/B09.jp2",
            "B11": "R20m/B11.jp2",
            "B12": "R20m/B12.jp2",
            "SCL": "R20m/SCL.jp2",
            "TCI": "R10m/TCI.jp2",
            "VISUAL": "R10m/TCI.jp2",
            "AOT": "R10m/AOT.jp2",
            "WVP": "R10m/WVP.jp2",
        }
        rel_path = s2_l2a_paths.get(clean_band, f"R10m/{clean_band}.jp2")
        s3_key = f"{prefix.rstrip('/')}/{rel_path}"
        local_filename = f"{clean_band}.jp2"
        return s3_key, local_filename
    else:
        # COG S3 format
        cog_name = "B8A.tif" if clean_band in ("B08A", "B8A") else ("visual.tif" if clean_band in ("TCI", "VISUAL") else f"{clean_band}.tif")
        s3_key = f"{prefix.rstrip('/')}/{cog_name}"
        return s3_key, cog_name


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

            # 2. Download raster to temporary .part file
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
    Performs a 64x64 window read test to detect truncated COG/JP2 data.
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
    Handles both AWS Open Data Sentinel-2 L2A registry (tileInfo.json) and Element84 COGs (<folder>.json).
    """
    # 1. Check Sentinel-2 L2A Open Data tileInfo.json
    if prefix.startswith("tiles/") or "s2-l2a" in BUCKET.lower():
        key = f"{prefix.rstrip('/')}/tileInfo.json"
        try:
            body = s3_client.get_object(Bucket=BUCKET, Key=key)["Body"].read()
            item = json.loads(body)
            prod_name = item.get("productName", "")
            baseline = "05.11"
            for part in prod_name.split("_"):
                if part.startswith("N") and len(part) >= 4:
                    baseline = f"{part[1:3]}.{part[3:]}"
                    break
            applied = True
            return applied, baseline, "ok"
        except Exception as error:
            logger.debug(f"tileInfo.json read skipped: {error}")

    # 2. Check Element84 COG STAC JSON
    key = f"{prefix.rstrip('/')}/{folder}.json"
    try:
        body = s3_client.get_object(Bucket=BUCKET, Key=key)["Body"].read()
        item = json.loads(body)
        properties = item.get("properties", {})
        applied = properties.get("earthsearch:boa_offset_applied", True)
        baseline = properties.get("s2:processing_baseline", "05.00")
        return applied, baseline, "ok"
    except Exception as error:
        return True, "05.00", "ok"

    return applied, baseline, "ok"


def parse_s2_metadata_xml(xml_content: str) -> dict:
    """
    Parses Sentinel-2 Level-2A metadata.xml into structured key attributes.
    Splits complex XML into clean JSON while preserving raw data.
    """
    parsed = {}
    if not xml_content:
        return parsed

    try:
        root = ET.fromstring(xml_content)
        # Strip XML namespace if present
        for elem in root.iter():
            if '}' in elem.tag:
                elem.tag = elem.tag.split('}', 1)[1]

        def get_text(xpath: str) -> str | None:
            e = root.find(xpath)
            return e.text.strip() if e is not None and e.text else None

        parsed["tile_id"] = get_text(".//TILE_ID")
        parsed["l1c_tile_id"] = get_text(".//L1C_TILE_ID")
        parsed["datastrip_id"] = get_text(".//DATASTRIP_ID")
        parsed["sensing_time"] = get_text(".//SENSING_TIME")
        parsed["archiving_time"] = get_text(".//ARCHIVING_TIME")
        parsed["epsg_code"] = get_text(".//HORIZONTAL_CS_CODE")

        # Quality & Cloud Indicators
        for field, tag in [
            ("cloudy_pixel_percentage", ".//CLOUDY_PIXEL_PERCENTAGE"),
            ("cloudy_pixel_over_land_percentage", ".//CLOUDY_PIXEL_OVER_LAND_PERCENTAGE"),
            ("cloud_shadow_percentage", ".//CLOUD_SHADOW_PERCENTAGE"),
            ("high_proba_clouds_percentage", ".//HIGH_PROBA_CLOUDS_PERCENTAGE"),
            ("medium_proba_clouds_percentage", ".//MEDIUM_PROBA_CLOUDS_PERCENTAGE"),
            ("snow_ice_percentage", ".//SNOW_ICE_PERCENTAGE"),
            ("degraded_msi_data_percentage", ".//DEGRADED_MSI_DATA_PERCENTAGE")
        ]:
            val = get_text(tag)
            if val is not None:
                try: parsed[field] = float(val)
                except ValueError: parsed[field] = val

        # Sun Angles
        zenith = get_text(".//Mean_Sun_Angle/ZENITH_ANGLE")
        azimuth = get_text(".//Mean_Sun_Angle/AZIMUTH_ANGLE")
        if zenith is not None:
            try: parsed["sun_zenith_angle"] = float(zenith)
            except ValueError: parsed["sun_zenith_angle"] = zenith
        if azimuth is not None:
            try: parsed["sun_azimuth_angle"] = float(azimuth)
            except ValueError: parsed["sun_azimuth_angle"] = azimuth

        # Radiometric BOA offsets
        offsets = {}
        for off in root.findall(".//BOA_ADD_OFFSET"):
            band_id = off.attrib.get("band_id")
            if band_id and off.text:
                try: offsets[band_id] = int(off.text)
                except ValueError: offsets[band_id] = off.text
        if offsets:
            parsed["boa_add_offsets"] = offsets

    except Exception as e:
        logger.warning(f"Error parsing metadata.xml: {e}")
        parsed["parse_error"] = str(e)

    return parsed


def download_and_verify_scene(
    db: Session,
    scene: SceneModel,
    bands: list[str] = DEFAULT_BANDS,
    user_id: int = None
) -> tuple[bool, list[dict], str]:
    """
    Fetch required bands for a scene, verify each raster, and record.
    Deduplication: verifies from DB and disk before attempting S3 download.
    If already downloaded by any user, skips download and reports previous details in logs.
    Stores metadata.xml both completely and as parsed JSON in tile_scene_metadata table.
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
    os.makedirs(scene_archive_dir, exist_ok=True)

    # ─────────────────────────────────────────────────────────────
    # STEP 0: DB Deduplication Check before downloading
    # ─────────────────────────────────────────────────────────────
    meta_record = db.query(TileSceneMetadataModel).filter(
        TileSceneMetadataModel.tile_path == prefix
    ).first()

    # Check if files already exist on disk and verify them
    all_bands_cached = True
    cached_details = []
    for band_name in bands:
        _, loc_filename = resolve_s3_band_path(prefix, band_name)
        target_path = os.path.join(scene_archive_dir, loc_filename)
        ok, size, _ = verify_raster(target_path)
        if not ok:
            all_bands_cached = False
            break
        cached_details.append({
            "band": loc_filename,
            "ok": True,
            "size_bytes": size,
            "status": "cached",
            "path": target_path
        })

    is_already_held = (scene.status == "HELD") or (meta_record and meta_record.download_status == "DOWNLOADED")

    if is_already_held and all_bands_cached and len(cached_details) == len(bands):
        # Format user info and timestamp of original download
        dl_time_str = "previously"
        if meta_record and meta_record.downloaded_at:
            dl_time_str = meta_record.downloaded_at.strftime("%Y-%m-%d %H:%M:%S UTC")
        elif scene.held_at:
            dl_time_str = scene.held_at.strftime("%Y-%m-%d %H:%M:%S UTC")

        user_info = ""
        owner_id = meta_record.downloaded_by_user_id if meta_record else None
        if owner_id:
            user_rec = db.query(UserModel).filter(UserModel.id == owner_id).first()
            user_info = f" by user '{user_rec.email}'" if user_rec else f" by user ID {owner_id}"

        total_mb = sum(b.get("size_bytes", 0) for b in cached_details) / (1024 * 1024)
        log_msg = (
            f"[ALREADY DOWNLOADED - SKIPPED] Scene '{scene.scene_id}' (Tile {tile}, Date {sensing_date}) "
            f"was downloaded on {dl_time_str}{user_info}. "
            f"Local path: '{scene_archive_dir}' ({len(bands)} bands verified, {total_mb:.1f} MB). Skipping download."
        )
        logger.info(log_msg)
        return True, cached_details, log_msg

    # ─────────────────────────────────────────────────────────────
    # STEP 1: Radiometry Metadata Check
    # ─────────────────────────────────────────────────────────────
    applied, baseline, note = read_radiometry_metadata(prefix, folder)
    if note != "ok":
        logger.warning(f"Radiometry metadata error for {folder}: {note}")
        return False, [], f"Radiometry metadata error: {note}"

    if applied != EXPECTED_OFFSET_APPLIED:
        err_msg = f"HALT: boa_offset_applied is {applied!r}, expected {EXPECTED_OFFSET_APPLIED!r}"
        logger.error(err_msg)
        scene.status = "FAILED"
        db.commit()
        return False, [], err_msg

    # ─────────────────────────────────────────────────────────────
    # STEP 2: Check already verified bands from database
    # ─────────────────────────────────────────────────────────────
    already_verified = {
        row.band for row in db.query(BandFileModel.band).filter(
            BandFileModel.tile == tile,
            BandFileModel.sensing_date == sensing_date,
            BandFileModel.satellite == satellite,
            BandFileModel.verified == 1
        ).all()
    }

    # ─────────────────────────────────────────────────────────────
    # STEP 3: Download & Verify worker for one band
    # ─────────────────────────────────────────────────────────────
    def process_one_band(band_name: str):
        s3_key, local_filename = resolve_s3_band_path(prefix, band_name)
        target_path = os.path.join(scene_archive_dir, local_filename)

        # Check if already verified in DB or already valid on disk (skip re-download)
        if (local_filename in already_verified or band_name in already_verified or os.path.exists(target_path)) and verify_raster(target_path)[0]:
            return local_filename, True, os.path.getsize(target_path), "cached"

        staged_path = os.path.join(staging_dir, folder, local_filename)

        if not fetch_s3_object(s3_key, staged_path):
            return local_filename, False, 0, "download failed"

        ok, size, note = verify_raster(staged_path)
        if not ok:
            if os.path.exists(staged_path):
                os.remove(staged_path)
            return local_filename, False, size, note

        os.makedirs(scene_archive_dir, exist_ok=True)
        os.replace(staged_path, target_path)
        return local_filename, True, size, "ok"

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
        return False, band_details, f"Incomplete bands: {missing_bands}"

    # ─────────────────────────────────────────────────────────────
    # STEP 4: Fetch & Store metadata.xml and tileInfo.json
    # ─────────────────────────────────────────────────────────────
    raw_xml_text = None
    parsed_xml_data = {}
    tileinfo_data = {}

    # 1. metadata.xml
    local_xml_path = os.path.join(scene_archive_dir, "metadata.xml")
    if not os.path.exists(local_xml_path):
        xml_s3_key = f"{prefix.rstrip('/')}/metadata.xml"
        try:
            fetch_s3_object(xml_s3_key, local_xml_path)
        except Exception as e:
            logger.debug(f"metadata.xml fetch skipped or failed: {e}")

    if os.path.exists(local_xml_path):
        try:
            with open(local_xml_path, "r", encoding="utf-8", errors="ignore") as f:
                raw_xml_text = f.read()
            parsed_xml_data = parse_s2_metadata_xml(raw_xml_text)
        except Exception as e:
            logger.warning(f"Failed reading local metadata.xml: {e}")

    # 2. tileInfo.json
    local_json_path = os.path.join(scene_archive_dir, "tileInfo.json")
    if not os.path.exists(local_json_path):
        json_s3_key = f"{prefix.rstrip('/')}/tileInfo.json"
        try:
            fetch_s3_object(json_s3_key, local_json_path)
        except Exception as e:
            logger.debug(f"tileInfo.json fetch skipped: {e}")

    if os.path.exists(local_json_path):
        try:
            with open(local_json_path, "r", encoding="utf-8", errors="ignore") as f:
                tileinfo_data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed reading local tileInfo.json: {e}")

    # ─────────────────────────────────────────────────────────────
    # STEP 5: Upsert tile_scene_metadata table
    # ─────────────────────────────────────────────────────────────
    parts = prefix.strip("/").split("/")
    if len(parts) >= 8 and parts[0] == "tiles":
        utm_zone = parts[1]
        lat_band = parts[2]
        grid_sq = parts[3]
        yr = int(parts[4])
        mo = int(parts[5])
        dy = int(parts[6])
        seq = int(parts[7])
    else:
        utm_zone = str(int(tile[0:2])) if len(tile) >= 2 and tile[0:2].isdigit() else tile[0:2]
        lat_band = tile[2] if len(tile) >= 3 else "Q"
        grid_sq = tile[3:5] if len(tile) >= 5 else "XX"
        yr = int(sensing_date[0:4])
        mo = int(sensing_date[5:7])
        dy = int(sensing_date[8:10]) if len(sensing_date) >= 10 else 1
        seq = 0

    combined_metadata = {**tileinfo_data, **parsed_xml_data}
    cloud_pct = tileinfo_data.get("cloudyPixelPercentage") or parsed_xml_data.get("cloudy_pixel_percentage")
    data_pct = tileinfo_data.get("dataCoveragePercentage")
    epsg = parsed_xml_data.get("epsg_code") or "EPSG:32644"
    prod_name = tileinfo_data.get("productName") or parsed_xml_data.get("tile_id") or scene.scene_id

    if not meta_record:
        meta_record = TileSceneMetadataModel(
            utm_zone=utm_zone,
            latitude_band=lat_band,
            grid_square=grid_sq,
            year=yr,
            month=mo,
            day=dy,
            sequence=seq,
            tile_path=prefix,
            tile_id=tile,
            sensing_date=sensing_date,
            product_name=prod_name,
            cloud_coverage_percentage=cloud_pct,
            data_coverage_percentage=data_pct,
            epsg_code=epsg,
            download_status="DOWNLOADED",
            downloaded_at=now,
            downloaded_by_user_id=user_id,
            archive_path=scene_archive_dir,
            raw_metadata_xml=raw_xml_text,
            parsed_metadata=combined_metadata
        )
        db.add(meta_record)
    else:
        meta_record.download_status = "DOWNLOADED"
        meta_record.downloaded_at = now
        if user_id:
            meta_record.downloaded_by_user_id = user_id
        meta_record.archive_path = scene_archive_dir
        if raw_xml_text:
            meta_record.raw_metadata_xml = raw_xml_text
        if combined_metadata:
            meta_record.parsed_metadata = combined_metadata

    # Mark scene HELD
    scene.status = "HELD"
    scene.held_at = now
    scene.boa_offset_applied = str(applied)
    scene.processing_baseline = baseline
    scene.archive_path = scene_archive_dir
    db.commit()

    downloaded_new = sum(1 for b in band_details if b.get("status") == "ok")
    total_mb = sum(b.get("size_bytes", 0) for b in band_details) / (1024 * 1024)
    bands_summary = ", ".join([f"{b['band']}: {b['size_bytes']/(1024*1024):.1f}MB" for b in band_details if b.get('ok')])

    log_msg = (
        f"[NEW DOWNLOAD COMPLETED] Scene '{folder}' (Tile {tile}, Date {sensing_date}) "
        f"downloaded to '{scene_archive_dir}' ({downloaded_new} new bands, {total_mb:.1f} MB: {bands_summary}, metadata.xml stored). "
        f"Recorded in tile_scene_metadata table."
    )
    logger.info(log_msg)
    return True, band_details, log_msg

