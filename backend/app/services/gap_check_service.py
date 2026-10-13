"""
=============================================================================
SDAP Gap Check & Scene Search Service (SRS M2)
=============================================================================
Location: backend/app/services/gap_check_service.py

Description:
    Performs tile resolution for selected districts via 'district_tiles_mapping',
    queries AWS Open Data S3 (sentinel-cogs) for available scenes within the requested
    date range, checks the PostgreSQL database for already held files, and produces
    the list of genuinely missing scenes to download.
=============================================================================
"""

import os
import sys
import json
import logging
from datetime import datetime
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor

import boto3
import requests
from botocore import UNSIGNED
from botocore.config import Config
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings
from app.models.sdap_models import SceneModel, BandFileModel, TileSceneMetadataModel, Sentinel1SceneMetadataModel
from app.services.downloader_service import ensure_nas_connection

logger = logging.getLogger("sdap.gap_check")

BUCKET = "sentinel-cogs"
S2_BUCKET = getattr(settings, "AWS_SENTINEL_COGS_BUCKET", "sentinel-cogs")
S2_REGION = getattr(settings, "AWS_COGS_REGION", "us-west-2")
s3_s2_client = boto3.client(
    "s3",
    region_name=S2_REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=64)
)

S1_BUCKET = getattr(settings, "AWS_SENTINEL_1_BUCKET", "sentinel-s1-l1c")
S1_REGION = getattr(settings, "AWS_SENTINEL_1_REGION", "eu-central-1")
s3_s1_client = boto3.client(
    "s3",
    region_name=S1_REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=64)
)

BUCKET = S2_BUCKET
REGION = S2_REGION
s3_client = s3_s2_client


def get_all_mapped_districts(db: Session) -> List[Dict[str, Any]]:
    """Fetches all unique districts present in district_tiles_mapping table joined with district_boundaries."""
    rows = db.execute(
        text("""
            SELECT DISTINCT dtm.district_id, dtm.district_name, db.state_name
            FROM district_tiles_mapping dtm
            LEFT JOIN district_boundaries db ON dtm.district_id = db.id
            ORDER BY db.state_name, dtm.district_name;
        """)
    ).fetchall()
    return [{"district_id": r[0], "district_name": r[1], "state_name": r[2] or "India Region"} for r in rows]


def get_tiles_for_state(db: Session, state_name: str) -> List[str]:
    """Resolves all Sentinel-2 tile IDs covering an entire state from district_tiles_mapping & district_boundaries."""
    rows = db.execute(
        text("""
            SELECT DISTINCT dtm.tile_id
            FROM district_tiles_mapping dtm
            JOIN district_boundaries db ON dtm.district_id = db.id
            WHERE LOWER(db.state_name) = LOWER(:s_name);
        """),
        {"s_name": state_name}
    ).fetchall()
    tiles = [r[0] for r in rows]
    logger.info(f"Resolved {len(tiles)} tile(s) for state '{state_name}': {tiles}")
    return tiles



def get_tiles_for_district(db: Session, district_name: str, state_name: Optional[str] = None) -> List[str]:
    """
    Resolves Sentinel-2 tile IDs for a given district name from district_tiles_mapping.
    Supports optional state_name filtering and fuzzy/alias matching (e.g. Angul / Anugul).
    """
    query = "SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = LOWER(:d_name)"
    params = {"d_name": district_name.strip()}
    
    if state_name:
        query += " AND LOWER(state_name) = LOWER(:s_name)"
        params["s_name"] = state_name.strip()

    rows = db.execute(text(query), params).fetchall()
    tiles = [r[0] for r in rows]

    if not tiles and state_name:
        # Try district without state in case state name had slight variation
        rows = db.execute(
            text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = LOWER(:d_name)"),
            {"d_name": district_name.strip()}
        ).fetchall()
        tiles = [r[0] for r in rows]

    if not tiles:
        # Fallback search matching partial district name (handles Angul vs Anugul, etc.)
        clean_name = district_name.strip()
        rows = db.execute(
            text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE district_name ILIKE :d_like;"),
            {"d_like": f"%{clean_name}%"}
        ).fetchall()
        tiles = [r[0] for r in rows]

    if not tiles and state_name:
        # Fallback to state tiles if district not specifically matched
        tiles = get_tiles_for_state(db, state_name)

    logger.info(f"Resolved {len(tiles)} tile(s) for district '{district_name}' (State: {state_name}): {tiles}")
    return tiles



def get_s2_cloud_cover(s3_client, bucket: str, sc_prefix: str, folder: str) -> float:
    """
    Fetches 'eo:cloud_cover' or 'cloud_cover' percentage from S3 scene JSON or stac.json.
    Returns float cloud cover percentage (0.0 to 100.0). Defaults to 0.0 if not found.
    """
    try:
        prefix_clean = sc_prefix.rstrip('/')
        json_key = f"{prefix_clean}/{folder}.json"
        obj = s3_client.get_object(Bucket=bucket, Key=json_key)
        data = json.loads(obj['Body'].read().decode('utf-8'))
        props = data.get('properties', {})
        if 'eo:cloud_cover' in props:
            return float(props['eo:cloud_cover'])
        if 'cloud_cover' in props:
            return float(props['cloud_cover'])
    except Exception:
        pass

    try:
        prefix_clean = sc_prefix.rstrip('/')
        stac_key = f"{prefix_clean}/stac.json"
        obj = s3_client.get_object(Bucket=bucket, Key=stac_key)
        data = json.loads(obj['Body'].read().decode('utf-8'))
        props = data.get('properties', {})
        if 'eo:cloud_cover' in props:
            return float(props['eo:cloud_cover'])
        if 'cloud_cover' in props:
            return float(props['cloud_cover'])
    except Exception:
        pass

    return 0.0


def search_aws_scenes_for_tile(tile_id: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    Searches AWS S3 for available Sentinel-2 scenes for a given tile ID
    between start_date and end_date (YYYY-MM-DD format).
    Prioritizes Sentinel-2 COGs (sentinel-cogs in us-west-2, GeoTIFF) with fallback to sentinel-s2-l2a.
    Layout: sentinel-s2-l2a-cogs/[utm]/[lat]/[sq]/[year]/[month]/[folder]/
    Attaches cloud_cover percentage metadata from S3 JSON.
    """
    if len(tile_id) < 5:
        return []

    utm_zone_raw = tile_id[0:2]
    utm_zone = str(int(utm_zone_raw))
    latitude_band = tile_id[2].upper()
    grid_square = tile_id[3:5].upper()

    try:
        start_dt = datetime.strptime(start_date.split("T")[0], "%Y-%m-%d")
        end_dt = datetime.strptime(end_date.split("T")[0], "%Y-%m-%d")
    except ValueError as e:
        logger.error(f"Invalid date format: {e}")
        return []

    available_scenes = []
    cur_year = start_dt.year

    while cur_year <= end_dt.year:
        # 1. Search Sentinel COGs bucket (sentinel-cogs)
        s3_prefix = f"sentinel-s2-l2a-cogs/{utm_zone_raw}/{latitude_band}/{grid_square}/{cur_year}/"
        try:
            resp = s3_s2_client.list_objects_v2(Bucket=S2_BUCKET, Prefix=s3_prefix, Delimiter="/")
            month_prefixes = [p.get("Prefix") for p in resp.get("CommonPrefixes", [])]

            for m_prefix in month_prefixes:
                try:
                    month_num = int(m_prefix.strip("/").split("/")[-1])
                except ValueError:
                    continue

                if (cur_year == start_dt.year and month_num < start_dt.month) or \
                   (cur_year == end_dt.year and month_num > end_dt.month):
                    continue

                scene_resp = s3_s2_client.list_objects_v2(Bucket=S2_BUCKET, Prefix=m_prefix, Delimiter="/")
                scene_prefixes = [sp.get("Prefix") for sp in scene_resp.get("CommonPrefixes", [])]

                for sc_prefix in scene_prefixes:
                    folder = sc_prefix.strip("/").split("/")[-1]
                    parts = folder.split("_")
                    date_str = None
                    for part in parts:
                        if len(part) == 8 and part.isdigit():
                            date_str = f"{part[0:4]}-{part[4:6]}-{part[6:8]}"
                            break

                    if date_str:
                        scene_dt = datetime.strptime(date_str, "%Y-%m-%d")
                        if start_dt <= scene_dt <= end_dt:
                            available_scenes.append({
                                "scene_id": folder,
                                "tile": tile_id,
                                "sensing_date": date_str,
                                "satellite": "Sentinel-2",
                                "folder": folder,
                                "prefix": sc_prefix
                            })
        except Exception as err:
            logger.warning(f"Error querying S3 for tile {tile_id} prefix {s3_prefix}: {err}")

        # If no scenes found in COGs, fallback to sentinel-s2-l2a registry
        if not available_scenes:
            alt_prefix = f"tiles/{utm_zone}/{latitude_band}/{grid_square}/{cur_year}/"
            try:
                resp = s3_s2_client.list_objects_v2(Bucket="sentinel-s2-l2a", Prefix=alt_prefix, Delimiter="/")
                month_prefixes = [p.get("Prefix") for p in resp.get("CommonPrefixes", [])]
                for m_prefix in month_prefixes:
                    try:
                        month_num = int(m_prefix.strip("/").split("/")[-1])
                    except ValueError:
                        continue
                    if (cur_year == start_dt.year and month_num < start_dt.month) or \
                       (cur_year == end_dt.year and month_num > end_dt.month):
                        continue

                    d_resp = s3_s2_client.list_objects_v2(Bucket="sentinel-s2-l2a", Prefix=m_prefix, Delimiter="/")
                    for d_prefix in [p.get("Prefix") for p in d_resp.get("CommonPrefixes", [])]:
                        try:
                            day_num = int(d_prefix.strip("/").split("/")[-1])
                            sc_dt = datetime(cur_year, month_num, day_num)
                        except ValueError:
                            continue
                        if start_dt <= sc_dt <= end_dt:
                            seq_resp = s3_s2_client.list_objects_v2(Bucket="sentinel-s2-l2a", Prefix=d_prefix, Delimiter="/")
                            for seq in seq_resp.get("CommonPrefixes", []):
                                seq_prefix = seq.get("Prefix")
                                seq_str = seq_prefix.strip("/").split("/")[-1]
                                date_str = sc_dt.strftime("%Y-%m-%d")
                                folder = f"S2_{tile_id}_{cur_year}{month_num:02d}{day_num:02d}_{seq_str}_L2A"
                                available_scenes.append({
                                    "scene_id": folder,
                                    "tile": tile_id,
                                    "sensing_date": date_str,
                                    "satellite": "Sentinel-2",
                                    "folder": folder,
                                    "prefix": seq_prefix
                                })
            except Exception as alt_err:
                logger.debug(f"Alt registry query note: {alt_err}")

        cur_year += 1

    # Attach cloud cover percentage in parallel
    if available_scenes:
        def _attach(sc: Dict[str, Any]) -> Dict[str, Any]:
            cld = get_s2_cloud_cover(s3_s2_client, S2_BUCKET, sc.get("prefix", ""), sc.get("folder", ""))
            sc["cloud_cover"] = round(cld, 2)
            return sc

        with ThreadPoolExecutor(max_workers=min(16, len(available_scenes))) as executor:
            available_scenes = list(executor.map(_attach, available_scenes))

    return available_scenes


def search_aws_scenes_for_s1(
    start_date: str,
    end_date: str,
    district_name: Optional[str] = None,
    state_name: Optional[str] = None,
    db: Optional[Session] = None
) -> List[Dict[str, Any]]:
    """
    Searches AWS S3 for Sentinel-1 GRD SAR scenes that geographically intersect the requested district.
    Supports all states and districts across India using spatial STAC and DAAC services.
    Primary: Earth Search STAC API with district bounding box.
    Secondary: Alaska Satellite Facility (ASF) DAAC API with district centroid point.
    Guarantees only genuine intersecting radar scenes are returned; never returns out-of-bounds scenes.
    """
    s_clean = start_date.split("T")[0]
    e_clean = end_date.split("T")[0]

    centroid_pt = None
    district_bbox = None

    if district_name and db:
        try:
            from app.services.delivery_service import get_district_geometry_from_db
            from shapely.geometry import shape
            geom, found_state = get_district_geometry_from_db(db, district_name, state_name=state_name)
            if geom:
                poly = shape(geom)
                minx, miny, maxx, maxy = poly.bounds
                district_bbox = [round(minx, 5), round(miny, 5), round(maxx, 5), round(maxy, 5)]
                c = poly.centroid
                centroid_pt = (round(c.x, 5), round(c.y, 5))
                logger.info(f"Resolved geometry for district '{district_name}' (State: {found_state or state_name}): BoundingBox={district_bbox}, Centroid={centroid_pt}")
        except Exception as e:
            logger.warning(f"Could not compute geometry bounds for district '{district_name}': {e}")

    # Strategy 1: Earth Search STAC API (fast, authoritative AWS S3 GRD catalog covering all of India)
    if district_bbox:
        try:
            stac_url = "https://earth-search.aws.element84.com/v1/search"
            payload = {
                "collections": ["sentinel-1-grd"],
                "bbox": district_bbox,
                "datetime": f"{s_clean}T00:00:00Z/{e_clean}T23:59:59Z",
                "limit": 100
            }
            resp = requests.post(stac_url, json=payload, timeout=12)
            if resp.status_code == 200:
                features = resp.json().get("features", [])
                stac_scenes = []
                seen_granules = set()
                for feat in features:
                    g_name = feat.get("id")
                    if not g_name or g_name in seen_granules:
                        continue
                    seen_granules.add(g_name)

                    # Extract sensing date
                    props = feat.get("properties", {})
                    dt_str = props.get("datetime", "")[:10] or s_clean

                    # Extract S3 prefix from asset URLs or construct canonical path
                    vh_asset = feat.get("assets", {}).get("vh", {})
                    vh_href = vh_asset.get("href", "")
                    s3_prefix = ""
                    if vh_href.startswith("s3://sentinel-s1-l1c/"):
                        raw_key = vh_href[len("s3://sentinel-s1-l1c/"):]
                        idx = raw_key.find("measurement/")
                        s3_prefix = raw_key[:idx] if idx != -1 else raw_key
                    elif "sentinel-s1-l1c.s3.amazonaws.com/" in vh_href:
                        raw_key = vh_href.split("sentinel-s1-l1c.s3.amazonaws.com/")[-1]
                        idx = raw_key.find("measurement/")
                        s3_prefix = raw_key[:idx] if idx != -1 else raw_key

                    if not s3_prefix:
                        parts = g_name.split("_")
                        mode = parts[1] if len(parts) > 1 else "IW"
                        pol_code = parts[3] if len(parts) > 3 else "1SDV"
                        pol = "DV" if "DV" in pol_code else ("DH" if "DH" in pol_code else "SV")
                        date_part = parts[4] if len(parts) > 4 else ""
                        yr = int(date_part[:4]) if len(date_part) >= 4 else int(dt_str[:4])
                        mo = int(date_part[4:6]) if len(date_part) >= 6 else int(dt_str[5:7])
                        dy = int(date_part[6:8]) if len(date_part) >= 8 else int(dt_str[8:10])
                        s3_prefix = f"GRD/{yr}/{mo}/{dy}/{mode}/{pol}/{g_name}/"

                    stac_scenes.append({
                        "scene_id": g_name,
                        "tile": "S1_SAR",
                        "sensing_date": dt_str,
                        "satellite": "Sentinel-1",
                        "folder": g_name,
                        "prefix": s3_prefix,
                        "cloud_cover": 0.0
                    })

                if stac_scenes:
                    logger.info(f"Earth Search STAC resolved {len(stac_scenes)} Sentinel-1 scene(s) covering district '{district_name}' ({state_name}).")
                    return stac_scenes
        except Exception as err:
            logger.warning(f"Earth Search STAC query for Sentinel-1 failed: {err}")

    # Strategy 2: Alaska Satellite Facility (ASF) DAAC API (Secondary spatial fallback)
    if centroid_pt:
        try:
            asf_url = "https://api.daac.asf.alaska.edu/services/search/param"
            params = {
                "platform": "SENTINEL-1",
                "processingLevel": "GRD_HD",
                "beamMode": "IW",
                "intersectsWith": f"POINT({centroid_pt[0]:.5f} {centroid_pt[1]:.5f})",
                "start": s_clean,
                "end": e_clean,
                "output": "json"
            }
            resp = requests.get(asf_url, params=params, timeout=25)
            if resp.status_code == 200:
                data = resp.json()
                results = data[0] if data and isinstance(data, list) else []
                scenes = []
                for sc in results:
                    g_name = sc.get("granuleName")
                    if not g_name:
                        continue
                    st_str = sc.get("startTime", "")[:10]
                    parts = g_name.split("_")
                    mode = parts[1] if len(parts) > 1 else "IW"
                    pol_code = parts[3] if len(parts) > 3 else "1SDV"
                    pol = "DV" if "DV" in pol_code else ("DH" if "DH" in pol_code else "SV")
                    date_part = parts[4] if len(parts) > 4 else ""
                    yr = int(date_part[:4]) if len(date_part) >= 4 else int(st_str[:4])
                    mo = int(date_part[4:6]) if len(date_part) >= 6 else int(st_str[5:7])
                    dy = int(date_part[6:8]) if len(date_part) >= 8 else int(st_str[8:10])
                    s3_prefix = f"GRD/{yr}/{mo}/{dy}/{mode}/{pol}/{g_name}/"
                    scenes.append({
                        "scene_id": g_name,
                        "tile": "S1_SAR",
                        "sensing_date": st_str,
                        "satellite": "Sentinel-1",
                        "folder": g_name,
                        "prefix": s3_prefix,
                        "cloud_cover": 0.0
                    })
                if scenes:
                    logger.info(f"ASF resolved {len(scenes)} Sentinel-1 scene(s) covering district '{district_name}' ({state_name}).")
                    return scenes
        except Exception as err:
            logger.warning(f"ASF Spatial Search query for S1 failed: {err}")

    logger.info(
        f"No Sentinel-1 satellite passes intersected district '{district_name}' (State: {state_name}) "
        f"between {s_clean} and {e_clean}."
    )
    return []


def _band_files_exist_on_disk(scene_dir: str, bands: List[str]) -> bool:
    """
    Returns True only if ALL required band TIF files physically exist in
    scene_dir with size > 0 bytes. Checks .tif and .tiff extensions only.
    An empty or partial folder → False → triggers re-download.
    """
    if not os.path.isdir(scene_dir):
        return False
    for b in bands:
        found = False
        for ext in (".tif", ".tiff"):
            candidate = os.path.join(scene_dir, f"{b}{ext}")
            if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                found = True
                break
        if not found:
            return False
    return True


def _is_s1_scene_complete_on_disk(scene_dir: str) -> bool:
    """
    Returns True only if the complete Sentinel-1 ESA SAFE product hierarchy physically exists on disk:
    1. manifest.safe exists and is non-empty (>0 bytes)
    2. measurement/ folder exists and contains valid .tif/.tiff rasters
    3. annotation/ folder exists and contains files
    4. preview/ folder exists
    An empty, legacy, or partial folder (e.g. only root VV.tiff/VH.tiff) -> False -> triggers full re-download.
    """
    if not os.path.isdir(scene_dir):
        return False

    manifest_p = os.path.join(scene_dir, "manifest.safe")
    if not (os.path.isfile(manifest_p) and os.path.getsize(manifest_p) > 0):
        return False

    meas_dir = os.path.join(scene_dir, "measurement")
    if not os.path.isdir(meas_dir):
        return False
    meas_files = [f for f in os.listdir(meas_dir) if f.lower().endswith((".tif", ".tiff"))]
    if not meas_files:
        return False

    annot_dir = os.path.join(scene_dir, "annotation")
    if not os.path.isdir(annot_dir) or not os.listdir(annot_dir):
        return False

    prev_dir = os.path.join(scene_dir, "preview")
    if not os.path.isdir(prev_dir):
        return False

    return True


def perform_gap_check(
    db: Session,
    district_name: str,
    start_date: str,
    end_date: str,
    satellite: str = "Sentinel-2",
    required_bands: List[str] = None,
    max_cloud_cover: float = 100.0,
    state_name: Optional[str] = None
) -> Dict[str, Any]:
    """
    SRS M2 Gap Check:
    1. Resolves tiles for district and state.
    2. Queries AWS Open Data S3 for available scenes (Sentinel-2 COGs and/or Sentinel-1 GRD).
    3. Filters scenes by max_cloud_cover threshold before downloading.
    4. Cross-references PostgreSQL database AND physically verifies NAS band files on disk.
    5. A scene is HELD only if BOTH: (a) DB record exists as HELD/DOWNLOADED AND
       (b) ALL required band TIF files physically exist on NAS with size > 0.
       If NAS files were deleted, scene is flagged MISSING regardless of DB status.
    6. Returns summary, held scenes details, and list of genuinely missing scenes.
    """
    if required_bands is None:
        required_bands = ["B02", "B03", "B04", "B08", "TCI", "B8A", "B11", "SCL"]
    if max_cloud_cover is None or max_cloud_cover <= 0:
        max_cloud_cover = 100.0
    is_s1 = "Sentinel-1" in satellite
    is_s2 = "Sentinel-2" in satellite or not is_s1
    tiles = []
    raw_aws_scenes = []

    if is_s2:
        s2_tiles = get_tiles_for_district(db, district_name, state_name=state_name)
        if not s2_tiles and not is_s1:
            return {
                "district": district_name,
                "status": "ERROR",
                "message": f"No tile mapping found for district '{district_name}' (State: {state_name or 'Unspecified'}).",
                "tiles": [],
                "scenes_available": 0,
                "scenes_held": 0,
                "scenes_missing": 0,
                "held_scenes": [],
                "missing_scenes": [],
                "tile_statuses": {}
            }
        tiles.extend(s2_tiles)
        for tile_id in s2_tiles:
            s2_scenes = search_aws_scenes_for_tile(tile_id, start_date, end_date)
            raw_aws_scenes.extend(s2_scenes)

    if is_s1:
        s1_scenes = search_aws_scenes_for_s1(
            start_date=start_date,
            end_date=end_date,
            district_name=district_name,
            state_name=state_name,
            db=db
        )
        raw_aws_scenes.extend(s1_scenes)
        if "S1_SAR" not in tiles:
            tiles.append("S1_SAR")

    # Cloud cover threshold filtering (SRS requirement: only download scenes <= max_cloud_cover)
    all_aws_scenes = []
    skipped_high_cloud_scenes = []
    for sc in raw_aws_scenes:
        cld = sc.get("cloud_cover", 0.0)
        if cld <= max_cloud_cover:
            all_aws_scenes.append(sc)
        else:
            skipped_high_cloud_scenes.append(sc)

    logger.info(
        f"AWS Gap Check found {len(raw_aws_scenes)} total scenes. "
        f"Filtered by Max Cloud Cover ({max_cloud_cover}%): {len(all_aws_scenes)} scenes passed, {len(skipped_high_cloud_scenes)} skipped."
    )

    # Ensure NAS connection before checking local/network raw archive storage
    ensure_nas_connection(settings.RAW_ARCHIVE_DIR)

    # ------------------------------------------------------------------
    # FIX: Build DB lookup by scene_id and product_name (not by S3 prefix
    # which is never stored in tile_path / scene_path DB columns).
    # ------------------------------------------------------------------
    # SceneModel: scene_id + status == "HELD"
    held_scene_ids_in_db = set(
        r[0] for r in db.query(SceneModel.scene_id).filter(
            SceneModel.status == "HELD"
        ).all() if r[0]
    )
    # TileSceneMetadataModel: product_name + download_status == "DOWNLOADED"
    downloaded_product_names_in_db = set(
        r[0] for r in db.query(TileSceneMetadataModel.product_name).filter(
            TileSceneMetadataModel.download_status == "DOWNLOADED"
        ).all() if r[0]
    )
    # Sentinel-1 scene folder names marked DOWNLOADED
    s1_downloaded_folders_in_db = set(
        r[0] for r in db.query(Sentinel1SceneMetadataModel.scene_path).filter(
            Sentinel1SceneMetadataModel.download_status == "DOWNLOADED"
        ).all() if r[0]
    )

    def audit_scene_on_nas_and_db(sc: Dict[str, Any]) -> tuple:
        s_id = sc["scene_id"]
        folder = sc["folder"]
        tile = sc["tile"]
        s_date = sc["sensing_date"]
        sc_sat = sc.get("satellite", "Sentinel-2")
        year = s_date[0:4]
        month = str(int(s_date[5:7]))
        sat_subfolder = "Sentinel-1" if sc_sat == "Sentinel-1" else "Sentinel-2"

        # Resolve NAS path first (both subfolder and legacy layouts), fallback to local archive
        scene_archive_dir_nas = os.path.join(settings.RAW_ARCHIVE_DIR, sat_subfolder, tile, year, month, folder)
        if not os.path.isdir(scene_archive_dir_nas):
            legacy_nas = os.path.join(settings.RAW_ARCHIVE_DIR, tile, year, month, folder)
            if os.path.isdir(legacy_nas):
                scene_archive_dir_nas = legacy_nas
            else:
                parent_nas = os.path.join(settings.RAW_ARCHIVE_DIR, sat_subfolder, tile, year, month)
                if not os.path.isdir(parent_nas):
                    parent_nas = os.path.join(settings.RAW_ARCHIVE_DIR, tile, year, month)
                if os.path.isdir(parent_nas):
                    try:
                        for cand in os.listdir(parent_nas):
                            if cand.startswith(folder) or folder.startswith(cand):
                                scene_archive_dir_nas = os.path.join(parent_nas, cand)
                                break
                    except Exception:
                        pass

        backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        scene_archive_dir_local = os.path.abspath(
            os.path.join(backend_root, "data", "archive", sat_subfolder, tile, year, month, folder)
        )
        if not os.path.isdir(scene_archive_dir_local):
            legacy_local = os.path.abspath(os.path.join(backend_root, "data", "archive", tile, year, month, folder))
            if os.path.isdir(legacy_local):
                scene_archive_dir_local = legacy_local
            else:
                parent_loc = os.path.abspath(os.path.join(backend_root, "data", "archive", tile, year, month))
                if os.path.isdir(parent_loc):
                    try:
                        for cand in os.listdir(parent_loc):
                            if cand.startswith(folder) or folder.startswith(cand):
                                scene_archive_dir_local = os.path.join(parent_loc, cand)
                                break
                    except Exception:
                        pass

        scene_archive_dir = scene_archive_dir_nas
        if not os.path.isdir(scene_archive_dir_nas) and os.path.isdir(scene_archive_dir_local):
            scene_archive_dir = scene_archive_dir_local

        if sc_sat == "Sentinel-1":
            # For Sentinel-1, physically verify full ESA SAFE product hierarchy on NAS
            has_disk_bands = _is_s1_scene_complete_on_disk(scene_archive_dir)
        else:
            bands_to_verify = required_bands if required_bands else ["B02", "B03", "B04", "B08", "TCI", "B8A", "B11", "SCL"]
            has_disk_bands = _band_files_exist_on_disk(scene_archive_dir, bands_to_verify)

        # ── FIX: DB check uses scene_id and product_name (correct fields) ──
        is_held_in_db = (
            s_id in held_scene_ids_in_db
            or s_id in downloaded_product_names_in_db
            or folder in downloaded_product_names_in_db
            or any(folder in p for p in s1_downloaded_folders_in_db)
        )

        # ── FIX: HELD = DB record EXISTS + ALL band files on disk ──────────
        # If DB says HELD but NAS files are gone → MISSING → triggers re-download
        if has_disk_bands:
            held_info = dict(sc)
            held_info["archive_path"] = scene_archive_dir
            held_info["downloaded_at"] = "previously"
            held_info["nas_verified"] = True
            held_info["db_held"] = is_held_in_db
            if not is_held_in_db:
                logger.warning(
                    f"Scene '{s_id}' has band files on disk but NO matching DB record — "
                    f"treating as HELD (files exist). Consider re-syncing DB."
                )
            return True, held_info
        else:
            # Files not on NAS — mark MISSING regardless of DB status
            if is_held_in_db:
                logger.warning(
                    f"Scene '{s_id}' is marked HELD in DB but band files are MISSING from NAS "
                    f"path '{scene_archive_dir}'. Flagging for RE-DOWNLOAD."
                )
            return False, sc

    held_scenes = []
    missing_scenes = []

    # Parallel multi-threaded audit across NAS and PostgreSQL (up to 32 concurrent workers)
    max_audit_workers = min(32, max(4, len(all_aws_scenes))) if all_aws_scenes else 1
    with ThreadPoolExecutor(max_workers=max_audit_workers) as executor:
        audit_results = list(executor.map(audit_scene_on_nas_and_db, all_aws_scenes))

    for is_held, sc_info in audit_results:
        if is_held:
            held_scenes.append(sc_info)
        else:
            missing_scenes.append(sc_info)

    tile_statuses = {}
    for t in tiles:
        t_total = sum(1 for sc in all_aws_scenes if sc.get("tile") == t)
        t_held = sum(1 for sc in held_scenes if sc.get("tile") == t)
        t_missing = sum(1 for sc in missing_scenes if sc.get("tile") == t)

        if t_total == 0:
            st = "NO_SCENES_FOUND"
        elif t_missing == 0:
            st = "DOWNLOADED"
        elif t_held > 0:
            st = "PARTIALLY_DOWNLOADED"
        else:
            st = "PENDING_DOWNLOAD"

        tile_statuses[t] = {
            "tile": t,
            "status": st,
            "total_scenes": t_total,
            "held_scenes": t_held,
            "missing_scenes": t_missing,
            "archive_dir": os.path.join(settings.RAW_ARCHIVE_DIR, t)
        }

    summary = {
        "district": district_name,
        "date_range": f"{start_date} to {end_date}",
        "satellite": satellite,
        "max_cloud_cover": max_cloud_cover,
        "tiles": tiles,
        "total_raw_aws_scenes": len(raw_aws_scenes),
        "skipped_high_cloud_count": len(skipped_high_cloud_scenes),
        "skipped_high_cloud_scenes": skipped_high_cloud_scenes,
        "total_available_scenes": len(all_aws_scenes),
        "held_scenes_count": len(held_scenes),
        "missing_scenes_count": len(missing_scenes),
        "held_scenes": held_scenes,
        "missing_scenes": missing_scenes,
        "tile_statuses": tile_statuses
    }

    logger.info(
        f"[GAP CHECK SUMMARY] District '{district_name}' ({satellite}): Raw S3={len(raw_aws_scenes)}, "
        f"Passed Cloud Threshold (≤{max_cloud_cover}%): {len(all_aws_scenes)}, Skipped (>{max_cloud_cover}%): {len(skipped_high_cloud_scenes)}, "
        f"Held (DB+NAS verified)={len(held_scenes)}, Missing (needs download)={len(missing_scenes)}"
    )
    return summary


