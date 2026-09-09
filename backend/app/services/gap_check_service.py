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
from typing import List, Dict, Any, Optional

import boto3
from botocore import UNSIGNED
from botocore.config import Config
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings
from app.models.sdap_models import SceneModel, BandFileModel

logger = logging.getLogger("sdap.gap_check")

BUCKET = "sentinel-cogs"
REGION = "us-west-2"

s3_client = boto3.client(
    "s3",
    region_name=REGION,
    config=Config(signature_version=UNSIGNED, max_pool_connections=32)
)


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
    Searches AWS S3 sentinel-cogs bucket for available Sentinel-2 scenes for a given tile ID
    between start_date and end_date (YYYY-MM-DD format).
    """
    if len(tile_id) < 5:
        return []

    utm_zone = tile_id[0:2]
    latitude_band = tile_id[2]
    grid_square = tile_id[3:5]

    try:
        start_dt = datetime.strptime(start_date.split("T")[0], "%Y-%m-%d")
        end_dt = datetime.strptime(end_date.split("T")[0], "%Y-%m-%d")
    except ValueError as e:
        logger.error(f"Invalid date format: {e}")
        return []

    available_scenes = []

    # Iterate through years and months in range
    cur_year = start_dt.year
    while cur_year <= end_dt.year:
        s3_prefix = f"sentinel-s2-l2a-cogs/{utm_zone}/{latitude_band}/{grid_square}/{cur_year}/"
        try:
            resp = s3_client.list_objects_v2(Bucket=BUCKET, Prefix=s3_prefix, Delimiter="/")
            month_prefixes = [p.get("Prefix") for p in resp.get("CommonPrefixes", [])]

            for m_prefix in month_prefixes:
                try:
                    month_num = int(m_prefix.strip("/").split("/")[-1])
                except ValueError:
                    continue

                # Quick month range check
                if (cur_year == start_dt.year and month_num < start_dt.month) or \
                   (cur_year == end_dt.year and month_num > end_dt.month):
                    continue

                scene_resp = s3_client.list_objects_v2(Bucket=BUCKET, Prefix=m_prefix, Delimiter="/")
                scene_prefixes = [sp.get("Prefix") for sp in scene_resp.get("CommonPrefixes", [])]

                for sc_prefix in scene_prefixes:
                    folder = sc_prefix.strip("/").split("/")[-1]
                    # Sample folder: S2A_44QLD_20250102_0_L2A or S2B_44QLD_20250615_0_L2A
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

        cur_year += 1

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
    3. Cross-references PostgreSQL database for held/verified files.
    4. Returns summary and list of genuinely missing scenes.
    """
    if required_bands is None:
        required_bands = ["B03", "B04", "B08", "B08A", "B11", "SCL"]

    tiles = get_tiles_for_district(db, district_name)
    if not tiles:
        return {
            "district": district_name,
            "status": "ERROR",
            "message": f"No tile mapping found for district '{district_name}'.",
            "tiles": [],
            "scenes_available": 0,
            "scenes_held": 0,
            "scenes_missing": 0,
            "missing_scenes": []
        }

    all_aws_scenes = []
    for tile_id in tiles:
        scenes = search_aws_scenes_for_tile(tile_id, start_date, end_date)
        all_aws_scenes.extend(scenes)

    logger.info(f"AWS Gap Check found {len(all_aws_scenes)} total scenes available on S3 across tiles {tiles}.")

    held_scenes = []
    missing_scenes = []

    for sc in all_aws_scenes:
        s_id = sc["scene_id"]
        folder = sc["folder"]
        tile = sc["tile"]
        s_date = sc["sensing_date"]
        year = s_date[0:4]
        month = str(int(s_date[5:7]))
        scene_archive_dir = os.path.join(settings.RAW_ARCHIVE_DIR, tile, year, month, folder)

        # 1. Check if scene is marked 'HELD' in PostgreSQL with verified bands
        existing_scene = db.query(SceneModel).filter(SceneModel.scene_id == s_id).first()
        if existing_scene and existing_scene.status == "HELD":
            verified_count = db.query(BandFileModel).filter(
                BandFileModel.scene_id == s_id,
                BandFileModel.verified == 1
            ).count()
            if verified_count >= len(required_bands):
                held_scenes.append(sc)
                continue

        # 2. Check if scene files are already complete and valid on disk (from previous runs)
        if os.path.exists(scene_archive_dir):
            disk_bands_present = [
                b for b in required_bands
                if os.path.exists(os.path.join(scene_archive_dir, b)) and os.path.getsize(os.path.join(scene_archive_dir, b)) > 0
            ]
            if len(disk_bands_present) >= len(required_bands):
                # Auto-sync to database as HELD
                if not existing_scene:
                    existing_scene = SceneModel(
                        scene_id=s_id,
                        tile=tile,
                        sensing_date=s_date,
                        satellite=sc.get("satellite", "Sentinel-2"),
                        folder=folder,
                        prefix=sc.get("prefix", ""),
                        status="HELD",
                        archive_path=scene_archive_dir
                    )
                    db.add(existing_scene)
                else:
                    existing_scene.status = "HELD"
                    existing_scene.archive_path = scene_archive_dir
                db.commit()
                held_scenes.append(sc)
                continue

        missing_scenes.append(sc)

    summary = {
        "district": district_name,
        "date_range": f"{start_date} to {end_date}",
        "tiles": tiles,
        "total_available_scenes": len(all_aws_scenes),
        "held_scenes_count": len(held_scenes),
        "missing_scenes_count": len(missing_scenes),
        "missing_scenes": missing_scenes
    }

    logger.info(f"[GAP CHECK SUMMARY] District '{district_name}': Available={len(all_aws_scenes)}, Held={len(held_scenes)}, Genuinely Missing={len(missing_scenes)}")
    return summary

