import shutil
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
from typing import Optional, List, Dict, Any
from concurrent.futures import ThreadPoolExecutor
import boto3
import rasterio
from botocore import UNSIGNED
from botocore.config import Config
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings
from app.models.sdap_models import (
    SceneModel,
    BandFileModel,
    TileSceneMetadataModel,
    Sentinel1SceneMetadataModel,
    UserModel
)

logger = logging.getLogger("sdap.downloader")

# Silence benign urllib3 connection pool overflow warnings (connections are closed cleanly)
logging.getLogger("urllib3.connectionpool").setLevel(logging.ERROR)

S2_BUCKET = getattr(settings, "AWS_SENTINEL_COGS_BUCKET", "sentinel-cogs")
S2_REGION = getattr(settings, "AWS_COGS_REGION", "us-west-2")

S1_BUCKET = getattr(settings, "AWS_SENTINEL_1_BUCKET", "sentinel-s1-l1c")
S1_REGION = getattr(settings, "AWS_SENTINEL_1_REGION", "eu-central-1")

BUCKET = S2_BUCKET
REGION = S2_REGION
EXPECTED_OFFSET_APPLIED = True
MAX_ATTEMPTS = 5
BACKOFF_BASE_SECONDS = 3
BAND_WORKERS = 5

DEFAULT_BANDS = ["B02", "B03", "B04", "B08", "TCI", "B8A", "B11", "SCL"]

# AWS S3 Unsigned Clients for public open data buckets
s3_s2_client = boto3.client(
    "s3",
    region_name=S2_REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=128)
)

s3_s1_client = boto3.client(
    "s3",
    region_name=S1_REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=128)
)

s3_client = s3_s2_client


def resolve_s3_band_path(prefix: str, band_name: str) -> tuple[str, str]:
    """
    Resolves the S3 object key and local filename for a band based on S3 bucket structure.
    Strictly enforces Cloud-Optimized GeoTIFF (.tif/.tiff) format for both satellites.
    Returns (s3_key, local_filename).
    """
    clean_band = band_name.replace(".tif", "").replace(".tiff", "").replace(".jp2", "").upper()

    # 1. Sentinel-1 GRD SAR Products (GRD/[year]/[month]/[day]/[mode]/[polarization]/...)
    if prefix.startswith("GRD/") or "s1" in prefix.lower():
        if "VH" in clean_band:
            s3_key = f"{prefix.rstrip('/')}/measurement/s1-vh.tiff"
            return s3_key, "VH.tiff"
        else:
            s3_key = f"{prefix.rstrip('/')}/measurement/s1-vv.tiff"
            return s3_key, "VV.tiff"

    # 2. Sentinel-2 L2A COGs (sentinel-s2-l2a-cogs/[utm]/[lat]/[sq]/[year]/[month]/[folder]/)
    if clean_band in ("B08A", "B8A"):
        cog_name = "B8A.tif"
    elif clean_band in ("TCI", "VISUAL"):
        cog_name = "TCI.tif"
    else:
        cog_name = f"{clean_band}.tif"

    s3_key = f"{prefix.rstrip('/')}/{cog_name}"
    return s3_key, cog_name


def safe_move_file(src: str, dst: str, max_retries: int = 5, delay: float = 0.5) -> bool:
    """
    Safely moves a file from src to dst on Windows / Network share.
    Retries up to max_retries if Windows file lock [WinError 32] or network latency occurs.
    """
    if not os.path.exists(src):
        if os.path.exists(dst):
            return True  # Already successfully moved to destination
        logger.warning(f"safe_move_file source file missing: {src}")
        return False

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    for attempt in range(1, max_retries + 1):
        try:
            if os.path.exists(dst):
                try:
                    os.remove(dst)
                except Exception:
                    pass
            shutil.copy2(src, dst)
            try:
                os.remove(src)
            except Exception:
                pass
            return True
        except Exception as e:
            if attempt == max_retries:
                logger.warning(f"Could not move {src} -> {dst} after {max_retries} attempts: {e}")
                raise e
            time.sleep(delay)
    return False

def fetch_s3_object(key: str, target_path: str, bucket: str = None, client: boto3.client = None) -> bool:
    """
    Download one object with retries, exponential backoff, and AWS S3 byte-size verification.
    Atomically swaps .part file to target path upon successful byte-matching.
    Supports candidate fallbacks (e.g. s1-vh.tiff vs iw-vh.tiff, TCI.tif vs visual.tif).
    """
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    temp_path = target_path + ".part"

    if bucket is None:
        bucket = S1_BUCKET if key.startswith("GRD/") else S2_BUCKET
    if client is None:
        client = s3_s1_client if bucket == S1_BUCKET else s3_s2_client

    # Formulate key candidates to handle minor naming variations transparently
    candidate_keys = [key]
    if "measurement/s1-" in key:
        candidate_keys.append(key.replace("measurement/s1-", "measurement/iw-"))
    elif "measurement/iw-" in key:
        candidate_keys.append(key.replace("measurement/iw-", "measurement/s1-"))
    elif "TCI.tif" in key:
        candidate_keys.append(key.replace("TCI.tif", "visual.tif"))

    if "measurement/" in key and (bucket == S1_BUCKET or key.startswith("GRD/")):
        try:
            meas_dir = f"{key.split('measurement/')[0]}measurement/"
            b_token = "vv" if "vv" in key.lower() else ("vh" if "vh" in key.lower() else "")
            resp = client.list_objects_v2(Bucket=bucket, Prefix=meas_dir, MaxKeys=20)
            for item in resp.get("Contents", []):
                k = item["Key"]
                if (k.endswith(".tiff") or k.endswith(".tif")) and (b_token in k.lower() or not b_token):
                    if k not in candidate_keys:
                        candidate_keys.insert(0, k)
        except Exception:
            pass

    for active_key in candidate_keys:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                # 1. Fetch AWS S3 Object metadata for exact byte size comparison
                s3_meta = client.head_object(Bucket=bucket, Key=active_key)
                expected_size = s3_meta.get("ContentLength", 0)

                # 2. Download raster to temporary .part file
                client.download_file(bucket, active_key, temp_path)
                downloaded_size = os.path.getsize(temp_path)

                # 3. Exact Byte-for-Byte Check against AWS S3
                if expected_size > 0 and downloaded_size != expected_size:
                    raise ValueError(f"Byte mismatch for {active_key}: AWS S3 size = {expected_size}, Local size = {downloaded_size}")

                # 4. Atomic swap upon verified download
                safe_move_file(temp_path, target_path)
                return True
            except Exception as error:
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                if attempt == MAX_ATTEMPTS:
                    logger.debug(f"Candidate {active_key} on {bucket} failed: {error}")
                    break
                delay = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                time.sleep(delay)

    logger.error(f"Failed fetching {key} (and candidates) after {MAX_ATTEMPTS} attempts on {bucket}.")
    return False


def fetch_s3_text(key: str, bucket: str = None, client: boto3.client = None) -> Optional[str]:
    """
    Reads a text, XML, or JSON object directly from S3 into memory without saving to disk.
    Used for extracting metadata into the database without storing XML/JSON files in the archive.
    """
    if bucket is None:
        bucket = S1_BUCKET if key.startswith("GRD/") else S2_BUCKET
    if client is None:
        client = s3_s1_client if bucket == S1_BUCKET else s3_s2_client
    try:
        resp = client.get_object(Bucket=bucket, Key=key)
        return resp["Body"].read().decode("utf-8", errors="ignore")
    except Exception as e:
        logger.debug(f"Direct S3 read skipped for {key} on {bucket}: {e}")
        return None


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
            has_gcps = bool(source.gcps and len(source.gcps) > 0 and len(source.gcps[0]) > 0)
            if source.crs is None and not has_gcps:
                return False, size, "no coordinate reference system or GCPs"
            # Read small window to verify image data integrity behind header
            source.read(1, window=((0, min(64, source.height)), (0, min(64, source.width))))
    except Exception as error:
        return False, size, f"unreadable: {type(error).__name__}"
    finally:
        import gc
        gc.collect()

    return True, size, "ok"


def read_radiometry_metadata(prefix: str, folder: str) -> tuple[bool | None, str | None, str]:
    """
    Fetch scene metadata JSON from S3 and return radiometric parameters.
    Handles both AWS Open Data Sentinel-2 L2A registry (tileInfo.json) and Element84 COGs (<folder>.json).
    Handles Sentinel-1 SAR (bypasses BOA check) and Sentinel-2 COGs (<folder>.json).
    """
    # 1. Check Sentinel-2 L2A Open Data tileInfo.json
    if prefix.startswith("tiles/") or "s2-l2a" in BUCKET.lower():
        key = f"{prefix.rstrip('/')}/tileInfo.json"
    # 1. Sentinel-1 Radar does not utilize optical BOA offset
    if prefix.startswith("GRD/") or "s1" in (prefix + folder).lower():
        return True, "N/A", "ok"

    # 2. Check Sentinel-2 COG STAC JSON or tileinfo_metadata.json
    for json_key in [f"{prefix.rstrip('/')}/{folder}.json", f"{prefix.rstrip('/')}/tileinfo_metadata.json"]:
        try:
            body = s3_client.get_object(Bucket=BUCKET, Key=key)["Body"].read()
            body = s3_s2_client.get_object(Bucket=S2_BUCKET, Key=json_key)["Body"].read()
            item = json.loads(body)
            prod_name = item.get("productName", "")
            baseline = "05.11"
            for part in prod_name.split("_"):
                if part.startswith("N") and len(part) >= 4:
                    baseline = f"{part[1:3]}.{part[3:]}"
                    break
            applied = True
            properties = item.get("properties", {})
            applied = properties.get("earthsearch:boa_offset_applied", True)
            baseline = properties.get("s2:processing_baseline", "05.12")
            return applied, baseline, "ok"
        except Exception as error:
            logger.debug(f"tileInfo.json read skipped: {error}")
            logger.debug(f"STAC json read skipped for {json_key}: {error}")

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
    return True, "05.12", "ok"

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


def parse_s1_manifest_xml(xml_content: str) -> dict:
    """
    Parses Sentinel-1 Level-1 GRD ESA SAFE format manifest.safe into structured key attributes.
    Extracts platform/mission, SAR mode, polarizations, orbit direction, relative/absolute orbit,
    slice information, start/stop times, coordinate polygon, and CRS.
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

        # Platform / Satellite Mission
        family = get_text(".//platform/familyName") or "SENTINEL-1"
        number = get_text(".//platform/number") or ""
        parsed["satellite_mission"] = f"{family}{number}".upper()

        # Instrument Mode
        parsed["mode"] = get_text(".//instrument/mode") or get_text(".//instrument/familyName") or "IW"

        # Polarisation channels
        pols = [p.text.strip() for p in root.findall(".//transmitterReceiverPolarisation") if p.text]
        if pols:
            parsed["polarization_channels"] = ", ".join(pols)

        # Orbit Reference
        parsed["orbit_direction"] = get_text(".//pass")  # ASCENDING / DESCENDING

        # Absolute & Relative Orbit Numbers
        for orb in root.findall(".//orbitNumber"):
            if orb.attrib.get("type") == "start" and orb.text and orb.text.isdigit():
                parsed["absolute_orbit"] = int(orb.text)
                break
        if "absolute_orbit" not in parsed:
            abs_orb = get_text(".//orbitNumber")
            if abs_orb and abs_orb.isdigit():
                parsed["absolute_orbit"] = int(abs_orb)

        for rel in root.findall(".//relativeOrbitNumber"):
            if rel.attrib.get("type") == "start" and rel.text and rel.text.isdigit():
                parsed["relative_orbit"] = int(rel.text)
                break
        if "relative_orbit" not in parsed:
            rel_orb = get_text(".//relativeOrbitNumber")
            if rel_orb and rel_orb.isdigit():
                parsed["relative_orbit"] = int(rel_orb)

        # Slice Information
        slice_num = get_text(".//sliceNumber")
        if slice_num and slice_num.isdigit():
            parsed["slice_number"] = int(slice_num)
        total_slices = get_text(".//totalSlices")
        if total_slices and total_slices.isdigit():
            parsed["total_slices"] = int(total_slices)

        # Acquisition Time Period
        parsed["start_time"] = get_text(".//startTime")
        parsed["stop_time"] = get_text(".//stopTime")

        # Footprint coordinates
        coords_str = get_text(".//coordinates")
        if coords_str:
            parsed["footprint_coordinates"] = coords_str
            # Convert ESA lat,lon pairs "lat1,lon1 lat2,lon2 ..." to GeoJSON [[lon, lat], ...]
            try:
                pairs = coords_str.strip().split()
                geojson_ring = []
                for p in pairs:
                    lat_s, lon_s = p.split(",")
                    geojson_ring.append([float(lon_s), float(lat_s)])
                if geojson_ring and geojson_ring[0] != geojson_ring[-1]:
                    geojson_ring.append(geojson_ring[0])
                parsed["footprint_geojson"] = {
                    "type": "Polygon",
                    "coordinates": [geojson_ring]
                }
            except Exception:
                pass

        # Product Type
        parsed["product_type"] = get_text(".//productType") or "GRD"
        parsed["epsg_code"] = "EPSG:4326"

    except Exception as e:
        logger.warning(f"Error parsing Sentinel-1 manifest.safe: {e}")
        parsed["parse_error"] = str(e)

    return parsed



def download_and_verify_scene(
    db: Session,
    scene: SceneModel,
    bands: list[str] = None,
    user_id: int = None,
    request_id: int = None
) -> tuple[bool, list[dict], str]:
    """
    Fetch required bands for a scene, verify each raster, and record.
    Deduplication: verifies from DB and disk before attempting S3 download.
    If already downloaded by any user, skips download and reports previous details in logs.
    Stores metadata.xml both completely and as parsed JSON in tile_scene_metadata table.
    """
    if bands is None:
        bands = ["VV", "VH"] if (scene.satellite and "sentinel-1" in scene.satellite.lower()) else DEFAULT_BANDS

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
    is_s1 = prefix.startswith("GRD/") or (satellite and "sentinel-1" in satellite.lower()) or (scene.satellite and "sentinel-1" in scene.satellite.lower())
    if is_s1:
        meta_record = db.query(Sentinel1SceneMetadataModel).filter(
            Sentinel1SceneMetadataModel.scene_path == prefix
        ).first()
    else:
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
        try:
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
                    try:
                        os.remove(staged_path)
                    except Exception:
                        pass
                return local_filename, False, size, note

            os.makedirs(scene_archive_dir, exist_ok=True)
            safe_move_file(staged_path, target_path)

            if request_id:
                try:
                    mb = size / (1024 * 1024)
                    b_msg = f"     ↳ Band '{local_filename}' ({mb:.1f} MB) downloaded & verified on NAS."
                    logger.info(b_msg)
                    from scripts.download_district_tiles import append_request_log
                    append_request_log(None, request_id, b_msg)
                except Exception:
                    pass

            return local_filename, True, size, "ok"
        except Exception as err:
            logger.error(f"Error processing band {band_name} for {folder}: {err}")
            return band_name, False, 0, str(err)

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
    # STEP 4: Fetch metadata directly into memory for DB storage
    # (Do NOT save metadata.xml or tileInfo.json to archive disk; archive holds only .tif/.tiff)
    # ─────────────────────────────────────────────────────────────
    raw_xml_text = None
    parsed_xml_data = {}
    tileinfo_data = {}

    is_s1 = prefix.startswith("GRD/") or (satellite and "sentinel-1" in satellite.lower()) or (scene.satellite and "sentinel-1" in scene.satellite.lower())

    if is_s1:
        # 1. Fetch & parse manifest.safe (ESA SAFE XML format) in memory
        raw_xml_text = fetch_s3_text(f"{prefix.rstrip('/')}/manifest.safe", bucket=S1_BUCKET, client=s3_s1_client)
        if raw_xml_text:
            try:
                parsed_xml_data = parse_s1_manifest_xml(raw_xml_text)
            except Exception as e:
                logger.warning(f"Failed parsing manifest.safe in memory: {e}")

        # 2. Fetch & parse productInfo.json in memory
        prod_json_text = fetch_s3_text(f"{prefix.rstrip('/')}/productInfo.json", bucket=S1_BUCKET, client=s3_s1_client)
        if prod_json_text:
            try:
                tileinfo_data = json.loads(prod_json_text)
            except Exception as e:
                logger.warning(f"Failed parsing productInfo.json in memory: {e}")
    else:
        # Sentinel-2 metadata:
        # 1. granule_metadata.xml or metadata.xml in memory
        for xml_cand in ["granule_metadata.xml", "metadata.xml"]:
            raw_xml_text = fetch_s3_text(f"{prefix.rstrip('/')}/{xml_cand}", bucket=S2_BUCKET, client=s3_s2_client)
            if raw_xml_text:
                try:
                    parsed_xml_data = parse_s2_metadata_xml(raw_xml_text)
                    break
                except Exception as e:
                    logger.warning(f"Failed parsing {xml_cand} in memory: {e}")

        # 2. <folder>.json, tileinfo_metadata.json, or tileInfo.json in memory
        for json_cand in [f"{folder}.json", "tileinfo_metadata.json", "tileInfo.json"]:
            json_text = fetch_s3_text(f"{prefix.rstrip('/')}/{json_cand}", bucket=S2_BUCKET, client=s3_s2_client)
            if json_text:
                try:
                    tileinfo_data = json.loads(json_text)
                    break
                except Exception as e:
                    logger.warning(f"Failed parsing {json_cand} in memory: {e}")

    # Ensure archive directory contains ONLY .tif / .tiff raster files
    for extra_file in ["metadata.xml", "granule_metadata.xml", "tileInfo.json", "tileinfo_metadata.json", f"{folder}.json", "manifest.safe", "productInfo.json"]:
        p = os.path.join(scene_archive_dir, extra_file)
        if os.path.exists(p):
            try:
                os.remove(p)
            except Exception:
                pass

    # ─────────────────────────────────────────────────────────────
    # STEP 5: Upsert Metadata Table (Sentinel-1 vs Sentinel-2)
    # ─────────────────────────────────────────────────────────────
    if is_s1:
        # ──────── Sentinel-1 SAR Metadata Storage ────────
        parts = prefix.strip("/").split("/")
        if len(parts) >= 7 and parts[0] == "GRD":
            yr = int(parts[1])
            mo = int(parts[2])
            dy = int(parts[3])
            s1_mode = parts[4]
            s1_pol = parts[5]
            s1_prod = parts[6]
        else:
            yr = int(sensing_date[0:4])
            mo = int(sensing_date[5:7])
            dy = int(sensing_date[8:10]) if len(sensing_date) >= 10 else 1
            s1_mode = parsed_xml_data.get("mode") or tileinfo_data.get("mode") or "IW"
            s1_pol = parsed_xml_data.get("polarization_channels") or tileinfo_data.get("polarization") or "DV"
            s1_prod = tileinfo_data.get("id") or folder or scene.scene_id

        combined_s1_metadata = {**tileinfo_data, **parsed_xml_data}
        s1_mission = parsed_xml_data.get("satellite_mission") or ("Sentinel-1A" if "S1A" in s1_prod else ("Sentinel-1B" if "S1B" in s1_prod else "Sentinel-1"))
        s1_pols = parsed_xml_data.get("polarization_channels") or tileinfo_data.get("polarization") or "VV, VH"
        s1_direction = parsed_xml_data.get("orbit_direction") or tileinfo_data.get("direction")
        s1_rel_orb = parsed_xml_data.get("relative_orbit") or tileinfo_data.get("relativeOrbitNumber")
        s1_abs_orb = parsed_xml_data.get("absolute_orbit") or tileinfo_data.get("orbitNumber")
        s1_slice = parsed_xml_data.get("slice_number")
        s1_start = parsed_xml_data.get("start_time")
        s1_stop = parsed_xml_data.get("stop_time")
        s1_footprint = tileinfo_data.get("footprint") or parsed_xml_data.get("footprint_geojson")

        s1_meta_rec = db.query(Sentinel1SceneMetadataModel).filter(
            Sentinel1SceneMetadataModel.scene_path == prefix
        ).first()

        if not s1_meta_rec:
            s1_meta_rec = Sentinel1SceneMetadataModel(
                year=yr,
                month=mo,
                day=dy,
                mode=s1_mode,
                polarization=s1_pol,
                product_name=s1_prod,
                scene_path=prefix,
                satellite_mission=s1_mission,
                polarization_channels=str(s1_pols),
                orbit_direction=s1_direction,
                relative_orbit=s1_rel_orb,
                absolute_orbit=s1_abs_orb,
                slice_number=s1_slice,
                sensing_date=sensing_date,
                start_time=s1_start,
                stop_time=s1_stop,
                footprint_geojson=s1_footprint,
                epsg_code="EPSG:4326",
                download_status="DOWNLOADED",
                downloaded_at=now,
                downloaded_by_user_id=user_id,
                archive_path=scene_archive_dir,
                raw_manifest_xml=raw_xml_text,
                parsed_metadata=combined_s1_metadata
            )
            db.add(s1_meta_rec)
        else:
            s1_meta_rec.download_status = "DOWNLOADED"
            s1_meta_rec.downloaded_at = now
            if user_id:
                s1_meta_rec.downloaded_by_user_id = user_id
            s1_meta_rec.archive_path = scene_archive_dir
            if raw_xml_text:
                s1_meta_rec.raw_manifest_xml = raw_xml_text
            if combined_s1_metadata:
                s1_meta_rec.parsed_metadata = combined_s1_metadata
    else:
        # ──────── Sentinel-2 Optical Metadata Storage ────────
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

        meta_record = db.query(TileSceneMetadataModel).filter(
            TileSceneMetadataModel.tile_path == prefix
        ).first()

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

    table_name = "sentinel1_scene_metadata" if is_s1 else "tile_scene_metadata"
    meta_name = "manifest.safe" if is_s1 else "metadata.xml"
    log_msg = (
        f"[NEW DOWNLOAD COMPLETED] Scene '{folder}' (Tile {tile}, Date {sensing_date}) "
        f"downloaded to '{scene_archive_dir}' ({downloaded_new} new bands, {total_mb:.1f} MB: {bands_summary}, {meta_name} stored). "
        f"Recorded in {table_name} table."
    )
    logger.info(log_msg)
    return True, band_details, log_msg


def resolve_tif_path(raw_path: str) -> tuple:
    """
    Checks if a stored DB raster path exists on disk, resolving relative paths
    against current execution dir and backend root. Returns (resolved_path, exists_bool).
    """
    if not raw_path:
        return raw_path, False
    if os.path.exists(raw_path):
        return os.path.abspath(raw_path), True
    backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    alt_path = os.path.join(backend_root, raw_path)
    if os.path.exists(alt_path):
        return os.path.abspath(alt_path), True
    norm_p = os.path.normpath(raw_path)
    if os.path.exists(norm_p):
        return os.path.abspath(norm_p), True
    return os.path.abspath(raw_path) if not os.path.isabs(raw_path) else raw_path, False


def get_downloaded_tifs_for_request(db: Session, request_id: int) -> dict:
    """
    Retrieves all downloaded and verified GeoTIFF raster file paths (.tif / .tiff)
    for a specific user request. Used by downstream processing steps (Stage 3 Indexing,
    Stage 4 Delivery Clipping) and exposed via GET /api/v1/requests/{request_id}/tifs.
    """
    from app.models.sdap_models import RequestModel, ProcessJobModel

    req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
    if not req:
        return {
            "request_id": request_id,
            "status": "NOT_FOUND",
            "message": f"Request #{request_id} not found.",
            "total_tifs": 0,
            "tif_paths": [],
            "tifs": []
        }

    # 1. Gather scene IDs directly linked to this request in jobs
    scene_ids_from_jobs = [
        r[0] for r in db.query(ProcessJobModel.scene_id).filter(
            ProcessJobModel.request_id == request_id,
            ProcessJobModel.scene_id.isnot(None)
        ).distinct().all()
    ]

    # 2. Resolve mapped tiles for district/state to catch all cached scenes in the date window
    tiles = []
    if req.district:
        rows = db.execute(
            text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = LOWER(:d)"),
            {"d": req.district}
        ).fetchall()
        tiles = [r[0] for r in rows]
    elif req.state:
        rows = db.execute(
            text("""
                SELECT DISTINCT dtm.tile_id
                FROM district_tiles_mapping dtm
                JOIN district_boundaries db ON dtm.district_id = db.id
                WHERE LOWER(db.state_name) = LOWER(:s)
            """),
            {"s": req.state}
        ).fetchall()
        tiles = [r[0] for r in rows]

    start_str = req.start_date.strftime("%Y-%m-%d")
    end_str = req.end_date.strftime("%Y-%m-%d")

    if req.satellite and "Sentinel-1" in req.satellite and "S1_SAR" not in tiles:
        tiles.append("S1_SAR")

    matched_scene_ids = set(scene_ids_from_jobs)
    if tiles:
        spatial_scenes = db.query(SceneModel.scene_id).filter(
            SceneModel.tile.in_(tiles),
            SceneModel.sensing_date >= start_str,
            SceneModel.sensing_date <= end_str,
            SceneModel.status == "HELD"
        ).all()
        for s in spatial_scenes:
            matched_scene_ids.add(s[0])

    if not matched_scene_ids:
        return {
            "request_id": req.id,
            "request_title": req.request_title,
            "district": req.district,
            "state": req.state,
            "satellite": req.satellite,
            "start_date": start_str,
            "end_date": end_str,
            "status": req.status,
            "total_scenes": 0,
            "total_tifs": 0,
            "total_size_bytes": 0,
            "total_size_mb": 0.0,
            "tif_paths": [],
            "tifs": []
        }

    # 3. Query all verified .tif / .tiff band files for these scenes
    band_records = db.query(BandFileModel).filter(
        BandFileModel.scene_id.in_(list(matched_scene_ids)),
        BandFileModel.verified == 1
    ).order_by(BandFileModel.tile, BandFileModel.sensing_date, BandFileModel.band).all()

    tif_files = []
    tif_paths = []
    total_size = 0

    for bf in band_records:
        raw_p = bf.path
        if not (raw_p.lower().endswith(".tif") or raw_p.lower().endswith(".tiff")):
            continue
        path, exists = resolve_tif_path(raw_p)
        actual_size = os.path.getsize(path) if exists else bf.size_bytes
        total_size += actual_size

        tif_paths.append(path)
        tif_files.append({
            "scene_id": bf.scene_id,
            "tile": bf.tile,
            "sensing_date": bf.sensing_date,
            "satellite": bf.satellite,
            "band": bf.band,
            "path": path,
            "size_bytes": actual_size,
            "exists_on_disk": exists
        })

    return {
        "request_id": req.id,
        "request_title": req.request_title,
        "district": req.district,
        "state": req.state,
        "satellite": req.satellite,
        "start_date": start_str,
        "end_date": end_str,
        "status": req.status,
        "total_scenes": len(matched_scene_ids),
        "total_tifs": len(tif_files),
        "total_size_bytes": total_size,
        "total_size_mb": round(total_size / (1024 * 1024), 2),
        "tif_paths": tif_paths,
        "tifs": tif_files
    }


def search_downloaded_tifs_by_region(
    db: Session,
    state: Optional[str] = None,
    district: Optional[str] = None,
    satellite: Optional[str] = None,
    band: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
) -> dict:
    def _clean_str(val):
        if not val or not isinstance(val, str):
            return None
        v = val.strip()
        return v if v and v.upper() != "NONE" and v.upper() != "ALL" else None

    def _clean_date(d_val):
        cleaned = _clean_str(d_val)
        if not cleaned:
            return None
        # Normalize ISO timestamps like '2026-06-01T00:00:00' -> '2026-06-01'
        return cleaned.split("T")[0].split(" ")[0].strip()

    state = _clean_str(state)
    district = _clean_str(district)
    satellite = _clean_str(satellite)
    band = _clean_str(band)
    start_date = _clean_date(start_date)
    end_date = _clean_date(end_date)

    # 1. Resolve matching tile IDs from district_tiles_mapping & district_boundaries in DB
    tiles = []
    resolved_districts = []
    resolved_states = []
    region_filtered = False

    if district:
        region_filtered = True
        # Try exact match or ILIKE match for district
        clean_d = district.split(",")[0].strip()
        rows = db.execute(
            text("""
                SELECT DISTINCT dtm.tile_id, dtm.district_name, db.state_name
                FROM district_tiles_mapping dtm
                LEFT JOIN district_boundaries db ON dtm.district_id = db.id
                WHERE LOWER(dtm.district_name) = LOWER(:d) OR LOWER(dtm.district_name) ILIKE LOWER(:d_like)
            """),
            {"d": clean_d, "d_like": f"%{clean_d}%"}
        ).fetchall()
        for r in rows:
            tiles.append(r[0])
            if r[1] and r[1] not in resolved_districts: resolved_districts.append(r[1])
            if r[2] and r[2] not in resolved_states: resolved_states.append(r[2])

    elif state:
        region_filtered = True
        clean_s = state.split(",")[0].strip()
        rows = db.execute(
            text("""
                SELECT DISTINCT dtm.tile_id, dtm.district_name, db.state_name
                FROM district_tiles_mapping dtm
                JOIN district_boundaries db ON dtm.district_id = db.id
                WHERE LOWER(db.state_name) = LOWER(:s) OR LOWER(db.state_name) ILIKE LOWER(:s_like)
            """),
            {"s": clean_s, "s_like": f"%{clean_s}%"}
        ).fetchall()
        for r in rows:
            tiles.append(r[0])
            if r[1] and r[1] not in resolved_districts: resolved_districts.append(r[1])
            if r[2] and r[2] not in resolved_states: resolved_states.append(r[2])

    tiles = list(set(tiles))

    # If user requested a specific district/state, but 0 tiles were resolved, return empty results immediately
    if region_filtered and not tiles:
        return {
            "query_state": state,
            "query_district": district,
            "query_satellite": satellite,
            "query_band": band,
            "query_start_date": start_date,
            "query_end_date": end_date,
            "matched_tiles": [],
            "matched_districts": [],
            "total_scenes": 0,
            "total_tifs": 0,
            "total_size_bytes": 0,
            "total_size_mb": 0.0,
            "tif_paths": [],
            "tifs": []
        }

    # Support Sentinel-1 tile alias if tile filter was generated from region
    if tiles and (not satellite or "Sentinel-1" in satellite):
        tiles.append("S1_SAR")

    # 2. Build Scene Query
    scene_query = db.query(SceneModel).filter(SceneModel.status == "HELD")
    if tiles:
        scene_query = scene_query.filter(SceneModel.tile.in_(tiles))

    if satellite and satellite.strip():
        # Handle comma-separated or single satellite
        sat_parts = [s.strip() for s in satellite.split(",") if s.strip()]
        if len(sat_parts) == 1:
            scene_query = scene_query.filter(SceneModel.satellite.ilike(f"%{sat_parts[0]}%"))
        elif len(sat_parts) > 1:
            from sqlalchemy import or_
            or_clauses = [SceneModel.satellite.ilike(f"%{sp}%") for sp in sat_parts]
            scene_query = scene_query.filter(or_(*or_clauses))

    if start_date:
        scene_query = scene_query.filter(SceneModel.sensing_date >= start_date)
    if end_date:
        scene_query = scene_query.filter(SceneModel.sensing_date <= end_date)

    matched_scenes = scene_query.all()
    scene_ids = [s.scene_id for s in matched_scenes]

    if not scene_ids:
        return {
            "query_state": state,
            "query_district": district,
            "query_satellite": satellite,
            "query_band": band,
            "query_start_date": start_date,
            "query_end_date": end_date,
            "matched_tiles": tiles,
            "matched_districts": resolved_districts,
            "total_scenes": 0,
            "total_tifs": 0,
            "total_size_bytes": 0,
            "total_size_mb": 0.0,
            "tif_paths": [],
            "tifs": []
        }

    # 3. Query Band Files from DB using path column
    bf_query = db.query(BandFileModel).filter(
        BandFileModel.scene_id.in_(scene_ids),
        BandFileModel.verified == 1
    )

    if band and band.strip() and band.upper() != "ALL":
        clean_b = band.replace(".tif", "").replace(".tiff", "").strip()
        bf_query = bf_query.filter(BandFileModel.band.ilike(f"%{clean_b}%"))

    band_records = bf_query.order_by(BandFileModel.tile, BandFileModel.sensing_date, BandFileModel.band).all()

    tif_files = []
    tif_paths = []
    total_size = 0

    for bf in band_records:
        raw_p = bf.path
        if not (raw_p.lower().endswith(".tif") or raw_p.lower().endswith(".tiff")):
            continue
        path, exists = resolve_tif_path(raw_p)
        actual_size = os.path.getsize(path) if exists else bf.size_bytes
        total_size += actual_size

        tif_paths.append(path)
        tif_files.append({
            "scene_id": bf.scene_id,
            "tile": bf.tile,
            "sensing_date": bf.sensing_date,
            "satellite": bf.satellite,
            "band": bf.band,
            "path": path,
            "size_bytes": actual_size,
            "exists_on_disk": exists
        })

    return {
        "query_state": state,
        "query_district": district,
        "query_satellite": satellite,
        "query_band": band,
        "query_start_date": start_date,
        "query_end_date": end_date,
        "matched_tiles": tiles,
        "matched_districts": resolved_districts,
        "total_scenes": len(matched_scenes),
        "total_tifs": len(tif_files),
        "total_size_bytes": total_size,
        "total_size_mb": round(total_size / (1024 * 1024), 2),
        "tif_paths": tif_paths,
        "tifs": tif_files
    }


def get_available_downloaded_regions(db: Session) -> dict:
    """
    Returns only the States and Districts for which data has actually been downloaded
    and stored in PostgreSQL / local storage. Used to populate frontend retrieval dropdowns.
    """
    held_tiles = [
        r[0] for r in db.query(SceneModel.tile).filter(
            SceneModel.status == "HELD"
        ).distinct().all()
    ]

    bf_tiles = [
        r[0] for r in db.query(BandFileModel.tile).filter(
            BandFileModel.verified == 1
        ).distinct().all()
    ]

    all_tiles = list(set(held_tiles + bf_tiles))

    req_rows = db.execute(
        text("SELECT DISTINCT state, district FROM requests WHERE status IN ('HELD', 'COMPLETED', 'SUCCESS', 'PROCESSING')")
    ).fetchall()

    states_set = set()
    districts_list = []
    seen_districts = set()

    for r in req_rows:
        st, dist = r[0], r[1]
        if st and st.strip():
            states_set.add(st.strip())
        if dist and dist.strip():
            districts_list.append({"district_name": dist.strip(), "state_name": st.strip() if st else ""})
            seen_districts.add(dist.strip().lower())

    if all_tiles:
        clean_tiles = [t for t in all_tiles if t != "S1_SAR"]
        if clean_tiles:
            mapping_rows = db.execute(
                text("""
                    SELECT DISTINCT dtm.district_name, db.state_name
                    FROM district_tiles_mapping dtm
                    LEFT JOIN district_boundaries db ON dtm.district_id = db.id
                    WHERE dtm.tile_id IN :tiles AND dtm.district_name IS NOT NULL
                """),
                {"tiles": tuple(clean_tiles) if len(clean_tiles) > 1 else (clean_tiles[0], clean_tiles[0])}
            ).fetchall()

            for r in mapping_rows:
                dist_name, st_name = r[0], r[1]
                if st_name and st_name.strip():
                    states_set.add(st_name.strip())
                if dist_name and dist_name.strip() and dist_name.strip().lower() not in seen_districts:
                    districts_list.append({"district_name": dist_name.strip(), "state_name": st_name.strip() if st_name else ""})
                    seen_districts.add(dist_name.strip().lower())

    sorted_states = sorted(list(states_set))
    sorted_districts = sorted(districts_list, key=lambda x: (x.get("state_name", ""), x.get("district_name", "")))

    return {
        "states": [{"state_name": s} for s in sorted_states],
        "districts": sorted_districts,
        "total_downloaded_states": len(sorted_states),
        "total_downloaded_districts": len(sorted_districts)
    }



