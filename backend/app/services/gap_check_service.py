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



def search_aws_scenes_for_tile(tile_id: str, start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    Searches AWS S3 for available Sentinel-2 scenes for a given tile ID
    between start_date and end_date (YYYY-MM-DD format).
    Prioritizes Sentinel-2 COGs (sentinel-cogs in us-west-2, GeoTIFF) with fallback to sentinel-s2-l2a.
    Layout: sentinel-s2-l2a-cogs/[utm]/[lat]/[sq]/[year]/[month]/[folder]/
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

    return available_scenes
def search_aws_scenes_for_s1(start_date: str, end_date: str) -> List[Dict[str, Any]]:
    """
    Searches AWS S3 (sentinel-s1-l1c in eu-central-1) for available Sentinel-1 GRD SAR products
    between start_date and end_date (YYYY-MM-DD format).
    Layout: GRD/[year]/[month]/[day]/[mode]/[polarization]/[product]/
    """
    try:
        start_dt = datetime.strptime(start_date.split("T")[0], "%Y-%m-%d")
        end_dt = datetime.strptime(end_date.split("T")[0], "%Y-%m-%d")
    except ValueError as e:
        logger.error(f"Invalid date format for S1 search: {e}")
        return []

    available_scenes = []
    delta_days = max(1, (end_dt - start_dt).days)
    step_days = 12 if delta_days > 60 else (6 if delta_days > 20 else 1)

    cur_dt = start_dt
    while cur_dt <= end_dt:
        y = cur_dt.year
        m = cur_dt.month
        d = cur_dt.day
        date_str = cur_dt.strftime("%Y-%m-%d")

        for mode_pol in ["S1/DV", "IW/DV"]:
            s3_prefix = f"GRD/{y}/{m}/{d}/{mode_pol}/"
            try:
                resp = s3_s1_client.list_objects_v2(Bucket=S1_BUCKET, Prefix=s3_prefix, Delimiter="/", MaxKeys=2)
                for sc in resp.get("CommonPrefixes", []):
                    sc_prefix = sc.get("Prefix")
                    folder = sc_prefix.strip("/").split("/")[-1]
                    available_scenes.append({
                        "scene_id": folder,
                        "tile": "S1_SAR",
                        "sensing_date": date_str,
                        "satellite": "Sentinel-1",
                        "folder": folder,
                        "prefix": sc_prefix
                    })
                    break
                if any(s["sensing_date"] == date_str for s in available_scenes):
                    break
            except Exception as err:
                logger.debug(f"Error querying S1 prefix {s3_prefix}: {err}")

        cur_dt += timedelta(days=step_days)

    return available_scenes


def perform_gap_check(
    db: Session,
    district_name: str,
    start_date: str,
    end_date: str,
    satellite: str = "Sentinel-2",
    required_bands: List[str] = None
) -> Dict[str, Any]:
    """
    SRS M2 Gap Check:
    1. Resolves tiles for district.
    2. Queries AWS Open Data S3 for available scenes.
    2. Queries AWS Open Data S3 for available scenes (Sentinel-2 COGs and/or Sentinel-1 GRD).
    3. Cross-references PostgreSQL database (tile_scene_metadata & scene) for held/verified files.
    4. Returns summary, held scenes details, and list of genuinely missing scenes.
    """
    if required_bands is None:
        required_bands = ["B02", "B03", "B04", "B08", "TCI", "B8A", "B11", "SCL"]
    is_s1 = "Sentinel-1" in satellite
    is_s2 = "Sentinel-2" in satellite or not is_s1
    tiles = []
    all_aws_scenes = []

    if is_s2:
        s2_tiles = get_tiles_for_district(db, district_name)
        if not s2_tiles and not is_s1:
            return {
                "district": district_name,
                "status": "ERROR",
                "message": f"No tile mapping found for district '{district_name}'.",
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
            all_aws_scenes.extend(s2_scenes)

    if is_s1:
        s1_scenes = search_aws_scenes_for_s1(start_date, end_date)
        all_aws_scenes.extend(s1_scenes)
        if "S1_SAR" not in tiles:
            tiles.append("S1_SAR")

    logger.info(f"AWS Gap Check found {len(all_aws_scenes)} total scenes available across tiles {tiles} (Satellite: {satellite}).")

    # Ensure NAS connection before checking local/network raw archive storage
    ensure_nas_connection(settings.RAW_ARCHIVE_DIR)

    held_scenes = []
    missing_scenes = []

    # Bulk pre-fetch database records for ultra-fast O(1) in-memory deduplication lookup
    s1_downloaded_paths = set(
        r[0] for r in db.query(Sentinel1SceneMetadataModel.scene_path).filter(
            Sentinel1SceneMetadataModel.download_status == "DOWNLOADED"
        ).all() if r[0]
    )
    s2_downloaded_paths = set(
        r[0] for r in db.query(TileSceneMetadataModel.tile_path).filter(
            TileSceneMetadataModel.download_status == "DOWNLOADED"
        ).all() if r[0]
    )
    held_scene_ids = set(
        r[0] for r in db.query(SceneModel.scene_id).filter(
            SceneModel.status == "HELD"
        ).all() if r[0]
    )

    def audit_scene_on_nas_and_db(sc: Dict[str, Any]) -> tuple[bool, Dict[str, Any]]:
        s_id = sc["scene_id"]
        folder = sc["folder"]
        tile = sc["tile"]
        s_date = sc["sensing_date"]
        sc_sat = sc.get("satellite", "Sentinel-2")
        prefix = sc.get("prefix", "")
        year = s_date[0:4]
        month = str(int(s_date[5:7]))

        scene_archive_dir_nas = os.path.join(settings.RAW_ARCHIVE_DIR, tile, year, month, folder)
        backend_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        scene_archive_dir_local = os.path.abspath(os.path.join(backend_root, "data", "archive", tile, year, month, folder))

        scene_archive_dir = scene_archive_dir_nas
        if not os.path.exists(scene_archive_dir_nas) and os.path.exists(scene_archive_dir_local):
            scene_archive_dir = scene_archive_dir_local

        bands_to_verify = ["VV", "VH"] if sc_sat == "Sentinel-1" else (required_bands if required_bands else ["B02", "B03", "B04", "B08", "TCI", "B8A", "B11", "SCL"])

        # Check if band rasters exist on disk (strictly GeoTIFFs: .tif, .tiff with >0 bytes)
        has_disk_bands = False
        if os.path.exists(scene_archive_dir):
            disk_bands_present = [
                b for b in bands_to_verify
                if any(os.path.exists(os.path.join(scene_archive_dir, f"{b}{ext}")) and os.path.getsize(os.path.join(scene_archive_dir, f"{b}{ext}")) > 0 for ext in ("", ".tif", ".tiff"))
            ]
            has_disk_bands = (len(disk_bands_present) >= len(bands_to_verify))

        # Check in-memory DB sets
        is_held_in_db = (prefix in s1_downloaded_paths or prefix in s2_downloaded_paths or s_id in held_scene_ids)

        if (is_held_in_db and os.path.exists(scene_archive_dir)) or has_disk_bands:
            held_info = dict(sc)
            held_info["archive_path"] = scene_archive_dir
            held_info["downloaded_at"] = "previously"
            return True, held_info
        else:
            return False, sc

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
        "tiles": tiles,
        "total_available_scenes": len(all_aws_scenes),
        "held_scenes_count": len(held_scenes),
        "missing_scenes_count": len(missing_scenes),
        "held_scenes": held_scenes,
        "missing_scenes": missing_scenes,
        "tile_statuses": tile_statuses
    }

    logger.info(f"[GAP CHECK SUMMARY] District '{district_name}' ({satellite}): Available={len(all_aws_scenes)}, Held={len(held_scenes)}, Genuinely Missing={len(missing_scenes)}")
    return summary
