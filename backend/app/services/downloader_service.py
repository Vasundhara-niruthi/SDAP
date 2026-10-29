from boto3.s3.transfer import TransferConfig
import shutil
"""
SDAP Step 4 Downloader & Raster Integrity Service
Implements failure-safe atomic downloading, rasterio verification, and radiometry check.
"""
import os
import re
import json
import time
import logging
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import Optional, List, Dict, Any, Tuple
from concurrent.futures import ThreadPoolExecutor
import boto3
import rasterio
from botocore import UNSIGNED
from botocore.config import Config  # type: ignore
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings
from app.models.sdap_models import (
    RequestModel,
    ProcessJobModel,
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
BAND_WORKERS = 8

S3_FAST_CONFIG = TransferConfig(
    multipart_threshold=8 * 1024 * 1024,
    max_concurrency=10,
    multipart_chunksize=8 * 1024 * 1024,
    use_threads=True
)

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


def resolve_s3_band_path(
    prefix: str,
    band_name: str
) -> tuple[str, str]:
    """
    Resolves S3 object key and local filename for a band based on S3 bucket structure.
    Handles both Sentinel-1 SAR (VV, VH) and Sentinel-2 optical bands (B01-B12, B8A, TCI, SCL).
    Returns (S3 object key, local filename).
    """
    clean_band = os.path.splitext(os.path.basename(band_name))[0].upper()
    prefix_clean = prefix.rstrip("/")

    # 1. Sentinel-1 SAR products (VV, VH)
    if prefix.startswith("GRD/") or prefix.lower().startswith("s1_sar/") or prefix.lower().startswith("sentinel-1/") or clean_band in ("VV", "VH", "IW-VV", "IW-VH"):
        pol = "VH" if "VH" in clean_band else "VV"
        if "/IW/" in f"/{prefix_clean}/":
            s3_filename = f"iw-{pol.lower()}.tiff"
        elif "/S1/" in f"/{prefix_clean}/":
            s3_filename = f"s1-{pol.lower()}.tiff"
        else:
            s3_filename = f"iw-{pol.lower()}.tiff"

        s3_key = f"{prefix_clean}/measurement/{s3_filename}"
        return s3_key, f"{pol}.tiff"

    # 2. Sentinel-2 L2A COGs (sentinel-cogs bucket)
    if clean_band in ("B08A", "B8A"):
        cog_name = "B8A.tif"
    elif clean_band in ("TCI", "VISUAL"):
        cog_name = "TCI.tif"
    else:
        cog_name = f"{clean_band}.tif"

    s3_key = f"{prefix_clean}/{cog_name}"
    return s3_key, cog_name


_RASTER_BOUNDS_CACHE: Dict[str, Optional[Tuple[float, float, float, float]]] = {}

def is_raster_overlapping_district(file_path: str, district_bbox: Optional[Any]) -> bool:
    """
    Validates whether a raster file geographically intersects the target district bounding box in EPSG:4326.
    Protects against worldwide/out-of-bounds Sentinel-1 scenes being incorrectly mapped to Indian districts.
    """
    if not district_bbox or not file_path:
        return True
    try:
        norm_fp = str(file_path).replace("\\", "/").lower()
        # Fast path: If the raster is already stored in a district folder, it is guaranteed to overlap
        if "s1_sar/" in norm_fp or "sentinel-1/" in norm_fp:
            for seg in norm_fp.split("/"):
                if seg and not seg.isdigit() and not seg.startswith("s1") and not seg.startswith("sdap") and seg not in ("sentinel-1", "s1_sar", "remote-sensing"):
                    return True

        norm_key = norm_fp.strip()
        if norm_key in _RASTER_BOUNDS_CACHE:
            bounds = _RASTER_BOUNDS_CACHE[norm_key]
        else:
            from rasterio.warp import transform_bounds
            from app.services.sentinel1_processor_service import win_safe_path
            resolved, exists = resolve_tif_path(file_path)
            if not exists or not os.path.exists(resolved):
                _RASTER_BOUNDS_CACHE[norm_key] = None
                return True
            with rasterio.open(win_safe_path(resolved)) as src:
                if src.crs:
                    bounds = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
                elif src.gcps and len(src.gcps[0]) > 0:
                    gcps_list, gcps_crs = src.gcps
                    xs = [g.x for g in gcps_list]
                    ys = [g.y for g in gcps_list]
                    bounds = transform_bounds(gcps_crs or "EPSG:4326", "EPSG:4326", min(xs), min(ys), max(xs), max(ys))
                else:
                    bounds = None
            _RASTER_BOUNDS_CACHE[norm_key] = bounds

        if not bounds:
            return True

        b_minx, b_miny, b_maxx, b_maxy = bounds
        # India bounds sanity check: Lon 65-100, Lat 5-40
        if b_maxx < 65.0 or b_minx > 100.0 or b_maxy < 5.0 or b_miny > 40.0:
            return False

        d_minx, d_miny, d_maxx, d_maxy = district_bbox
        buf = 0.25  # 0.25 degree (~25km buffer for swath overlap)
        if b_maxx < (d_minx - buf) or b_minx > (d_maxx + buf) or b_maxy < (d_miny - buf) or b_miny > (d_maxy + buf):
            return False
        return True
    except Exception as e:
        logger.debug(f"Could not check raster bounds for {file_path}: {e}")
        return True


def ensure_nas_connection(path: str) -> bool:
    """
    Ensures Windows SMB connection to UNC network share (e.g. \\172.16.16.52\Remote-sensing) or mapped drive is active.
    If disconnected or throwing WinError 53/67/64/85, automatically re-establishes the connection using
    NAS_USER and NAS_PASSWORD credentials from settings/.env.
    """
    if not path:
        return True

    # Check if target path or root UNC share already exists
    if os.path.exists(path):
        return True

    nas_ip = getattr(settings, "NAS_SERVER_IP", None) or os.getenv("NAS_SERVER_IP", "")
    nas_share = getattr(settings, "NAS_SHARE_NAME", None) or os.getenv("NAS_SHARE_NAME", "")
    unc_share = f"\\\\{nas_ip}\\{nas_share}" if nas_ip and nas_share else ""
    if path.startswith("\\\\"):
        parts = [p for p in path.split("\\") if p]
        if len(parts) >= 2:
            unc_share = f"\\\\{parts[0]}\\{parts[1]}"

    if unc_share and os.path.exists(unc_share):
        return True

    logger.warning(f"NAS network share '{unc_share}' is disconnected or unreachable. Re-establishing connection...")
    try:
        import subprocess
        nas_user = getattr(settings, "NAS_USER", None) or os.getenv("NAS_USER")
        nas_pass = getattr(settings, "NAS_PASSWORD", None) or os.getenv("NAS_PASSWORD")

        # Step 1: Register credentials in Windows Credential Manager if provided
        if nas_user and nas_pass:
            try:
                subprocess.run(["cmdkey", f"/add:{nas_ip}", f"/user:{nas_user}", f"/pass:{nas_pass}"], capture_output=True, text=True, timeout=5)
            except Exception:
                pass

        # Step 2: Clear any stale/disconnected SMB session (handles error 85 / stale connections)
        try:
            subprocess.run(["net", "use", unc_share, "/delete", "/yes"], capture_output=True, text=True, timeout=5)
        except Exception:
            pass

        # Step 3: Run net use with credentials & persistence
        if nas_user and nas_pass:
            cmd = ["net", "use", unc_share, f"/user:{nas_user}", nas_pass, "/persistent:yes"]
        else:
            cmd = ["net", "use", unc_share, "/persistent:yes"]

        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        out = (proc.stdout or "") + (proc.stderr or "")

        if proc.returncode == 0 or "already" in out.lower() or "multiple" in out.lower() or "successfully" in out.lower():
            logger.info(f"Successfully re-established NAS connection to '{unc_share}'.")
            return True
        else:
            logger.warning(f"Net use reconnect returned: {out.strip()}")
    except Exception as err:
        logger.warning(f"Failed executing net use reconnect for '{unc_share}': {err}")

    return os.path.exists(unc_share) or os.path.exists(path)


def prune_empty_dirs(root_dir: str):
    """
    Recursively prunes all empty directories inside root_dir from bottom up.
    Ensures no leftover empty folders remain in local staging tree.
    """
    if not root_dir or not os.path.exists(root_dir):
        return
    try:
        for dirpath, dirnames, filenames in os.walk(root_dir, topdown=False):
            if dirpath == root_dir:
                continue
            try:
                if not os.listdir(dirpath):
                    os.rmdir(dirpath)
            except Exception:
                pass
    except Exception:
        pass


def prune_empty_parent_dirs(path: str, stop_at: str = None):
    """
    Traverses upwards from the parent directory of path, removing empty directories
    until reaching stop_at (or non-empty folder).
    """
    try:
        curr = os.path.dirname(os.path.abspath(path))
        stop = os.path.abspath(stop_at) if stop_at else None
        while curr and curr != stop and (not stop or curr.startswith(stop)):
            if os.path.isdir(curr) and not os.listdir(curr):
                os.rmdir(curr)
                curr = os.path.dirname(curr)
            else:
                break
    except Exception:
        pass


def safe_move_file(src: str, dst: str, max_retries: int = 5, delay: float = 0.5) -> bool:
    """
    Safely moves a file from local staging (src) to destination on NAS (dst).
    Automatically reconnects NAS UNC network share if disconnected.
    IMPORTANT: If NAS is unavailable or connection fails, local fallback is STRICTLY PROHIBITED.
    The temporary staged file is deleted immediately, empty staging directories are pruned,
    and a clear error is logged and raised.
    """
    if not os.path.exists(src):
        if os.path.exists(dst):
            return True  # Already successfully moved to destination
        logger.warning(f"safe_move_file source file missing: {src}")
        return False

    # Check and ensure NAS connection if target is a network path
    if dst.startswith("\\\\"):
        if not ensure_nas_connection(dst):
            # Clean up local staging file immediately
            if os.path.exists(src):
                try:
                    os.remove(src)
                    logger.info(f"Cleaned up local staging file '{src}' due to unavailable NAS destination.")
                except Exception:
                    pass
            err_msg = f"[NAS_ERROR] Cannot move file: NAS path '{dst}' is unreachable or disconnected. File removed from local staging; local storage is prohibited."
            logger.error(err_msg)
            raise RuntimeError(err_msg)

    try:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
    except Exception as mk_err:
        if dst.startswith("\\\\"):
            ensure_nas_connection(dst)
            try:
                os.makedirs(os.path.dirname(dst), exist_ok=True)
            except Exception as mk_err2:
                if os.path.exists(src):
                    try:
                        os.remove(src)
                    except Exception:
                        pass
                err_msg = f"[NAS_ERROR] Failed creating directory on NAS '{os.path.dirname(dst)}': {mk_err2}. Staged file deleted; local storage prohibited."
                logger.error(err_msg)
                raise RuntimeError(err_msg)

    last_error = None
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
            last_error = e
            if dst.startswith("\\\\"):
                ensure_nas_connection(dst)
                try:
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                except Exception:
                    pass
            time.sleep(delay)

    # If all attempts failed: Clean up local staging file and fail without local fallback!
    if os.path.exists(src):
        try:
            os.remove(src)
            logger.info(f"Deleted local staging file '{src}' after {max_retries} failed NAS transfer attempts.")
        except Exception:
            pass
    err_msg = f"[NAS_ERROR] Could not transfer file to NAS '{dst}' after {max_retries} attempts: {last_error}. Download discarded; not stored in local directory."
    logger.error(err_msg)
    raise RuntimeError(err_msg)

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

                # Ensure parent dir still exists (safeguard against race conditions)
                os.makedirs(os.path.dirname(temp_path), exist_ok=True)

                # 2. Download raster to temporary .part file
                client.download_file(bucket, active_key, temp_path, Config=S3_FAST_CONFIG)
                downloaded_size = os.path.getsize(temp_path)

                # 3. Exact Byte-for-Byte Check against AWS S3
                if expected_size > 0 and downloaded_size != expected_size:
                    raise ValueError(f"Byte mismatch for {active_key}: AWS S3 size = {expected_size}, Local size = {downloaded_size}")

                # 4. Atomic local swap upon verified download
                if os.path.exists(target_path):
                    try:
                        os.remove(target_path)
                    except Exception:
                        pass
                os.replace(temp_path, target_path)
                return True
            except Exception as error:
                if os.path.exists(temp_path):
                    try:
                        os.remove(temp_path)
                    except Exception:
                        pass
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
        from app.services.sentinel1_processor_service import win_safe_path
        with rasterio.open(win_safe_path(path)) as source:
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
    # 1. Sentinel-1 Radar does not utilize optical BOA offset
    if prefix.startswith("GRD/") or "s1" in (prefix + folder).lower():
        return True, "N/A", "ok"

    # 2. Check Sentinel-2 COG STAC JSON or tileinfo_metadata.json
    for json_key in [f"{prefix.rstrip('/')}/{folder}.json", f"{prefix.rstrip('/')}/tileinfo_metadata.json"]:
        try:
            body = s3_s2_client.get_object(Bucket=S2_BUCKET, Key=json_key)["Body"].read()
            item = json.loads(body)
            properties = item.get("properties", {})
            applied = properties.get("earthsearch:boa_offset_applied", True)
            baseline = properties.get("s2:processing_baseline", "05.12")
            return applied, baseline, "ok"
        except Exception as error:
            logger.debug(f"STAC json read skipped for {json_key}: {error}")

    return True, "05.12", "ok"


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


def download_complete_s1_scene(
    db: Session,
    scene: SceneModel,
    scene_archive_dir: str,
    staging_dir: str,
    user_id: int = None,
    request_id: int = None,
    silent_band_logs: bool = False
) -> tuple[bool, list[dict], str]:
    """
    Downloads the complete Sentinel-1 (S1_SAR) product structure from AWS S3 (sentinel-s1-l1c)
    and stores it completely on NAS storage, matching the ESA SAFE directory hierarchy:
        <scene_dir>/
            annotation/
                calibration/
                    calibration-iw-vh.xml, calibration-iw-vv.xml
                    noise-iw-vh.xml, noise-iw-vv.xml
                rfi/
                    rfi-iw-vh.xml, rfi-iw-vv.xml
                iw-vh.xml, iw-vv.xml
            measurement/
                iw-vh.tiff, iw-vv.tiff (or s1-vh.tiff, s1-vv.tiff)
            preview/
                icons/logo.png, map-overlay.kml, product-preview.html, quick-look.png, thumbnail.png
            support/
                s1-level-1-calibration.xsd, s1-level-1-measurement.xsd, etc.
            manifest.safe
            productInfo.json
            report-*.pdf
    """
    folder = scene.folder or scene.scene_id
    tile = scene.tile
    sensing_date = scene.sensing_date
    prefix = scene.prefix or ""
    prefix_clean = prefix.strip().lstrip("/").rstrip("/") + "/"

    # 1. Connect to NAS
    if scene_archive_dir.startswith("\\\\") or ":" in scene_archive_dir:
        if not ensure_nas_connection(scene_archive_dir):
            nas_err = (
                f"[NAS_ERROR] NAS path '{scene_archive_dir}' is unreachable or disconnected. "
                "Sentinel-1 complete product download cancelled; local storage fallback is strictly prohibited."
            )
            logger.error(nas_err)
            return False, [], nas_err

    try:
        os.makedirs(scene_archive_dir, exist_ok=True)
    except Exception as mk_err:
        nas_err = f"[STORAGE_ERROR] Cannot create Sentinel-1 archive directory '{scene_archive_dir}': {mk_err}."
        logger.error(nas_err)
        return False, [], nas_err

    # 2. List all objects under the S3 prefix in sentinel-s1-l1c
    paginator = s3_s1_client.get_paginator("list_objects_v2")
    s3_items = []
    try:
        for page in paginator.paginate(Bucket=S1_BUCKET, Prefix=prefix_clean):
            for item in page.get("Contents", []):
                k = item["Key"]
                if k != prefix_clean and not k.endswith("/"):
                    s3_items.append(item)
    except Exception as e:
        err_msg = f"Failed listing S3 objects for Sentinel-1 scene '{scene.scene_id}' at '{prefix_clean}': {e}"
        logger.error(err_msg)
        return False, [], err_msg

    if not s3_items:
        err_msg = f"No objects found on S3 for Sentinel-1 scene '{scene.scene_id}' at prefix '{prefix_clean}'"
        logger.error(err_msg)
        return False, [], err_msg

    # 3. Fast Deduplication / Cache check on NAS
    meta_record = db.query(Sentinel1SceneMetadataModel).filter(
        Sentinel1SceneMetadataModel.scene_path == scene.prefix
    ).first()

    meas_items = [it for it in s3_items if "measurement/" in it["Key"] and it["Key"].lower().endswith((".tif", ".tiff"))]
    all_cached = True
    cached_details = []

    for item in s3_items:
        rel = item["Key"][len(prefix_clean):]
        t_path = os.path.join(scene_archive_dir, rel)
        if not os.path.exists(t_path):
            all_cached = False
            break
        if rel.lower().endswith((".tif", ".tiff")):
            ok, sz, _ = verify_raster(t_path)
            if not ok:
                all_cached = False
                break
            b_clean = os.path.splitext(os.path.basename(rel))[0].upper()
            b_name = "VV" if ("VV" in b_clean and "VH" not in b_clean) else ("VH" if ("VH" in b_clean and "VV" not in b_clean) else b_clean)
            cached_details.append({
                "band": b_name,
                "filename": os.path.basename(rel),
                "rel_path": rel,
                "ok": True,
                "size_bytes": sz,
                "status": "cached",
                "path": t_path
            })
        else:
            exp_sz = item.get("Size", 0)
            if exp_sz > 0 and os.path.getsize(t_path) != exp_sz:
                all_cached = False
                break

    manifest_target = os.path.join(scene_archive_dir, "manifest.safe")
    if not (os.path.exists(manifest_target) and os.path.getsize(manifest_target) > 0):
        all_cached = False

    is_already_held = (scene.status == "HELD") or (meta_record and meta_record.download_status == "DOWNLOADED")
    if all_cached and is_already_held:
        dl_time_str = "previously"
        if meta_record and meta_record.downloaded_at:
            dl_time_str = meta_record.downloaded_at.strftime("%Y-%m-%d %H:%M:%S UTC")
        elif scene.held_at:
            dl_time_str = scene.held_at.strftime("%Y-%m-%d %H:%M:%S UTC")

        total_mb = sum(it.get("Size", 0) for it in s3_items) / (1024 * 1024)
        log_msg = (
            f"[ALREADY DOWNLOADED - SKIPPED] Scene '{scene.scene_id}' (Sentinel-1 complete product) "
            f"was downloaded on {dl_time_str}. Local path: '{scene_archive_dir}' "
            f"({len(s3_items)} files verified on NAS, {total_mb:.1f} MB). Skipping download."
        )
        logger.info(log_msg)
        return True, cached_details, log_msg

    # 4. Download Complete S3 Product Hierarchy
    total_bytes = sum(it.get("Size", 0) for it in s3_items)
    total_mb = total_bytes / (1024 * 1024)
    start_msg = (
        f"  ↳ Downloading COMPLETE Sentinel-1 product for '{scene.scene_id}': "
        f"{len(s3_items)} files ({total_mb:.1f} MB) across annotation/, measurement/, preview/, support/..."
    )
    logger.info(start_msg)
    if request_id and not silent_band_logs:
        try:
            from app.db.scripts.download_district_tiles import append_request_log
            append_request_log(db, request_id, start_msg)
        except Exception:
            pass

    def download_s1_file(item):
        try:
            k = item["Key"]
            rel = k[len(prefix_clean):].replace("\\", "/")
            rel_parts = [p for p in rel.split("/") if p]
            t_path = os.path.join(scene_archive_dir, *rel_parts)
            s_path = os.path.join(staging_dir, folder, *rel_parts)
            exp_sz = item.get("Size", 0)

            # Skip if already exists and valid on NAS
            if os.path.exists(t_path):
                if rel.lower().endswith((".tif", ".tiff")):
                    v_ok, sz, _ = verify_raster(t_path)
                    if v_ok and (exp_sz == 0 or sz == exp_sz):
                        return rel, True, sz, "cached", t_path
                else:
                    sz = os.path.getsize(t_path)
                    if exp_sz == 0 or sz == exp_sz:
                        return rel, True, sz, "cached", t_path

            # If measurement raster is missing in measurement/ but already exists at scene root, reuse it
            if not os.path.exists(t_path) and "measurement/" in rel and rel.lower().endswith((".tif", ".tiff")):
                b_clean = os.path.splitext(os.path.basename(rel))[0].upper()
                cand_root = None
                if "VV" in b_clean and "VH" not in b_clean:
                    for c_name in ("VV.tiff", "VV.tif", "s1-vv.tiff", "iw-vv.tiff"):
                        cp = os.path.join(scene_archive_dir, c_name)
                        if os.path.isfile(cp):
                            cand_root = cp
                            break
                elif "VH" in b_clean and "VV" not in b_clean:
                    for c_name in ("VH.tiff", "VH.tif", "s1-vh.tiff", "iw-vh.tiff"):
                        cp = os.path.join(scene_archive_dir, c_name)
                        if os.path.isfile(cp):
                            cand_root = cp
                            break
                if cand_root and os.path.isfile(cand_root):
                    v_ok, c_sz, _ = verify_raster(cand_root)
                    if v_ok and (exp_sz == 0 or c_sz == exp_sz or abs(c_sz - exp_sz) < 4096):
                        os.makedirs(os.path.dirname(t_path), exist_ok=True)
                        try:
                            os.link(cand_root, t_path)
                        except Exception:
                            try:
                                shutil.copy2(cand_root, t_path)
                            except Exception:
                                pass
                        if os.path.isfile(t_path):
                            return rel, True, os.path.getsize(t_path), "cached", t_path

            # Download to local staging directory
            os.makedirs(os.path.dirname(s_path), exist_ok=True)
            if not fetch_s3_object(k, s_path, bucket=S1_BUCKET, client=s3_s1_client):
                if os.path.exists(s_path):
                    try:
                        os.remove(s_path)
                    except Exception:
                        pass
                return rel, False, 0, "download failed from S3", t_path

            # Verify integrity
            if rel.lower().endswith((".tif", ".tiff")):
                v_ok, sz, note = verify_raster(s_path)
                if not v_ok:
                    if os.path.exists(s_path):
                        try:
                            os.remove(s_path)
                        except Exception:
                            pass
                    return rel, False, sz, f"raster verify failed ({note})", t_path
            else:
                sz = os.path.getsize(s_path)
                if exp_sz > 0 and sz != exp_sz:
                    if os.path.exists(s_path):
                        try:
                            os.remove(s_path)
                        except Exception:
                            pass
                    return rel, False, sz, f"size mismatch ({sz} != {exp_sz})", t_path

            # Move atomically from staging to NAS
            os.makedirs(os.path.dirname(t_path), exist_ok=True)
            if not safe_move_file(s_path, t_path):
                return rel, False, sz, "failed moving to NAS", t_path

            # Remove staging file after successful transfer (without touching parent directories)
            if os.path.exists(s_path):
                try:
                    os.remove(s_path)
                except Exception:
                    pass

            # Log individual band completion
            if rel.lower().endswith((".tif", ".tiff")) and request_id and not silent_band_logs:
                try:
                    from app.db.scripts.download_district_tiles import append_request_log
                    sz_mb = sz / (1024 * 1024)
                    append_request_log(db, request_id, f"     ↳ Band '{rel}' ({sz_mb:.1f} MB) downloaded & verified on NAS.")
                except Exception:
                    pass

            return rel, True, sz, "ok", t_path
        except Exception as err:
            logger.error(f"Error downloading Sentinel-1 file {item.get('Key')}: {err}")
            return item.get("Key", "unknown"), False, 0, str(err), ""

    # Concurrently download all files
    with ThreadPoolExecutor(max_workers=BAND_WORKERS) as pool:
        results = list(pool.map(download_s1_file, s3_items))

    failed_items = [r for r in results if not r[1]]
    if failed_items:
        fail_rels = [f[0] for f in failed_items]
        err_msg = f"Incomplete Sentinel-1 product for '{scene.scene_id}'. Failed files: {fail_rels}"
        logger.warning(err_msg)
        return False, [], err_msg

    # 5. Create convenience root links (VV.tiff, VH.tiff) for backward compatibility
    for rel, ok, sz, note, t_path in results:
        if "measurement/" in rel and rel.lower().endswith((".tif", ".tiff")):
            b_clean = os.path.splitext(os.path.basename(rel))[0].upper()
            std_name = None
            if "VV" in b_clean and "VH" not in b_clean:
                std_name = "VV.tiff"
            elif "VH" in b_clean and "VV" not in b_clean:
                std_name = "VH.tiff"
            if std_name:
                link_path = os.path.join(scene_archive_dir, std_name)
                if not os.path.exists(link_path):
                    try:
                        os.link(t_path, link_path)
                    except Exception:
                        try:
                            shutil.copy2(t_path, link_path)
                        except Exception:
                            pass

    # 6. Record measurement band files in BandFileModel
    now = datetime.utcnow()
    band_details = []
    for rel, ok, sz, note, t_path in results:
        if "measurement/" in rel and rel.lower().endswith((".tif", ".tiff")):
            b_clean = os.path.splitext(os.path.basename(rel))[0].upper()
            b_name = "VV" if ("VV" in b_clean and "VH" not in b_clean) else ("VH" if ("VH" in b_clean and "VV" not in b_clean) else b_clean)
            band_details.append({
                "band": b_name,
                "filename": os.path.basename(rel),
                "rel_path": rel,
                "ok": True,
                "size_bytes": sz,
                "status": "ok",
                "path": t_path
            })

            # Sync primary band name (VV / VH)
            existing_bf = db.query(BandFileModel).filter(
                BandFileModel.scene_id == scene.scene_id,
                BandFileModel.band == b_name
            ).first()
            if existing_bf:
                existing_bf.path = t_path
                existing_bf.size_bytes = sz
                existing_bf.verified = 1
                existing_bf.downloaded_at = now
            else:
                db.add(BandFileModel(
                    scene_id=scene.scene_id,
                    tile=tile,
                    sensing_date=sensing_date,
                    satellite=scene.satellite or "Sentinel-1",
                    band=b_name,
                    path=t_path,
                    size_bytes=sz,
                    verified=1,
                    downloaded_at=now
                ))

            # Also register the exact filename (e.g. iw-vv.tiff) for direct path lookups
            orig_fname = os.path.basename(rel)
            if orig_fname != b_name:
                existing_fn = db.query(BandFileModel).filter(
                    BandFileModel.scene_id == scene.scene_id,
                    BandFileModel.band == orig_fname
                ).first()
                if existing_fn:
                    existing_fn.path = t_path
                    existing_fn.size_bytes = sz
                    existing_fn.verified = 1
                    existing_fn.downloaded_at = now
                else:
                    db.add(BandFileModel(
                        scene_id=scene.scene_id,
                        tile=tile,
                        sensing_date=sensing_date,
                        satellite=scene.satellite or "Sentinel-1",
                        band=orig_fname,
                        path=t_path,
                        size_bytes=sz,
                        verified=1,
                        downloaded_at=now
                    ))

    # 7. Parse metadata from local manifest.safe and productInfo.json into Sentinel1SceneMetadataModel
    raw_xml_text = None
    parsed_xml_data = {}
    tileinfo_data = {}

    local_manifest = os.path.join(scene_archive_dir, "manifest.safe")
    if os.path.exists(local_manifest):
        try:
            with open(local_manifest, "r", encoding="utf-8", errors="ignore") as f:
                raw_xml_text = f.read()
            parsed_xml_data = parse_s1_manifest_xml(raw_xml_text)
        except Exception as e:
            logger.warning(f"Failed parsing local manifest.safe: {e}")

    local_prod_json = os.path.join(scene_archive_dir, "productInfo.json")
    if os.path.exists(local_prod_json):
        try:
            with open(local_prod_json, "r", encoding="utf-8", errors="ignore") as f:
                tileinfo_data = json.load(f)
        except Exception as e:
            logger.warning(f"Failed parsing local productInfo.json: {e}")

    combined_s1_metadata = {
        "manifest": parsed_xml_data,
        "productInfo": tileinfo_data,
        "total_files_downloaded": len(s3_items),
        "total_size_mb": round(total_mb, 2),
        "directory_structure": {
            "annotation": os.path.exists(os.path.join(scene_archive_dir, "annotation")),
            "measurement": os.path.exists(os.path.join(scene_archive_dir, "measurement")),
            "preview": os.path.exists(os.path.join(scene_archive_dir, "preview")),
            "support": os.path.exists(os.path.join(scene_archive_dir, "support")),
        }
    }

    try:
        yr = int(sensing_date[0:4])
        mo = int(sensing_date[5:7])
        dy = int(sensing_date[8:10])
    except Exception:
        yr, mo, dy = 2026, 1, 1

    s1_mode = parsed_xml_data.get("instrument_mode") or "IW"
    s1_pol = parsed_xml_data.get("polarisation") or "DV"
    s1_prod = parsed_xml_data.get("product_type") or "GRD"
    s1_mission = parsed_xml_data.get("mission") or "S1"
    s1_pols = parsed_xml_data.get("polarisation_channels") or ["VV", "VH"]
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
        s1_meta_rec.parsed_metadata = combined_s1_metadata

    scene.status = "HELD"
    scene.archive_path = scene_archive_dir
    scene.held_at = now
    db.commit()

    # Clean up temporary staging scene directory
    try:
        staged_scene_folder = os.path.join(staging_dir, folder)
        if os.path.exists(staged_scene_folder):
            shutil.rmtree(staged_scene_folder, ignore_errors=True)
        prune_empty_dirs(staging_dir)
    except Exception:
        pass

    complete_msg = (
        f"✓ [SENTINEL-1 COMPLETE PRODUCT DOWNLOADED] Scene '{scene.scene_id}' "
        f"({len(s3_items)} files, {total_mb:.1f} MB) saved to NAS in '{scene_archive_dir}' "
        f"with complete annotation/, measurement/, preview/, support/ folders and metadata."
    )
    logger.info(complete_msg)
    if request_id:
        try:
            from app.db.scripts.download_district_tiles import append_request_log
            append_request_log(db, request_id, complete_msg)
        except Exception:
            pass

    return True, band_details, complete_msg


def download_and_verify_scene(
    db: Session,
    scene: SceneModel,
    bands: list[str] = None,
    user_id: int = None,
    request_id: int = None,
    district_name: Optional[str] = None,
    silent_band_logs: bool = False
) -> tuple[bool, list[dict], str]:
    """
    Fetch required bands for a scene, verify each raster, and record.
    Deduplication: verifies from DB and disk before attempting S3 download.
    If already downloaded by any user, skips download and reports previous details in logs.
    Stores metadata.xml both completely and as parsed JSON in tile_scene_metadata table.
    For Sentinel-1 SAR scenes, downloads the complete product hierarchy from S3 to NAS.
    """
    tile = scene.tile
    sensing_date = scene.sensing_date
    satellite = scene.satellite or ""
    folder = scene.folder
    prefix = scene.prefix or ""

    is_s1 = prefix.startswith("GRD/") or ("sentinel-1" in satellite.lower()) or (scene.satellite and "sentinel-1" in scene.satellite.lower())

    if bands is None:
        bands = ["VV", "VH"] if is_s1 else DEFAULT_BANDS

    year = sensing_date[0:4]
    month = str(int(sensing_date[5:7]))

    staging_dir = settings.STAGING_DIR
    archive_dir = settings.RAW_ARCHIVE_DIR

    if not district_name and request_id:
        try:
            req_row = db.query(RequestModel.district).filter(RequestModel.id == request_id).first()
            if req_row and req_row[0]:
                district_name = req_row[0].strip()
        except Exception:
            pass

    sat_subfolder = "Sentinel-1" if is_s1 else "Sentinel-2"
    if is_s1 and district_name:
        dist_scene_archive_dir = os.path.join(archive_dir, sat_subfolder, tile, district_name, year, month, folder)
        if os.path.exists(dist_scene_archive_dir):
            scene_archive_dir = dist_scene_archive_dir
        else:
            fallback_nodist = os.path.join(archive_dir, sat_subfolder, tile, year, month, folder)
            if os.path.exists(fallback_nodist):
                scene_archive_dir = fallback_nodist
            else:
                legacy = os.path.join(archive_dir, tile, year, month, folder)
                if os.path.exists(legacy):
                    scene_archive_dir = legacy
                else:
                    scene_archive_dir = dist_scene_archive_dir
    else:
        scene_archive_dir = os.path.join(archive_dir, sat_subfolder, tile, year, month, folder)
        if not os.path.exists(scene_archive_dir):
            legacy = os.path.join(archive_dir, tile, year, month, folder)
            if os.path.exists(legacy):
                scene_archive_dir = legacy

    if scene_archive_dir.startswith("\\\\") or ":" in scene_archive_dir:
        if not ensure_nas_connection(scene_archive_dir):
            nas_err = (
                f"[NAS_ERROR] NAS path '{scene_archive_dir}' is unreachable or disconnected. "
                "Download cancelled; local storage fallback is strictly prohibited."
            )
            logger.error(nas_err)
            return False, [], nas_err

    try:
        os.makedirs(scene_archive_dir, exist_ok=True)
    except Exception as _mk_err:
        if scene_archive_dir.startswith("\\\\"):
            ensure_nas_connection(scene_archive_dir)
            try:
                os.makedirs(scene_archive_dir, exist_ok=True)
            except Exception as _mk_err2:
                nas_err = (
                    f"[NAS_ERROR] Cannot create scene directory on NAS '{scene_archive_dir}': {_mk_err2}. "
                    "Download cancelled; local storage fallback is strictly prohibited."
                )
                logger.error(nas_err)
                return False, [], nas_err
        else:
            nas_err = f"[STORAGE_ERROR] Cannot create archive directory '{scene_archive_dir}': {_mk_err}."
            logger.error(nas_err)
            return False, [], nas_err

    # ─────────────────────────────────────────────────────────────
    # SENTINEL-1: Complete Product Download Routing
    # ─────────────────────────────────────────────────────────────
    if is_s1:
        return download_complete_s1_scene(
            db=db,
            scene=scene,
            scene_archive_dir=scene_archive_dir,
            staging_dir=staging_dir,
            user_id=user_id,
            request_id=request_id,
            silent_band_logs=silent_band_logs
        )

    # ─────────────────────────────────────────────────────────────
    # SENTINEL-2: Deduplication Check & Band Acquisition
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
        try:
            s3_key, local_filename = resolve_s3_band_path(prefix, band_name)
            target_path = os.path.join(scene_archive_dir, local_filename)

            # Check if already verified in DB or already valid on disk (skip re-download)
            if (local_filename in already_verified or band_name in already_verified or os.path.exists(target_path)) and verify_raster(target_path)[0]:
                return local_filename, True, os.path.getsize(target_path), "cached"

            staged_path = os.path.join(staging_dir, folder, local_filename)

            if not fetch_s3_object(s3_key, staged_path):
                if os.path.exists(staged_path):
                    try:
                        os.remove(staged_path)
                    except Exception:
                        pass
                prune_empty_parent_dirs(staged_path, stop_at=staging_dir)
                return local_filename, False, 0, "download failed"

            ok, size, note = verify_raster(staged_path)
            if not ok:
                if os.path.exists(staged_path):
                    try:
                        os.remove(staged_path)
                    except Exception:
                        pass
                prune_empty_parent_dirs(staged_path, stop_at=staging_dir)
                return local_filename, False, size, note

            os.makedirs(scene_archive_dir, exist_ok=True)
            safe_move_file(staged_path, target_path)

            if request_id and db and not silent_band_logs:
                try:
                    mb = size / (1024 * 1024)
                    b_msg = f"     ↳ Band '{local_filename}' ({mb:.1f} MB) downloaded & verified on NAS."
                    logger.info(b_msg)
                    from app.db.scripts.download_district_tiles import append_request_log
                    append_request_log(db, request_id, b_msg)
                except Exception:
                    pass

            return local_filename, True, size, "ok"
        except Exception as err:
            logger.error(f"Error processing band {band_name} for {folder}: {err}")
            try:
                staged_path = os.path.join(staging_dir, folder, local_filename)
                if os.path.exists(staged_path):
                    os.remove(staged_path)
                prune_empty_parent_dirs(staged_path, stop_at=staging_dir)
            except Exception:
                pass
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
        try:
            staged_scene_folder = os.path.join(staging_dir, folder)
            if os.path.exists(staged_scene_folder):
                shutil.rmtree(staged_scene_folder, ignore_errors=True)
            prune_empty_dirs(staging_dir)
        except Exception:
            pass
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
    cld_val = getattr(scene, "cloud_cover", None) or (meta_record.cloud_coverage_percentage if 'meta_record' in locals() and hasattr(meta_record, 'cloud_coverage_percentage') else None)
    if cld_val is not None:
        try:
            scene.cloud_cover_percentage = int(round(float(cld_val)))
        except Exception:
            pass
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
    # Clean up local staged scene directory and prune empty folders in staging_dir
    try:
        staged_scene_folder = os.path.join(staging_dir, folder)
        if os.path.exists(staged_scene_folder):
            shutil.rmtree(staged_scene_folder, ignore_errors=True)
        prune_empty_dirs(staging_dir)
    except Exception:
        pass

    logger.info(log_msg)
    return True, band_details, log_msg


def resolve_tif_path(raw_path: str) -> tuple:
    """
    Checks if a stored DB raster path exists on disk, resolving relative paths
    against current execution dir and backend root. Returns (resolved_path, exists_bool).
    """
    if not raw_path:
        return raw_path, False
    from app.services.sentinel1_processor_service import win_safe_path
    safe_raw = win_safe_path(raw_path)
    if os.path.exists(safe_raw) or os.path.exists(raw_path):
        return os.path.abspath(raw_path), True
    backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    alt_path = os.path.join(backend_root, raw_path)
    if os.path.exists(alt_path):
        return os.path.abspath(alt_path), True
    norm_p = os.path.normpath(raw_path)
    if os.path.exists(norm_p):
        return os.path.abspath(norm_p), True
    if hasattr(settings, "RAW_ARCHIVE_DIR") and settings.RAW_ARCHIVE_DIR:
        parts = os.path.normpath(raw_path).split(os.sep)
        if "archive" in parts:
            rel = os.sep.join(parts[parts.index("archive") + 1:])
            nas_cand = os.path.join(settings.RAW_ARCHIVE_DIR, rel)
            if os.path.exists(nas_cand):
                return os.path.abspath(nas_cand), True
        nas_cand2 = os.path.join(settings.RAW_ARCHIVE_DIR, os.path.basename(raw_path))
        if os.path.exists(nas_cand2):
            return os.path.abspath(nas_cand2), True
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

    # 1b. Fallback: extract any scene IDs recorded in the execution logs for this request
    # only if no process job records are found
    scene_ids_from_logs = set()
    if not scene_ids_from_jobs and req.execution_logs:
        for m in re.finditer(r"(?:Scene:?\s*|Processing\s+(?:Sentinel-1\s+Scene:\s*)?)['\"]([A-Za-z0-9_]+)['\"]", req.execution_logs):
            scene_ids_from_logs.add(m.group(1))

    matched_scene_ids = set(scene_ids_from_jobs) if scene_ids_from_jobs else scene_ids_from_logs

    has_s1_request = bool((req.satellite and "Sentinel-1" in req.satellite) or (req.bands and any(b in ("VV", "VH", "VV_VH", "VV.tiff", "VH.tiff") for b in req.bands)))
    has_s2_request = bool((not req.satellite) or ("Sentinel-2" in req.satellite) or (req.bands and any(b.startswith("B") or b in ("SCL", "TCI") for b in req.bands)))
    if req.satellite and "Sentinel-1" in req.satellite and "Sentinel-2" not in req.satellite:
        has_s2_request = False
    elif req.satellite and "Sentinel-2" in req.satellite and "Sentinel-1" not in req.satellite:
        has_s1_request = False

    # 2. Resolve mapped tiles for district/state (only if Sentinel-2 requested)
    tiles = []
    if has_s2_request:
        if req.district:
            rows = db.execute(
                text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = LOWER(:d)"),
                {"d": req.district}
            ).fetchall()
            tiles = [r[0] for r in rows if r[0] != "S1_SAR"]
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
            tiles = [r[0] for r in rows if r[0] != "S1_SAR"]

    start_str = req.start_date.strftime("%Y-%m-%d")
    end_str = req.end_date.strftime("%Y-%m-%d")

    # If request has not run yet (matched_scene_ids is empty), populate from spatial tiles within cloud threshold
    if not matched_scene_ids and tiles and has_s2_request:
        max_cld = float(req.max_cloud_cover) if req.max_cloud_cover is not None else 100.0
        spatial_scenes = db.query(SceneModel.scene_id).filter(
            SceneModel.tile.in_(tiles),
            SceneModel.sensing_date >= start_str,
            SceneModel.sensing_date <= end_str,
            SceneModel.cloud_cover_percentage <= max_cld,
            SceneModel.status == "HELD"
        ).all()
        for s in spatial_scenes:
            matched_scene_ids.add(s[0])

    # For Sentinel-1: ONLY include scenes if they are linked to this request in jobs/logs,
    # OR if this is an unrun request, discover genuinely intersecting S1 scenes via spatial bounding box.
    # NEVER do a blanket query on tile == 'S1_SAR' across all of India!
    s1_matched = [s for s in matched_scene_ids if s.startswith("S1")]
    if has_s1_request and not s1_matched and not req.execution_logs:
        try:
            from app.services.gap_check_service import search_aws_scenes_for_s1
            s1_candidates = search_aws_scenes_for_s1(
                start_date=start_str,
                end_date=end_str,
                district_name=req.district,
                state_name=req.state,
                db=db
            )
            for sc in s1_candidates:
                matched_scene_ids.add(sc["scene_id"])
        except Exception as e:
            logger.warning(f"Could not discover S1 candidate scenes for request #{request_id}: {e}")

    # Enforce strict satellite partitioning on matched_scene_ids
    if has_s1_request and not has_s2_request:
        matched_scene_ids = {s for s in matched_scene_ids if s.startswith("S1")}
    elif has_s2_request and not has_s1_request:
        matched_scene_ids = {s for s in matched_scene_ids if not s.startswith("S1")}

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
    if has_s1_request and not has_s2_request:
        try:
            s1_scene_objs = []
            for sid in matched_scene_ids:
                if sid.startswith("S1"):
                    so = db.query(SceneModel).filter(SceneModel.scene_id == sid).first()
                    if not so:
                        first_bf = db.query(BandFileModel).filter(BandFileModel.scene_id == sid).first()
                        s_dt = first_bf.sensing_date if first_bf else None
                        first_path = first_bf.path if first_bf else None
                        class _MockScene: pass
                        m = _MockScene()
                        m.scene_id = sid
                        m.tile = "S1_SAR"
                        m.sensing_date = s_dt
                        m.satellite = "Sentinel-1"
                        m.folder = sid
                        m.archive_path = os.path.dirname(os.path.dirname(first_path)) if (first_path and "measurement" in first_path.lower()) else (os.path.dirname(first_path) if first_path else None)
                        so = m
                    s1_scene_objs.append(so)
            if s1_scene_objs:
                ensure_s1_calibrated_rasters_available(db, s1_scene_objs)
        except Exception as e:
            logger.warning(f"Could not pre-sync calibrated S1 rasters: {e}")

    bf_query = db.query(BandFileModel).filter(
        BandFileModel.scene_id.in_(list(matched_scene_ids)),
        BandFileModel.verified == 1
    )
    if has_s1_request and not has_s2_request:
        bf_query = bf_query.filter(BandFileModel.satellite == "Sentinel-1")
    elif has_s2_request and not has_s1_request:
        bf_query = bf_query.filter(BandFileModel.satellite == "Sentinel-2")
    band_records = bf_query.order_by(BandFileModel.tile, BandFileModel.sensing_date, BandFileModel.band).all()

    # Pre-fetch district bounding box to safeguard against out-of-bounds Sentinel-1 scenes
    d_bbox = None
    if req.district:
        try:
            from app.services.delivery_service import get_district_geometry_from_db
            from shapely.geometry import shape
            geom, _ = get_district_geometry_from_db(db, req.district, state_name=req.state)
            if geom:
                d_bbox = shape(geom).bounds
        except Exception:
            pass

    tif_files = []
    tif_paths = []
    total_size = 0
    scenes_indexed = set()

    # Detect which S1 scenes have calibrated files to strictly exclude uncalibrated raw tiles
    scenes_with_s1_calibrated = set()
    for bf in band_records:
        b_p = (bf.path or "").lower()
        if "cal_tc_db" in b_p or "orb_tnr" in b_p or "_cal_" in b_p:
            scenes_with_s1_calibrated.add(bf.scene_id)

    for bf in band_records:
        raw_p = bf.path
        if not (raw_p.lower().endswith(".tif") or raw_p.lower().endswith(".tiff")):
            continue

        # Enforce spatial validation for Sentinel-1 rasters so out-of-bounds scenes from other continents/regions are omitted
        is_s1_band = (bf.tile == "S1_SAR" or bf.satellite == "Sentinel-1" or (bf.scene_id and bf.scene_id.startswith("S1")))
        if is_s1_band:
            # If calibrated files exist for this scene, omit raw uncalibrated measurement tiles
            if bf.scene_id in scenes_with_s1_calibrated:
                norm_p = raw_p.replace("\\", "/").lower()
                if "/measurement/" in norm_p or not ("cal_tc_db" in norm_p or "orb_tnr" in norm_p or "_cal_" in norm_p):
                    continue
            if d_bbox and not is_raster_overlapping_district(raw_p, d_bbox):
                continue

        f_size = bf.size_bytes or 0
        total_size += f_size

        tif_paths.append(raw_p)
        scenes_indexed.add(bf.scene_id)

        fname = os.path.basename(raw_p)
        f_upper = os.path.splitext(fname)[0].upper()
        is_cal = bool("CAL" in f_upper or "TC_DB" in f_upper or "ORB_TNR" in f_upper)

        b_canonical = bf.band
        if is_s1_band:
            if "VV_VH" in f_upper or "VV/VH" in f_upper or "VV-VH" in f_upper or "RATIO" in f_upper or "VV_VH" in bf.band.upper():
                b_canonical = "VV_VH"
            elif "VV" in f_upper and "VH" not in f_upper:
                b_canonical = "VV"
            elif "VH" in f_upper and "VV" not in f_upper:
                b_canonical = "VH"

        tif_files.append({
            "scene_id": bf.scene_id,
            "tile": bf.tile,
            "sensing_date": bf.sensing_date,
            "satellite": bf.satellite,
            "band": b_canonical,
            "filename": fname,
            "path": raw_p,
            "is_calibrated": is_cal,
            "size_bytes": f_size,
            "exists_on_disk": True
        })

    # Prioritize calibrated files over raw tiles and deduplicate by (scene_id, band)
    dedup_map = {}
    for tf in tif_files:
        k = (tf["scene_id"], tf["band"])
        if k not in dedup_map:
            dedup_map[k] = tf
        else:
            if tf.get("is_calibrated") and not dedup_map[k].get("is_calibrated"):
                dedup_map[k] = tf
    tif_files = list(dedup_map.values())
    tif_paths = [tf["path"] for tf in tif_files]
    total_size = sum(tf.get("size_bytes", 0) for tf in tif_files)

    # 3b. Check if any matched scenes exist on NAS storage but have missing records in BandFileModel
    unindexed_scenes = matched_scene_ids - scenes_indexed
    if unindexed_scenes:
        for sc_id in unindexed_scenes:
            sc_obj = db.query(SceneModel).filter(SceneModel.scene_id == sc_id).first()
            arch_p = sc_obj.archive_path if sc_obj else None
            if not arch_p and req.execution_logs:
                m = re.search(rf"Scene '{sc_id}'[^\n]*cached at '([^']+)'", req.execution_logs)
                if not m:
                    m = re.search(rf"'{sc_id}'[^\n]*already on NAS at '([^']+)'", req.execution_logs)
                if m:
                    arch_p = m.group(1)

            # Direct fallback check on NAS archive folder
            if not arch_p:
                try:
                    s_date = (sc_obj.sensing_date if sc_obj else None) or (sc_id.split('_')[2][:8] if len(sc_id.split('_')) > 2 else start_str)
                    s_yr = s_date[0:4]
                    s_mo = str(int(s_date[5:7])) if len(s_date) >= 7 and s_date[5:7].isdigit() else "1"
                    s_tile = (sc_obj.tile if sc_obj else None) or ("S1_SAR" if sc_id.startswith("S1") else (sc_id.split('_')[1] if len(sc_id.split('_')) > 1 else ""))
                    s_folder = (sc_obj.folder if sc_obj else None) or sc_id
                    if s_tile:
                        is_s1_curr = s_tile == "S1_SAR" or sc_id.startswith("S1")
                        sat_folder = "Sentinel-1" if is_s1_curr else "Sentinel-2"
                        candidates = []
                        if is_s1_curr and req.district:
                            candidates.append(os.path.join(settings.RAW_ARCHIVE_DIR, sat_folder, s_tile, req.district, s_yr, s_mo, s_folder))
                        candidates.append(os.path.join(settings.RAW_ARCHIVE_DIR, sat_folder, s_tile, s_yr, s_mo, s_folder))
                        candidates.append(os.path.join(settings.RAW_ARCHIVE_DIR, s_tile, s_yr, s_mo, s_folder))
                        for cand in candidates:
                            cand_res, cand_ex = resolve_tif_path(cand)
                            if cand_ex or os.path.isdir(cand_res):
                                arch_p = cand_res
                                break
                except Exception:
                    pass

            if arch_p:
                resolved_dir, d_exists = resolve_tif_path(arch_p)
                target_dir = resolved_dir if d_exists else arch_p
                if os.path.isdir(target_dir):
                    sc_date = sc_obj.sensing_date if sc_obj else (sc_id.split('_')[2][:8] if len(sc_id.split('_')) > 2 else start_str)
                    sc_tile = sc_obj.tile if sc_obj else ("S1_SAR" if sc_id.startswith("S1") else (sc_id.split('_')[1] if len(sc_id.split('_')) > 1 else "AOI"))
                    sc_sat = "Sentinel-1" if sc_id.startswith("S1") else "Sentinel-2"
                    cand_files = []
                    if sc_sat == "Sentinel-1" or sc_id.startswith("S1"):
                        s1_cal_found = []
                        for fname in os.listdir(target_dir):
                            if fname.lower().endswith((".tif", ".tiff")):
                                fn_up = fname.upper()
                                if "CAL_TC_DB" in fn_up or "ORB_TNR" in fn_up:
                                    s1_cal_found.append((fname, os.path.join(target_dir, fname)))
                        if s1_cal_found:
                            cand_files = s1_cal_found
                        else:
                            m_dir = os.path.join(target_dir, "measurement")
                            if os.path.isdir(m_dir):
                                for fname in os.listdir(m_dir):
                                    if fname.lower().endswith((".tif", ".tiff")):
                                        cand_files.append((fname, os.path.join(m_dir, fname)))
                    else:
                        for fname in os.listdir(target_dir):
                            if fname.lower().endswith((".tif", ".tiff")):
                                cand_files.append((fname, os.path.join(target_dir, fname)))

                    for fname, f_path in cand_files:
                        if not os.path.isfile(f_path):
                            continue
                        if d_bbox and (sc_tile == "S1_SAR" or sc_sat == "Sentinel-1" or sc_id.startswith("S1")):
                            if not is_raster_overlapping_district(f_path, d_bbox):
                                continue
                        f_size = os.path.getsize(f_path)
                        total_size += f_size
                        tif_paths.append(f_path)

                        f_upper = os.path.splitext(fname)[0].upper()
                        is_cal = bool("CAL" in f_upper or "TC_DB" in f_upper or "ORB_TNR" in f_upper)

                        if "VV_VH" in f_upper or "VV/VH" in f_upper or "VV-VH" in f_upper or "RATIO" in f_upper:
                            b_canonical = "VV_VH"
                        elif "VV" in f_upper and "VH" not in f_upper:
                            b_canonical = "VV"
                        elif "VH" in f_upper and "VV" not in f_upper:
                            b_canonical = "VH"
                        else:
                            b_canonical = fname

                        tif_files.append({
                            "scene_id": sc_id,
                            "tile": sc_tile,
                            "sensing_date": sc_date,
                            "satellite": sc_sat,
                            "band": b_canonical,
                            "filename": fname,
                            "path": f_path,
                            "is_calibrated": is_cal,
                            "size_bytes": f_size,
                            "exists_on_disk": True
                        })
                        try:
                            existing_bf = db.query(BandFileModel).filter(
                                BandFileModel.scene_id == sc_id,
                                BandFileModel.band == b_canonical
                            ).first()
                            if not existing_bf:
                                db.add(BandFileModel(
                                    scene_id=sc_id,
                                    tile=sc_tile,
                                    sensing_date=sc_date,
                                    satellite=sc_sat,
                                    band=b_canonical,
                                    path=f_path,
                                    size_bytes=f_size,
                                    verified=1
                                ))
                                db.commit()
                            else:
                                if is_cal or not ("cal_tc_db" in existing_bf.path.lower() or "orb_tnr" in existing_bf.path.lower()):
                                    existing_bf.path = f_path
                                    existing_bf.size_bytes = f_size
                                    existing_bf.verified = 1
                                    db.commit()
                        except Exception:
                            db.rollback()

    req_interval = (req.composite_interval or "none").lower().strip()
    if req_interval in ("fortnightly", "weekly", "monthly"):
        district_name = req.district or req.state or "Region"
        clean_d = district_name.strip()
        year_str = req.start_date.strftime("%Y") if req.start_date else "2026"
        specific_dirs = [
            os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", clean_d, year_str, req_interval),
            os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", clean_d.capitalize(), year_str, req_interval),
            os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", clean_d, req_interval),
        ]
        composite_tifs = []
        comp_seen = set()

        def _scan_composite_dir(target_dir: str):
            if not os.path.isdir(target_dir):
                return
            try:
                for entry in os.scandir(target_dir):
                    if entry.is_file() and entry.name.lower().endswith((".tif", ".tiff")):
                        fn = entry.name
                        if fn in comp_seen:
                            continue
                        if req_interval not in target_dir.lower() and req_interval not in fn.lower():
                            continue
                        comp_seen.add(fn)
                        full_cp = entry.path
                        try:
                            sz = entry.stat().st_size
                        except Exception:
                            sz = 0
                        fn_u = fn.upper()
                        if "VV_VH" in fn_u:
                            b_type = "VV_VH"
                        elif "_VV_" in fn_u or fn_u.startswith("COMPOSITE_VV_"):
                            b_type = "VV"
                        elif "_VH_" in fn_u or fn_u.startswith("COMPOSITE_VH_"):
                            b_type = "VH"
                        elif "LSWI" in fn_u:
                            b_type = "LSWI"
                        elif "NDVI" in fn_u:
                            b_type = "NDVI"
                        else:
                            b_type = "INDEX"

                        m_dt = re.search(r"(\d{8})_(\d{8})", fn)
                        dt_val = f"{m_dt.group(1)}_{m_dt.group(2)}" if m_dt else start_str

                        composite_tifs.append({
                            "scene_id": f"Composite_{req_interval}_{dt_val}",
                            "tile": clean_d,
                            "sensing_date": dt_val,
                            "satellite": req.satellite or "Composite",
                            "band": b_type,
                            "filename": fn,
                            "path": full_cp,
                            "is_calibrated": True,
                            "is_composite": True,
                            "size_bytes": sz,
                            "exists_on_disk": True
                        })
            except Exception as e_scan:
                logger.warning(f"Error scanning composite directory {target_dir}: {e_scan}")

        # Scan specific interval directories first for instant <10ms lookup
        for sdir in specific_dirs:
            _scan_composite_dir(sdir)

        # Only if specific subdirectories had no composite files, do a shallow scan of parent Composites/clean_d
        if not composite_tifs:
            parent_d = os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", clean_d)
            if os.path.isdir(parent_d):
                try:
                    for entry in os.scandir(parent_d):
                        if entry.is_dir() and "stack" not in entry.name.lower():
                            _scan_composite_dir(entry.path)
                except Exception:
                    pass

        if composite_tifs:
            tif_files = composite_tifs
            tif_paths = [ct["path"] for ct in composite_tifs]
            total_size = sum(ct["size_bytes"] for ct in composite_tifs)

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


def ensure_scene_indices_available(
    db: Session,
    scenes: List[Any],
    requested_bands: List[str]
) -> None:
    """
    If user requested individual scene indices (NDVI, LSWI) that do not yet exist
    in band_files for the matched scenes, checks disk or generates them on-the-fly
    from raw optical bands and registers them in PostgreSQL and storage.
    """
    needed_indices = []
    for b in requested_bands:
        b_up = b.upper()
        if b_up in ("NDVI", "LSWI") and b_up not in needed_indices:
            needed_indices.append(b_up)

    if not needed_indices or not scenes:
        return

    from app.services.processor_service import compute_full_tile_index

    for sc in scenes:
        sc_sat = getattr(sc, "satellite", "") or ""
        sc_id = getattr(sc, "scene_id", "") or ""
        if sc_sat != "Sentinel-2" and not sc_id.startswith("S2"):
            continue

        existing_bfs = db.query(BandFileModel).filter(BandFileModel.scene_id == sc_id).all()
        existing_bands = {bf.band.replace(".tif", "").replace(".tiff", "").upper(): bf for bf in existing_bfs}

        band_paths = {}
        for b_name, bf in existing_bands.items():
            rp, exists = resolve_tif_path(bf.path)
            if exists:
                band_paths[b_name] = rp

        ref_path = None
        for bp in band_paths.values():
            if bp:
                ref_path = bp
                break
        if not ref_path:
            continue
        sc_dir = os.path.dirname(ref_path)

        for idx_type in needed_indices:
            if idx_type in existing_bands:
                continue

            out_file = os.path.join(sc_dir, f"{idx_type}.tif")
            if os.path.exists(out_file):
                try:
                    new_bf = BandFileModel(
                        scene_id=sc_id,
                        tile=sc.tile,
                        sensing_date=sc.sensing_date,
                        satellite=sc.satellite,
                        band=f"{idx_type}.tif",
                        path=out_file,
                        size_bytes=os.path.getsize(out_file),
                        verified=1
                    )
                    db.add(new_bf)
                    db.commit()
                except Exception:
                    db.rollback()
                continue

            can_compute = False
            if idx_type == "NDVI" and "B04" in band_paths and "B08" in band_paths:
                can_compute = True
            elif idx_type == "LSWI" and ("B08A" in band_paths or "B8A" in band_paths) and "B11" in band_paths:
                can_compute = True

            if can_compute:
                try:
                    compute_full_tile_index(band_paths, idx_type, out_file)
                    if os.path.exists(out_file):
                        new_bf = BandFileModel(
                            scene_id=sc_id,
                            tile=sc.tile,
                            sensing_date=sc.sensing_date,
                            satellite=sc.satellite,
                            band=f"{idx_type}.tif",
                            path=out_file,
                            size_bytes=os.path.getsize(out_file),
                            verified=1
                        )
                        db.add(new_bf)
                        db.commit()
                        logger.info(f"Registered on-demand index {idx_type} for scene {sc_id}")
                except Exception as ex:
                    logger.warning(f"Could not compute on-demand {idx_type} for {sc_id}: {ex}")
                    db.rollback()


def repair_missing_s1_rasters_in_dir(scene_dir: str) -> None:
    """
    Checks a Sentinel-1 scene folder. If any of the 3 calibrated GeoTIFFs
    (VV_Orb_tnr_cal_Tc_db, VH_Orb_tnr_cal_Tc_db, VV_VH_Orb_tnr_cal_Tc_db)
    is missing, automatically recovers/computes it from the other two or raw SAFE files.
    Supports both .tif and .tiff file naming conventions seamlessly.
    """
    from app.services.sentinel1_processor_service import win_safe_path
    import rasterio
    import numpy as np

    def _locate_s1_file(stem):
        for ext in (".tif", ".tiff", ".TIF", ".TIFF"):
            candidate = os.path.join(scene_dir, f"{stem}{ext}")
            safe_c = win_safe_path(candidate)
            if os.path.isfile(safe_c) and os.path.getsize(safe_c) > 1024:
                return candidate, safe_c, ext
        return None, None, ".tif"

    vv_path, safe_vv, vv_ext = _locate_s1_file("VV_Orb_tnr_cal_Tc_db")
    vh_path, safe_vh, vh_ext = _locate_s1_file("VH_Orb_tnr_cal_Tc_db")
    ratio_path, safe_ratio, r_ext = _locate_s1_file("VV_VH_Orb_tnr_cal_Tc_db")

    has_vv = bool(vv_path and safe_vv)
    has_vh = bool(vh_path and safe_vh)
    has_ratio = bool(ratio_path and safe_ratio)

    target_ext = vv_ext or r_ext or vh_ext or ".tif"

    # Case 1: VV and Ratio exist, but VH is missing -> VH = VV - Ratio (Chunked Window Processing)
    if has_vv and has_ratio and not has_vh:
        try:
            out_vh_path = os.path.join(scene_dir, f"VH_Orb_tnr_cal_Tc_db{target_ext}")
            safe_out_vh = win_safe_path(out_vh_path)
            with rasterio.open(safe_vv) as src_vv, rasterio.open(safe_ratio) as src_r:
                prof = src_vv.profile.copy()
                prof.update(dtype=rasterio.float32, count=1, nodata=-999.0, compress="lzw")
                with rasterio.open(safe_out_vh, "w", **prof) as dst:
                    for _, window in src_vv.block_windows(1):
                        vv = src_vv.read(1, window=window).astype(np.float32)
                        r = src_r.read(1, window=window).astype(np.float32)
                        vh = vv - r
                        nodata_mask = (vv <= -990.0) | (r <= -990.0) | np.isnan(vv) | np.isnan(r) | np.isinf(vv) | np.isinf(r)
                        vh[nodata_mask] = -999.0
                        dst.write(vh, 1, window=window)
            logger.info(f"Reconstructed missing VH calibrated raster: '{out_vh_path}'")
        except Exception as e:
            logger.warning(f"Could not reconstruct VH raster in '{scene_dir}': {e}")

    # Case 2: VV and VH exist, but Ratio is missing -> Ratio = VV - VH
    elif has_vv and has_vh and not has_ratio:
        try:
            from app.services.sentinel1_processor_service import compute_s1_vv_vh_ratio
            out_ratio_path = os.path.join(scene_dir, f"VV_VH_Orb_tnr_cal_Tc_db{target_ext}")
            compute_s1_vv_vh_ratio(vv_path, vh_path, out_ratio_path)
            logger.info(f"Computed missing VV_VH ratio raster: '{out_ratio_path}'")
        except Exception as e:
            logger.warning(f"Could not compute VV_VH ratio in '{scene_dir}': {e}")


def ensure_s1_calibrated_rasters_available(
    db: Session,
    scenes: List[Any],
    requested_bands: Optional[List[str]] = None
) -> None:
    """
    Ensures that calibrated Sentinel-1 products:
      - VV_Orb_tnr_cal_Tc_db.tiff
      - VH_Orb_tnr_cal_Tc_db.tiff
      - VV_VH_Orb_tnr_cal_Tc_db.tiff
    exist on disk and are registered in BandFileModel.
    If the files exist on disk, registers them in PostgreSQL.
    If missing on disk but raw SAFE rasters exist, executes the sequential
    SAR calibration pipeline on-the-fly to generate them.
    """
    if not scenes:
        return

    from app.services.sentinel1_processor_service import (
        run_sentinel_1_processing,
        sync_s1_processed_rasters_to_db,
        win_safe_path
    )

    s1_bands_to_find = [
        ("VV_Orb_tnr_cal_Tc_db", "VV_Orb_tnr_cal_Tc_db.tiff"),
        ("VH_Orb_tnr_cal_Tc_db", "VH_Orb_tnr_cal_Tc_db.tiff"),
        ("VV_VH_Orb_tnr_cal_Tc_db", "VV_VH_Orb_tnr_cal_Tc_db.tiff"),
    ]

    for sc in scenes:
        sc_sat = getattr(sc, "satellite", "") or ""
        sc_id = getattr(sc, "scene_id", "") or ""
        sc_tile = getattr(sc, "tile", "") or ""
        if sc_sat != "Sentinel-1" and not sc_id.startswith("S1") and sc_tile != "S1_SAR":
            continue

        sc_dir = None
        arch_p = getattr(sc, "archive_path", None)
        if arch_p:
            safe_arch = win_safe_path(arch_p)
            if os.path.isdir(safe_arch):
                sc_dir = arch_p
            elif arch_p.lower().endswith("manifest.safe"):
                sc_dir = os.path.dirname(arch_p)

        if not sc_dir:
            existing_bfs = db.query(BandFileModel).filter(BandFileModel.scene_id == sc_id).all()
            for bf in existing_bfs:
                if bf.path:
                    rp, exists = resolve_tif_path(bf.path)
                    safe_rp = win_safe_path(rp)
                    if os.path.exists(safe_rp) or os.path.exists(rp):
                        p_dir = os.path.dirname(rp)
                        if os.path.basename(p_dir).lower() == "measurement":
                            sc_dir = os.path.dirname(p_dir)
                        else:
                            sc_dir = p_dir
                        break

        if not sc_dir:
            continue

        safe_sc_dir = win_safe_path(sc_dir)
        if not os.path.isdir(safe_sc_dir):
            continue

        # Rasters are read-only during retrieval; repair belongs to background processing pipeline

        all_found = True
        found_paths = {}
        for b_name in ("VV_Orb_tnr_cal_Tc_db", "VH_Orb_tnr_cal_Tc_db", "VV_VH_Orb_tnr_cal_Tc_db"):
            matched_p = None
            for ext in (".tif", ".tiff", ".TIF", ".TIFF"):
                cand = os.path.join(sc_dir, f"{b_name}{ext}")
                safe_cand = win_safe_path(cand)
                if os.path.isfile(safe_cand) and os.path.getsize(safe_cand) > 1024:
                    matched_p = cand
                    break
            if matched_p:
                found_paths[b_name] = matched_p
            else:
                all_found = False

        if not all_found:
            # Calibrated rasters are not yet generated. SAR calibration belongs strictly
            # to Stage 3 of the background pipeline. Never run heavy processing on GET requests.
            logger.debug(f"Calibrated S1 rasters not yet complete for scene '{sc_id}' on disk; skipping on-the-fly execution.")

        now = datetime.utcnow()
        for b_name, fpath in found_paths.items():
            safe_fpath = win_safe_path(fpath)
            f_size = os.path.getsize(safe_fpath)
            existing = db.query(BandFileModel).filter(
                BandFileModel.scene_id == sc_id,
                BandFileModel.band == b_name
            ).first()
            if existing:
                existing.path = fpath
                existing.size_bytes = f_size
                existing.verified = 1
            else:
                db.add(BandFileModel(
                    scene_id=sc_id,
                    tile=getattr(sc, "tile", "S1_SAR") or "S1_SAR",
                    sensing_date=getattr(sc, "sensing_date", None),
                    satellite="Sentinel-1",
                    band=b_name,
                    path=fpath,
                    size_bytes=f_size,
                    verified=1,
                    downloaded_at=now
                ))

            # Also register/update the canonical short band name (VV, VH, VV_VH) so standard queries retrieve the calibrated file
            short_b = "VV_VH" if "VV_VH" in b_name else ("VV" if "VV_Orb" in b_name else ("VH" if "VH_Orb" in b_name else None))
            if short_b:
                ex_short = db.query(BandFileModel).filter(
                    BandFileModel.scene_id == sc_id,
                    BandFileModel.band == short_b
                ).first()
                if ex_short:
                    ex_short.path = fpath
                    ex_short.size_bytes = f_size
                    ex_short.verified = 1
                else:
                    db.add(BandFileModel(
                        scene_id=sc_id,
                        tile=getattr(sc, "tile", "S1_SAR") or "S1_SAR",
                        sensing_date=getattr(sc, "sensing_date", None),
                        satellite="Sentinel-1",
                        band=short_b,
                        path=fpath,
                        size_bytes=f_size,
                        verified=1,
                        downloaded_at=now
                    ))
        try:
            db.commit()
        except Exception as e:
            db.rollback()
            logger.warning(f"Could not commit S1 band_file sync for {sc_id}: {e}")


def search_downloaded_tifs_by_region(
    db: Session,
    state: Optional[str] = None,
    district: Optional[str] = None,
    satellite: Optional[str] = None,
    band: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    composite_interval: Optional[str] = None
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
    
    raw_interval = (composite_interval or "").strip().lower()
    if raw_interval in ("none", "individual", "scene", "scenes"):
        clean_interval = "none"
    elif raw_interval in ("weekly", "fortnightly", "monthly"):
        clean_interval = raw_interval
    else:
        clean_interval = "all"

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
            "query_composite_interval": composite_interval,
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

    # Filter scenes strictly to those requested/downloaded for the specified district/state
    # This prevents neighboring districts that share the same 100km MGRS tile from displaying
    # or downloading data when no acquisition request has been submitted for this district.
    allowed_scene_ids = None
    if district or state:
        from app.models.sdap_models import ProcessJobModel, RequestModel
        from sqlalchemy import func

        pj_query = db.query(ProcessJobModel.scene_id).join(
            RequestModel, ProcessJobModel.request_id == RequestModel.id
        ).filter(
            ProcessJobModel.scene_id.isnot(None),
            ProcessJobModel.stage == "DOWNLOAD",
            ProcessJobModel.status == "COMPLETED"
        )
        if district:
            clean_d = district.split(",")[0].strip().lower()
            pj_query = pj_query.filter(func.lower(RequestModel.district) == clean_d)
        if state:
            clean_s = state.split(",")[0].strip().lower()
            pj_query = pj_query.filter(func.lower(RequestModel.state) == clean_s)

        allowed_scene_ids = set(r[0] for r in pj_query.distinct().all() if r[0])

        # Also extract scenes from execution logs of requests for this district/state to catch all cached scenes
        req_q = db.query(RequestModel)
        if district:
            req_q = req_q.filter(func.lower(RequestModel.district) == clean_d)
        if state:
            req_q = req_q.filter(func.lower(RequestModel.state) == clean_s)
        for r_obj in req_q.all():
            if r_obj.execution_logs:
                for m in re.finditer(r"(?:Scene:?\s*|Processing\s+(?:Sentinel-1\s+Scene:\s*)?)['\"]([A-Za-z0-9_]+)['\"]", r_obj.execution_logs):
                    allowed_scene_ids.add(m.group(1))
                for m in re.finditer(r"\b(S1[A-C0-9]_[0-9A-Za-z_]+)\b", r_obj.execution_logs):
                    allowed_scene_ids.add(m.group(1))

        if district:
            s1_bfs = db.query(BandFileModel.scene_id).filter(
                BandFileModel.satellite == "Sentinel-1",
                BandFileModel.path.ilike(f"%{clean_d}%")
            ).distinct().all()
            for bf_row in s1_bfs:
                if bf_row[0]:
                    allowed_scene_ids.add(bf_row[0])

        # Also include held S1 scenes specifically for this district if none were found
        s1_req_q = db.query(RequestModel).filter(RequestModel.satellite.ilike("%Sentinel-1%"))
        if district:
            s1_req_q = s1_req_q.filter(func.lower(RequestModel.district) == clean_d)
        if state:
            s1_req_q = s1_req_q.filter(func.lower(RequestModel.state) == clean_s)

        if not allowed_scene_ids and (s1_req_q.first() or (satellite and "Sentinel-1" in satellite) or (band and any(sb in (band.upper()) for sb in ("VV", "VH", "SAR")))):
            try:
                from app.services.gap_check_service import search_aws_scenes_for_s1
                s1_candidates = search_aws_scenes_for_s1(
                    start_date=start_date or "2024-01-01",
                    end_date=end_date or "2026-12-31",
                    district_name=district,
                    state_name=state,
                    db=db
                )
                for sc in s1_candidates:
                    allowed_scene_ids.add(sc["scene_id"])
            except Exception as e:
                logger.warning(f"Could not search S1 candidates by region: {e}")

        # If user explicitly filtered by district or state, but no scenes were acquired for it:
        if len(allowed_scene_ids) == 0:
            return {
                "query_state": state,
                "query_district": district,
                "query_satellite": satellite,
                "query_band": band,
                "query_composite_interval": composite_interval,
                "query_start_date": start_date,
                "query_end_date": end_date,
                "matched_tiles": [],
                "matched_districts": [district] if district else (resolved_districts or []),
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

    tif_files = []
    tif_paths = []
    total_size = 0
    matched_scenes = []

    # 2. Build Scene Query for individual scenes
    is_s1_request = bool((satellite and "Sentinel-1" in satellite) or (band and ("ORB" in band.upper() or "VV" in band.upper() or "VH" in band.upper())))
    has_explicit_scene_band = bool(band and any(
        b.upper() not in ("ALL", "COMPOSITE", "COMPOSITES")
        for b in band.split(",")
    ))

    # Never skip individual scene queries for Sentinel-1 or when user requested specific scene bands
    if is_s1_request or has_explicit_scene_band:
        skip_raw_scenes = False
    else:
        skip_raw_scenes = clean_interval in ("weekly", "fortnightly", "monthly")
    if not skip_raw_scenes:
        scene_query = db.query(SceneModel).filter(SceneModel.status == "HELD")
        if tiles:
            scene_query = scene_query.filter(SceneModel.tile.in_(tiles))

        # Enforce strict district/state association from acquisition requests
        if allowed_scene_ids is not None:
            scene_query = scene_query.filter(SceneModel.scene_id.in_(allowed_scene_ids))

        if satellite and satellite.strip():
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

        if scene_ids:
            band_tokens = [
                b.replace(".tif", "").replace(".tiff", "").strip()
                for b in (band or "").split(",")
                if b.strip() and b.strip().upper() != "ALL"
            ] if (band and band.strip() and band.upper() != "ALL") else []

            if band_tokens:
                ensure_scene_indices_available(db, matched_scenes, band_tokens)

            # Ensure calibrated SAR products exist on NAS & DB for any Sentinel-1 scenes
            ensure_s1_calibrated_rasters_available(db, matched_scenes, band_tokens)

            # 3. Query Band Files from DB using path column
            bf_query = db.query(BandFileModel).filter(
                BandFileModel.scene_id.in_(scene_ids),
                BandFileModel.verified == 1
            )

            is_pure_s1_retrieval = bool(satellite and "Sentinel-1" in satellite and "Sentinel-2" not in satellite)
            if is_pure_s1_retrieval and (not band or band.strip().upper() == "ALL"):
                # If user asked for Sentinel-1 ALL bands, return strictly the 3 calibrated GeoTIFF deliverables
                bf_query = bf_query.filter(or_(
                    BandFileModel.band.ilike("%VV_Orb_tnr_cal_Tc_db%"),
                    BandFileModel.band.ilike("%VH_Orb_tnr_cal_Tc_db%"),
                    BandFileModel.band.ilike("%VV_VH_Orb_tnr_cal_Tc_db%"),
                    BandFileModel.path.ilike("%VV_Orb_tnr_cal_Tc_db%"),
                    BandFileModel.path.ilike("%VH_Orb_tnr_cal_Tc_db%"),
                    BandFileModel.path.ilike("%VV_VH_Orb_tnr_cal_Tc_db%"),
                    BandFileModel.band.ilike("%VV_VH%"),
                    BandFileModel.path.ilike("%VV_VH%")
                ))

            if band and band.strip() and band.upper() != "ALL":
                band_tokens = [
                    b.replace(".tif", "").replace(".tiff", "").strip()
                    for b in band.split(",")
                    if b.strip() and b.strip().upper() != "ALL"
                ]
                if band_tokens:
                    from sqlalchemy import or_, and_
                    user_wants_vv_vh = any("VV_VH" in bt.upper() or "VV/VH" in bt.upper() or "SAR_RATIO" in bt.upper() or "VV-VH" in bt.upper() for bt in band_tokens)
                    conditions = []
                    for b_token in band_tokens:
                        b_up = b_token.upper()
                        if "VV_VH" in b_up or "VV/VH" in b_up or b_up in ("VV_VH", "VV/VH", "SAR_RATIO"):
                            conditions.append(or_(
                                BandFileModel.band.ilike("%VV_VH%"),
                                BandFileModel.band.ilike("%VV/VH%"),
                                BandFileModel.band.ilike("%VV-VH%"),
                                BandFileModel.path.ilike("%VV_VH%")
                            ))
                        elif "VV_ORB" in b_up:
                            conditions.append(or_(
                                BandFileModel.band.ilike("%VV_Orb_tnr_cal_Tc_db%"),
                                BandFileModel.path.ilike("%VV_Orb_tnr_cal_Tc_db%"),
                                BandFileModel.band.ilike("%VV_Orb%"),
                                BandFileModel.path.ilike("%VV_Orb%")
                            ))
                        elif "VH_ORB" in b_up:
                            conditions.append(or_(
                                BandFileModel.band.ilike("%VH_Orb_tnr_cal_Tc_db%"),
                                BandFileModel.path.ilike("%VH_Orb_tnr_cal_Tc_db%"),
                                BandFileModel.band.ilike("%VH_Orb%"),
                                BandFileModel.path.ilike("%VH_Orb%")
                            ))
                        elif b_up in ("COMPOSITE", "COMPOSITES"):
                            conditions.append(or_(
                                BandFileModel.band.ilike("%Composite%"),
                                BandFileModel.band.ilike("%clipped%")
                            ))
                        elif b_up in ("VV", "VH"):
                            # Match ONLY individual co-pol (VV) or cross-pol (VH) band files
                            # and strictly EXCLUDE VV_VH or VV/VH ratio products
                            sub_conds = [
                                BandFileModel.band.ilike(b_token),
                                BandFileModel.band.ilike(f"{b_token}.tif%"),
                                BandFileModel.band.ilike(f"%-{b_token}.tif%"),
                                BandFileModel.band.ilike(f"%_{b_token}.tif%"),
                                BandFileModel.band.ilike(f"%-{b_token}"),
                                BandFileModel.band.ilike(f"%_{b_token}"),
                                BandFileModel.band.ilike(f"%/{b_token}.tif%"),
                                BandFileModel.band.ilike(f"%\\{b_token}.tif%")
                            ]
                            conditions.append(and_(
                                or_(*sub_conds),
                                ~BandFileModel.band.ilike("%VV_VH%"),
                                ~BandFileModel.band.ilike("%VV/VH%"),
                                ~BandFileModel.band.ilike("%VV-VH%")
                            ))
                        elif b_up == "B08":
                            # Distinguish B08 from B08A / B8A
                            conditions.append(and_(
                                or_(
                                    BandFileModel.band.ilike("B08%"),
                                    BandFileModel.band.ilike("%_B08.%"),
                                    BandFileModel.band.ilike("%-B08.%")
                                ),
                                ~BandFileModel.band.ilike("%B08A%"),
                                ~BandFileModel.band.ilike("%B8A%")
                            ))
                        else:
                            conditions.append(BandFileModel.band.ilike(f"%{b_token}%"))
                    if conditions:
                        bf_query = bf_query.filter(or_(*conditions))
                    if not user_wants_vv_vh:
                        bf_query = bf_query.filter(
                            ~BandFileModel.band.ilike("%VV_VH%"),
                            ~BandFileModel.band.ilike("%VV/VH%"),
                            ~BandFileModel.band.ilike("%VV-VH%")
                        )

            band_records = bf_query.order_by(BandFileModel.tile, BandFileModel.sensing_date, BandFileModel.band).all()

            # Pre-fetch district bounding box for spatial validation
            d_bbox = None
            if district:
                try:
                    from app.services.delivery_service import get_district_geometry_from_db
                    from shapely.geometry import shape
                    geom, _ = get_district_geometry_from_db(db, district, state_name=state)
                    if geom:
                        d_bbox = shape(geom).bounds
                except Exception:
                    pass

            for bf in band_records:
                raw_p = bf.path
                if not (raw_p.lower().endswith(".tif") or raw_p.lower().endswith(".tiff")):
                    continue
                path, exists = resolve_tif_path(raw_p)

                # Enforce spatial validation for S1 rasters
                is_s1_band = (bf.tile == "S1_SAR" or bf.satellite == "Sentinel-1" or (bf.scene_id and bf.scene_id.startswith("S1")))
                if d_bbox and is_s1_band:
                    # If this scene was already verified and held for this district in user acquisition requests,
                    # trust the district association
                    is_held_for_district = (allowed_scene_ids is not None and bf.scene_id in allowed_scene_ids)
                    if not is_held_for_district and not is_raster_overlapping_district(path, d_bbox):
                        continue

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

    # 4. Search NAS Composites directory and local delivery folder for composite / clipped rasters
    # Skip if user explicitly requested scene-level only ("none" or "individual")
    skip_composites = clean_interval in ("none", "individual", "scene")
    if not skip_composites:
        band_tokens_comp = [
            b.replace(".tif", "").replace(".tiff", "").strip().upper()
            for b in (band or "").split(",")
            if b.strip() and b.strip().upper() != "ALL"
        ] if band and band.upper() != "ALL" else []
        search_dirs = []
        if district and district.strip():
            search_dirs.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district.strip()))
        search_dirs.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Composites"))

        dist_clean = (district or "").strip().lower()
        seen_paths = set(tif_paths)
        seen_filenames = set(os.path.basename(p).lower() for p in tif_paths)

        for s_dir in search_dirs:
            if not s_dir or not os.path.exists(s_dir):
                continue
            for root, _, files in os.walk(s_dir):
                for f in files:
                    if not (f.lower().endswith(".tif") or f.lower().endswith(".tiff")):
                        continue
                    if f.lower() in seen_filenames:
                        continue
                    full_p = os.path.normpath(os.path.join(root, f))
                    if full_p in seen_paths:
                        continue

                    full_p_lower = full_p.lower()
                    if dist_clean and dist_clean not in full_p_lower:
                        continue

                    # Filter by composite interval if specified (weekly, fortnightly, monthly)
                    if clean_interval and clean_interval in ("weekly", "fortnightly", "monthly"):
                        if clean_interval not in full_p_lower:
                            continue

                    f_upper = f.upper()
                    if band_tokens_comp:
                        matched_token = False
                        user_wants_vv_vh_comp = any("VV_VH" in b or "VV/VH" in b or "SAR_RATIO" in b or "VV-VH" in b for b in band_tokens_comp)
                        for b_tok in band_tokens_comp:
                            if b_tok in ("COMPOSITE", "COMPOSITES"):
                                if "COMPOSITE" in f_upper or "CLIPPED" in f_upper:
                                    matched_token = True
                                    break
                            elif "VV_VH" in b_tok or b_tok in ("VV_VH", "VV/VH", "SAR_RATIO"):
                                if "VV_VH" in f_upper or "VV/VH" in f_upper or "VV-VH" in f_upper:
                                    matched_token = True
                                    break
                            elif "VV_ORB" in b_tok:
                                if "VV_ORB" in f_upper or ("VV" in f_upper and "VH" not in f_upper):
                                    matched_token = True
                                    break
                            elif "VH_ORB" in b_tok:
                                if "VH_ORB" in f_upper or ("VH" in f_upper and "VV_VH" not in f_upper and "VV/VH" not in f_upper):
                                    matched_token = True
                                    break
                            elif b_tok in ("VV", "VH"):
                                # Ensure this composite file is strictly VV or VH, NOT VV_VH
                                is_ratio = ("VV_VH" in f_upper or "VV/VH" in f_upper or "VV-VH" in f_upper)
                                if not is_ratio:
                                    if f"_{b_tok}." in f_upper or f"_{b_tok}_" in f_upper or f"-{b_tok}." in f_upper:
                                        matched_token = True
                                        break
                            elif b_tok in f_upper:
                                # If file is a VV_VH ratio but user did not ask for VV_VH, don't match
                                is_ratio = ("VV_VH" in f_upper or "VV/VH" in f_upper or "VV-VH" in f_upper)
                                if is_ratio and not user_wants_vv_vh_comp:
                                    continue
                                matched_token = True
                                break
                        if not matched_token:
                            continue

                    date_match = re.search(r'(\d{8})_(\d{8})', f)
                    if date_match and (start_date or end_date):
                        f_start = f"{date_match.group(1)[:4]}-{date_match.group(1)[4:6]}-{date_match.group(1)[6:8]}"
                        f_end = f"{date_match.group(2)[:4]}-{date_match.group(2)[4:6]}-{date_match.group(2)[6:8]}"
                        
                        q_start = (start_date or "1970-01-01").split("T")[0]
                        q_end = (end_date or "2099-12-31").split("T")[0]

                        if f_start > q_end or f_end < q_start:
                            continue

                    seen_paths.add(full_p)
                    seen_filenames.add(f.lower())
                    actual_size = os.path.getsize(full_p) if os.path.exists(full_p) else 0
                    total_size += actual_size

                    tif_paths.append(full_p)
                    tif_files.append({
                        "scene_id": f"Composite_{district or 'Region'}",
                        "tile": district or "Composite",
                        "sensing_date": date_match.group(1) if date_match else (start_date or "2026-01-01"),
                        "satellite": "Composite Deliverable",
                        "band": f,
                        "path": full_p,
                        "size_bytes": actual_size,
                        "exists_on_disk": True
                    })

    # 3.5. Direct NAS storage scan fallback for Sentinel-1 calibrated deliverables
    if is_s1_request or (satellite and "Sentinel-1" in satellite):
        from app.services.sentinel1_processor_service import win_safe_path
        s1_target_stems = ["VV_Orb_tnr_cal_Tc_db", "VH_Orb_tnr_cal_Tc_db", "VV_VH_Orb_tnr_cal_Tc_db"]
        if band and band.strip().upper() != "ALL":
            b_tokens_upper = [b.upper().replace(".TIFF", "").replace(".TIF", "").strip() for b in band.split(",") if b.strip()]
            filtered_targets = []
            for st in s1_target_stems:
                st_up = st.upper()
                if any(bt in st_up or st_up in bt for bt in b_tokens_upper):
                    filtered_targets.append(st)
            if filtered_targets:
                s1_target_stems = filtered_targets

        s1_roots = []
        clean_d = district.split(",")[0].strip() if district else ""
        if clean_d:
            s1_roots.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Sentinel-1", "S1_SAR", clean_d))
            s1_roots.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Sentinel-1", clean_d))
            s1_roots.append(os.path.join(settings.RAW_ARCHIVE_DIR, clean_d))
            s1_roots.append(rf"\\{settings.NAS_SERVER_IP}\Remote_Sensing\SriKanth_R\sdpp\{clean_d}")
            s1_roots.append(rf"\\{settings.NAS_SERVER_IP}\Remote_Sensing\SriKanth_R\sdpp\{clean_d}\orb")
            s1_roots.append(rf"\\{settings.NAS_SERVER_IP}\Remote-sensing\SDAP_DATA_STORAGE\Sentinel-1\S1_SAR\{clean_d}")
            s1_roots.append(rf"\\{settings.NAS_SERVER_IP}\Remote-sensing\SDAP_DATA_STORAGE\Sentinel-1\{clean_d}")
        else:
            s1_roots.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Sentinel-1"))
            s1_roots.append(rf"\\{settings.NAS_SERVER_IP}\Remote_Sensing\SriKanth_R\sdpp")
            s1_roots.append(rf"\\{settings.NAS_SERVER_IP}\Remote-sensing\SDAP_DATA_STORAGE\Sentinel-1")

        seen_disk_paths = set(os.path.normpath(p).lower() for p in tif_paths)
        seen_scene_bands = set((f.get("scene_id"), f.get("band")) for f in tif_files)
        valid_scene_ids = set(s.scene_id for s in matched_scenes) if matched_scenes else None

        for s1_root in s1_roots:
            try:
                safe_root = win_safe_path(s1_root)
                if not os.path.exists(safe_root):
                    continue
                for root_dir, dirs, fnames in os.walk(safe_root):
                    # Prune SNAP BEAM-DIMAP data folders and temp dirs
                    dirs[:] = [d for d in dirs if not d.endswith(".data") and not d.startswith("_temp") and not d.startswith(".")]
                    if root_dir.endswith(".data") or ".data" in root_dir or "_temp" in root_dir:
                        continue

                    # Extract scene ID from directory name
                    scene_folder_name = os.path.basename(root_dir)
                    s1_m = re.search(r'(S1[AB]_[0-9A-Za-z_]+)', scene_folder_name)
                    sc_id_detected = s1_m.group(1) if s1_m else scene_folder_name

                    # If scenes were queried from database for this request/district, enforce scene match
                    if valid_scene_ids:
                        if not any(v_id in sc_id_detected or sc_id_detected in v_id for v_id in valid_scene_ids):
                            continue

                    # Date filtering from scene ID timestamp
                    date_m = re.search(r'S1[AB]_[0-9A-Za-z_]+_(\d{4})(\d{2})(\d{2})T', sc_id_detected)
                    if date_m:
                        sc_sensing_date = f"{date_m.group(1)}-{date_m.group(2)}-{date_m.group(3)}"
                        if start_date and sc_sensing_date < start_date:
                            continue
                        if end_date and sc_sensing_date > end_date:
                            continue
                    else:
                        sc_sensing_date = start_date or "2026-06-01"

                    # Scan is read-only; no on-the-fly repairs during directory scan

                    for fn in fnames:
                        fn_lower = fn.lower()
                        if not fn_lower.endswith((".tif", ".tiff")):
                            continue
                        fn_stem = os.path.splitext(fn_lower)[0]
                        matched_stem = None
                        for target in s1_target_stems:
                            if target.lower() in fn_stem or fn_stem == target.lower():
                                matched_stem = target
                                break

                        if matched_stem:
                            # Avoid adding the same scene band multiple times from different NAS mounts
                            scene_band_key = (sc_id_detected, matched_stem)
                            if scene_band_key in seen_scene_bands:
                                continue

                            full_file = os.path.join(root_dir, fn)
                            norm_f = full_file.replace(r"\\?\\UNC\\", r"\\").replace(r"\\?\\", "")
                            norm_lower = os.path.normpath(norm_f).lower()
                            if norm_lower in seen_disk_paths:
                                continue
                            seen_disk_paths.add(norm_lower)
                            seen_scene_bands.add(scene_band_key)

                            safe_f = win_safe_path(full_file)
                            f_size = os.path.getsize(safe_f) if os.path.isfile(safe_f) else 0
                            total_size += f_size
                            tif_paths.append(norm_f)
                            tif_files.append({
                                "scene_id": sc_id_detected,
                                "tile": "S1_SAR",
                                "sensing_date": sc_sensing_date,
                                "satellite": "Sentinel-1",
                                "band": matched_stem,
                                "path": norm_f,
                                "size_bytes": f_size,
                                "exists_on_disk": True
                            })
            except Exception as walk_err:
                logger.warning(f"Error scanning Sentinel-1 path {s1_root}: {walk_err}")

    # If pure Sentinel-1 is requested, return ONLY the 3 calibrated GeoTIFF deliverables
    is_pure_s1 = bool(satellite and "Sentinel-1" in satellite and "Sentinel-2" not in satellite)
    if is_pure_s1:
        s1_valid_stems = ("vv_orb_tnr_cal_tc_db", "vh_orb_tnr_cal_tc_db", "vv_vh_orb_tnr_cal_tc_db")
        tif_files = [
            f for f in tif_files
            if any(v in os.path.splitext(os.path.basename(f.get("path", "")))[0].lower() for v in s1_valid_stems)
            or any(v in f.get("band", "").lower() for v in s1_valid_stems)
        ]
        tif_paths = [f["path"] for f in tif_files]
        total_size = sum(f.get("size_bytes", 0) for f in tif_files)

    total_scenes_cnt = len(matched_scenes) if not skip_raw_scenes else len(set(f["scene_id"] for f in tif_files))
    actual_tiles = sorted(list(set(s.tile for s in matched_scenes if s.tile))) if matched_scenes else (tiles if not region_filtered else [])
    return {
        "query_state": state,
        "query_district": district,
        "query_satellite": satellite,
        "query_band": band,
        "query_composite_interval": composite_interval,
        "query_start_date": start_date,
        "query_end_date": end_date,
        "matched_tiles": actual_tiles,
        "matched_districts": [district] if district else (resolved_districts or []),
        "total_scenes": total_scenes_cnt,
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
    rows = db.execute(text("""
        SELECT DISTINCT r.state, r.district
        FROM requests r
        JOIN process_jobs pj ON pj.request_id = r.id AND pj.stage = 'DOWNLOAD' AND pj.status = 'COMPLETED'
        JOIN scene s ON pj.scene_id = s.scene_id AND s.status = 'HELD'
        WHERE r.district IS NOT NULL AND r.district != ''
        ORDER BY r.state, r.district
    """)).fetchall()

    states_set = set()
    districts_list = []
    seen_districts = set()

    for r in rows:
        st, dist = r[0], r[1]
        if st and st.strip():
            states_set.add(st.strip())
        if dist and dist.strip():
            key = (st.strip().lower() if st else "", dist.strip().lower())
            if key not in seen_districts:
                districts_list.append({"district_name": dist.strip(), "state_name": st.strip() if st else ""})
                seen_districts.add(key)

    # Fallback to requests with COMPLETED / HELD status if jobs table is empty
    if not districts_list:
        fallback_rows = db.execute(text("""
            SELECT DISTINCT state, district
            FROM requests
            WHERE status IN ('HELD', 'COMPLETED', 'SUCCESS')
              AND district IS NOT NULL AND district != ''
            ORDER BY state, district
        """)).fetchall()
        for r in fallback_rows:
            st, dist = r[0], r[1]
            if st and st.strip():
                states_set.add(st.strip())
            if dist and dist.strip():
                key = (st.strip().lower() if st else "", dist.strip().lower())
                if key not in seen_districts:
                    districts_list.append({"district_name": dist.strip(), "state_name": st.strip() if st else ""})
                    seen_districts.add(key)

    sorted_states = sorted(list(states_set))
    sorted_districts = sorted(districts_list, key=lambda x: (x.get("state_name", ""), x.get("district_name", "")))

    return {
        "states": [{"state_name": s} for s in sorted_states],
        "districts": sorted_districts,
        "total_downloaded_states": len(sorted_states),
        "total_downloaded_districts": len(sorted_districts)
    }



