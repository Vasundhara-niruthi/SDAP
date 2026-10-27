"""
=============================================================================
SDAP Modern Administrative Boundary Ingester (GADM 4.1 - 676 Districts, 36 States)
=============================================================================
Location: backend/scripts/ingest_gadm_boundaries.py

Description:
    Ingests all 676 modern districts across all 36 States/UTs of India from GADM 4.1
    (including all 33 modern Telangana districts, Ladakh, Odisha, Uttarakhand, etc.).
    Populates PostgreSQL tables (district_boundaries, state_boundaries, country_boundaries,
    district_tiles_mapping) and refreshes all 3 GeoJSON files in backend/data/boundaries/.
=============================================================================
"""

import os
import sys
import json
import re
import time
import logging
from typing import Dict, Any, List

# Ensure backend root is registered in Python path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from sqlalchemy import create_engine, text
from app.core.config import settings

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.gadm_ingester")

GADM_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "gadm_india_districts.geojson")
BOUNDARIES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "boundaries")


def clean_state_name(raw_name: str) -> str:
    """Format state names into clean, standard English titles."""
    if not raw_name:
        return "India Region"
    # Convert CamelCase like AndhraPradesh -> Andhra Pradesh
    name = re.sub(r'([a-z])([A-Z])', r'\1 \2', raw_name)
    name = re.sub(r'\s+', ' ', name).strip()
    
    mapping = {
        "Andamanand Nicobar": "Andaman and Nicobar Islands",
        "Andaman and Nicobar": "Andaman and Nicobar Islands",
        "NCTof Delhi": "Delhi",
        "NCT of Delhi": "Delhi",
        "Dadraand Nagar Haveli": "Dadra and Nagar Haveli and Daman and Diu",
        "Damanand Diu": "Dadra and Nagar Haveli and Daman and Diu",
        "Dadra and Nagar Haveli": "Dadra and Nagar Haveli and Daman and Diu",
        "Jammuand Kashmir": "Jammu and Kashmir"
    }
    return mapping.get(name, name)


def clean_district_name(raw_name: str) -> str:
    """Format district names into clean English titles."""
    if not raw_name:
        return "District"
    name = re.sub(r'([a-z])([A-Z])', r'\1 \2', raw_name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name


def ingest_gadm_boundaries():
    """Main execution function to ingest GADM 4.1 boundaries into PostgreSQL & GeoJSON."""
    if not os.path.exists(GADM_PATH):
        logger.error(f"GADM file not found at '{GADM_PATH}'. Aborting.")
        return False

    logger.info(f"Loading GADM 4.1 dataset: {GADM_PATH}")
    with open(GADM_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    features = data.get("features", [])
    logger.info(f"Read {len(features)} modern district features from GADM 4.1 dataset.")

    districts = []
    state_groups = {}
    all_geoms = []

    for idx, feat in enumerate(features):
        props = feat.get("properties", {})
        g = shape(feat["geometry"])
        all_geoms.append(g)

        st_raw = props.get("NAME_1", "India Region")
        dt_raw = props.get("NAME_2", f"District_{idx+1}")

        st_name = clean_state_name(st_raw)
        dt_name = clean_district_name(dt_raw)
        d_id = idx + 1
        d_uid = str(10000 + d_id)

        districts.append({
            "id": d_id,
            "district_uid": d_uid,
            "district_name": dt_name,
            "state_name": st_name,
            "geometry": g
        })

        if st_name not in state_groups:
            state_groups[st_name] = []
        state_groups[st_name].append(g.simplify(0.01, preserve_topology=False))

    logger.info(f"[SUCCESS] Prepared {len(districts)} modern districts across {len(state_groups)} States/UTs!")
    logger.info(f"States count: {len(state_groups)}")
    if "Telangana" in state_groups:
        tel_dists = [d["district_name"] for d in districts if d["state_name"] == "Telangana"]
        logger.info(f"Telangana districts ({len(tel_dists)}): {sorted(tel_dists)}")

    # Update PostgreSQL Database
    engine = create_engine(settings.database_url)
    logger.info("Ingesting modern boundaries into PostgreSQL 'sdap_db'...")

    with engine.connect() as conn:
        # 1. Truncate existing boundary tables
        conn.execute(text("TRUNCATE TABLE district_boundaries, state_boundaries, country_boundaries RESTART IDENTITY;"))

        # 2. Insert District Boundaries
        for d in districts:
            conn.execute(
                text("""
                    INSERT INTO district_boundaries (district_uid, district_name, state_name, geometry)
                    VALUES (:uid, :d_name, :s_name, :geometry);
                """),
                {
                    "uid": d["district_uid"],
                    "d_name": d["district_name"],
                    "s_name": d["state_name"],
                    "geometry": json.dumps(mapping(d["geometry"]))
                }
            )

        # 3. Insert State Boundaries
        state_records = []
        for st_name, geoms in state_groups.items():
            st_union = unary_union(geoms)
            state_records.append({
                "state_name": st_name,
                "district_count": len(geoms),
                "geometry": mapping(st_union)
            })
            conn.execute(
                text("""
                    INSERT INTO state_boundaries (state_name, district_count, geometry)
                    VALUES (:state_name, :district_count, :geometry);
                """),
                {
                    "state_name": st_name,
                    "district_count": len(geoms),
                    "geometry": json.dumps(mapping(st_union))
                }
            )

        # 4. Insert Country Boundary
        simplified_national = [g.simplify(0.02, preserve_topology=False) for g in all_geoms]
        country_union = unary_union(simplified_national)
        conn.execute(
            text("""
                INSERT INTO country_boundaries (country_name, total_districts, geometry)
                VALUES (:country_name, :total_districts, :geometry);
            """),
            {
                "country_name": "India",
                "total_districts": len(districts),
                "geometry": json.dumps(mapping(country_union))
            }
        )

        conn.commit()

    logger.info("[SUCCESS] Database ingestion complete for country_boundaries, state_boundaries, district_boundaries.")

    # Export GeoJSON Files
    os.makedirs(BOUNDARIES_DIR, exist_ok=True)

    district_geojson_path = os.path.join(BOUNDARIES_DIR, "district_level.geojson")
    with open(district_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "id": d["id"],
                        "uid": d["district_uid"],
                        "district_name": d["district_name"],
                        "state_name": d["state_name"]
                    },
                    "geometry": mapping(d["geometry"])
                }
                for d in districts
            ]
        }, f)

    state_geojson_path = os.path.join(BOUNDARIES_DIR, "state_level.geojson")
    with open(state_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "state_name": s["state_name"],
                        "district_count": s["district_count"]
                    },
                    "geometry": s["geometry"]
                }
                for s in state_records
            ]
        }, f)

    country_geojson_path = os.path.join(BOUNDARIES_DIR, "country_level.geojson")
    with open(country_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "country_name": "India",
                        "total_districts": len(districts)
                    },
                    "geometry": mapping(country_union)
                }
            ]
        }, f)

    logger.info("[SUCCESS] Exported all 3 GeoJSON files to backend/data/boundaries/.")

    # Refresh District to Tile Mappings in PostgreSQL
    logger.info("Refreshing district to tile mappings in PostgreSQL table 'district_tiles_mapping'...")
    from app.db.scripts.map_districts_to_tiles import map_districts_to_tiles
    map_districts_to_tiles()

    logger.info("=========================================================================")
    logger.info("[SUCCESS] Modern Administrative Boundary Ingestion Complete!")
    logger.info(f"  - Total Districts: {len(districts)}")
    logger.info(f"  - Total States/UTs: {len(state_groups)}")
    logger.info("=========================================================================")
    return True


if __name__ == "__main__":
    ingest_gadm_boundaries()

