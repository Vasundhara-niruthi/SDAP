"""
=============================================================================
SDAP Administrative Boundary Processor & PostgreSQL Importer
=============================================================================
Location: backend/scripts/process_and_upload_shapefile.py

Description:
    Interacts with 'All_India_Distwise_UID.shp', extracts 768 district geometries,
    performs spatial aggregation (unary_union) to generate Country, State, and
    District level boundaries, and uploads all 3 administrative tiers to PostgreSQL.

Output:
    1. PostgreSQL Database Tables:
       - country_boundaries
       - state_boundaries
       - district_boundaries
    2. Exported GeoJSON Files:
       - backend/data/boundaries/country_level.geojson
       - backend/data/boundaries/state_level.geojson
       - backend/data/boundaries/district_level.geojson
=============================================================================
"""

import os
import sys
import json
import logging
from datetime import datetime
from typing import List, Dict, Any

# Ensure backend path is registered
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shapefile
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from sqlalchemy import create_engine, text
from app.core.config import settings

# Configure Logger
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.shapefile_processor")


SHP_PATH = os.getenv("SHP_PATH", os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "All_India_Distwise_UID.shp"))
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "boundaries")


def ensure_boundary_tables_exist(engine):
    """Create country_boundaries, state_boundaries, and district_boundaries tables in PostgreSQL."""
    logger.info("Verifying PostgreSQL boundary tables in 'sdap_db'...")
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS country_boundaries (
                id SERIAL PRIMARY KEY,
                country_name VARCHAR(100) NOT NULL DEFAULT 'India',
                total_districts INTEGER NOT NULL,
                geometry JSONB NOT NULL,
                created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS state_boundaries (
                id SERIAL PRIMARY KEY,
                state_name VARCHAR(100) NOT NULL,
                district_count INTEGER NOT NULL,
                geometry JSONB NOT NULL,
                created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS district_boundaries (
                id SERIAL PRIMARY KEY,
                district_uid VARCHAR(50) NOT NULL,
                district_name VARCHAR(100) NOT NULL,
                state_name VARCHAR(100),
                geometry JSONB NOT NULL,
                created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
            );
        """))
        conn.commit()
    logger.info("[SUCCESS] Database tables 'country_boundaries', 'state_boundaries', and 'district_boundaries' ready.")


def process_shapefile_and_upload():
    """Reads shapefile, aggregates 3 administrative levels, and uploads to PostgreSQL & GeoJSON."""
    if not os.path.exists(SHP_PATH):
        logger.error(f"Shapefile not found at '{SHP_PATH}'. Aborting.")
        return False

    logger.info(f"Loading shapefile: {SHP_PATH}")
    sf = shapefile.Reader(SHP_PATH)
    shapes = sf.shapes()
    try:
        records = sf.records()
    except Exception as e:
        logger.warning(f"Note: .dbf attribute file not present ({e}). Proceeding with geometry extraction for all 768 shapes.")
        records = []


    logger.info(f"Loaded {len(shapes)} geometry features from shapefile.")

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # 1. Process District Level Geometries
    logger.info("Processing Tier 3: District Level Geometries...")
    district_geoms = []
    district_records = []

    for i, s in enumerate(shapes):
        geom = shape(s.__geo_interface__)
        district_geoms.append(geom)


        # Extract attributes if dbf present, or assign formatted UID
        uid = f"DIST_{i+1:04d}"
        dist_name = f"District_{i+1}"
        st_name = "India Region"

        if i < len(records):
            rec = records[i]
            if len(rec) >= 1:
                dist_name = str(rec[0])
            if len(rec) >= 2:
                st_name = str(rec[1])

        district_records.append({
            "uid": uid,
            "district_name": dist_name,
            "state_name": st_name,
            "geometry": mapping(geom)
        })


    # Save District Level GeoJSON
    district_geojson_path = os.path.join(OUTPUT_DIR, "district_level.geojson")
    with open(district_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"uid": d["uid"], "district_name": d["district_name"], "state_name": d["state_name"]},
                    "geometry": d["geometry"]
                }
                for d in district_records
            ]
        }, f)
    logger.info(f"[SAVED] District Level GeoJSON ({len(district_records)} features) -> {district_geojson_path}")

    # 2. Process State Level Geometries (Spatial Union Grouped by State or Regions)
    logger.info("Processing Tier 2: State Level Aggregation (Spatial Union)...")
    state_groups = {}
    for d in district_records:
        st = d["state_name"]
        if st not in state_groups:
            state_groups[st] = []
        state_groups[st].append(shape(d["geometry"]).simplify(0.02, preserve_topology=False))

    state_records = []
    for state_name, geoms in state_groups.items():
        state_union = unary_union(geoms)
        state_records.append({
            "state_name": state_name,
            "district_count": len(geoms),
            "geometry": mapping(state_union)
        })

    # Save State Level GeoJSON
    state_geojson_path = os.path.join(OUTPUT_DIR, "state_level.geojson")
    with open(state_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"state_name": s["state_name"], "district_count": s["district_count"]},
                    "geometry": s["geometry"]
                }
                for s in state_records
            ]
        }, f)
    logger.info(f"[SAVED] State Level GeoJSON ({len(state_records)} states) -> {state_geojson_path}")

    # 3. Process Country Level Geometry (Unified National Boundary via unary_union)
    logger.info("Processing Tier 1: Country Level Boundary (National Spatial Union)...")
    simplified_geoms = [g.simplify(0.02, preserve_topology=False) for g in district_geoms]
    country_union = unary_union(simplified_geoms)
    country_record = {
        "country_name": "India",
        "total_districts": len(district_geoms),
        "geometry": mapping(country_union)
    }





    # Save Country Level GeoJSON
    country_geojson_path = os.path.join(OUTPUT_DIR, "country_level.geojson")
    with open(country_geojson_path, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {"country_name": "India", "total_districts": country_record["total_districts"]},
                    "geometry": country_record["geometry"]
                }
            ]
        }, f)
    logger.info(f"[SAVED] Country Level GeoJSON -> {country_geojson_path}")

    # 4. Upload to PostgreSQL Database (sdap_db)
    logger.info("Uploading Country, State, and District Level Boundaries to PostgreSQL...")
    engine = create_engine(settings.database_url)
    ensure_boundary_tables_exist(engine)

    with engine.connect() as conn:
        # Clear existing table data prior to refresh
        conn.execute(text("TRUNCATE TABLE district_boundaries, state_boundaries, country_boundaries RESTART IDENTITY;"))
        
        # Insert Country Level
        conn.execute(
            text("INSERT INTO country_boundaries (country_name, total_districts, geometry) VALUES (:country_name, :total_districts, :geometry);"),
            {"country_name": "India", "total_districts": country_record["total_districts"], "geometry": json.dumps(country_record["geometry"])}
        )

        # Insert State Level
        for s in state_records:
            conn.execute(
                text("INSERT INTO state_boundaries (state_name, district_count, geometry) VALUES (:state_name, :district_count, :geometry);"),
                {"state_name": s["state_name"], "district_count": s["district_count"], "geometry": json.dumps(s["geometry"])}
            )

        # Insert District Level
        for d in district_records:
            conn.execute(
                text("INSERT INTO district_boundaries (district_uid, district_name, state_name, geometry) VALUES (:uid, :dist_name, :st_name, :geometry);"),
                {"uid": d["uid"], "dist_name": d["district_name"], "st_name": d["state_name"], "geometry": json.dumps(d["geometry"])}
            )

        conn.commit()

    logger.info("=========================================================================")
    logger.info("[SUCCESS] Shapefile Processing & Database Upload Complete!")
    logger.info(f"  - Country Level Boundary: 1 National Polygon ({len(district_geoms)} districts merged)")
    logger.info(f"  - State Level Boundaries: {len(state_records)} State Regions")
    logger.info(f"  - District Level Boundaries: {len(district_records)} District Polygons")
    logger.info("=========================================================================")
    return True


if __name__ == "__main__":
    process_shapefile_and_upload()
