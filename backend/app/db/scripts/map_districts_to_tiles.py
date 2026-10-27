"""
=============================================================================
SDAP District to Sentinel-2 Tile Spatial Mapping & PostgreSQL Importer
=============================================================================
Location: backend/scripts/map_districts_to_tiles.py

Description:
    Performs spatial intersection (STRtree indexing) between all 768 district
    geometries in India and Sentinel-2 MGRS grid tiles.
    Generates and uploads the mapping to the 'district_tiles_mapping' table in PostgreSQL.

Table Schema:
    district_tiles_mapping (
        id SERIAL PRIMARY KEY,
        district_id INTEGER NOT NULL,
        district_uid VARCHAR(50),
        district_name VARCHAR(100),
        tile_id VARCHAR(50) NOT NULL,
        created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
        CONSTRAINT uq_district_tile UNIQUE (district_id, tile_id)
    )
=============================================================================
"""

import os
import sys
import json
import time
import logging
from typing import List, Dict, Any

# Ensure backend root is registered in Python path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shapely.geometry import shape
from shapely.strtree import STRtree
from sqlalchemy import create_engine, text
from app.core.config import settings

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.district_tile_mapper")

# Paths to input files
GRID_PATHS = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "sentinel-2_grids.geojson"),
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "sentinel-2_grids.geojson"),
    r"C:\Users\vasundharak\Downloads\sentinel-2_grids.geojson"
]
DISTRICT_GEOJSON_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "boundaries", "district_level.geojson")


def get_grid_file_path() -> str:
    """Finds available sentinel-2_grids.geojson location."""
    for path in GRID_PATHS:
        if os.path.exists(path):
            return path
    raise FileNotFoundError("Could not find 'sentinel-2_grids.geojson' in workspace or Downloads directory.")


def ensure_mapping_table_exists(engine):
    """Creates district_tiles_mapping table in PostgreSQL if not already present."""
    logger.info("Verifying 'district_tiles_mapping' table in PostgreSQL...")
    with engine.connect() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS district_tiles_mapping (
                id SERIAL PRIMARY KEY,
                district_id INTEGER NOT NULL,
                district_uid VARCHAR(50),
                district_name VARCHAR(100),
                tile_id VARCHAR(50) NOT NULL,
                created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
            );
            CREATE UNIQUE INDEX IF NOT EXISTS uq_district_tile ON district_tiles_mapping(district_id, tile_id);
            CREATE INDEX IF NOT EXISTS idx_dtm_district_id ON district_tiles_mapping(district_id);
            CREATE INDEX IF NOT EXISTS idx_dtm_tile_id ON district_tiles_mapping(tile_id);
            CREATE INDEX IF NOT EXISTS idx_dtm_district_uid ON district_tiles_mapping(district_uid);
        """))
        conn.commit()
    logger.info("[SUCCESS] Table 'district_tiles_mapping' ready.")


def load_districts(engine) -> List[Dict[str, Any]]:
    """Loads district geometries from PostgreSQL table 'district_boundaries' or fallback GeoJSON."""
    districts = []
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT id, district_uid, district_name, state_name, geometry FROM district_boundaries ORDER BY id;"))
            for row in result:
                geom_dict = row[4] if isinstance(row[4], dict) else json.loads(row[4])
                districts.append({
                    "id": row[0],
                    "district_uid": row[1],
                    "district_name": row[2],
                    "state_name": row[3],
                    "geometry": shape(geom_dict)
                })
        if districts:
            logger.info(f"Loaded {len(districts)} districts from PostgreSQL 'district_boundaries' table.")
            return districts
    except Exception as e:
        logger.warning(f"Could not load districts from DB ({e}). Falling back to GeoJSON.")

    # Fallback to GeoJSON
    if os.path.exists(DISTRICT_GEOJSON_PATH):
        with open(DISTRICT_GEOJSON_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        for idx, feat in enumerate(data.get("features", [])):
            props = feat.get("properties", {})
            districts.append({
                "id": idx + 1,
                "district_uid": props.get("uid", f"DIST_{idx+1:04d}"),
                "district_name": props.get("district_name", f"District_{idx+1}"),
                "state_name": props.get("state_name", "India Region"),
                "geometry": shape(feat["geometry"])
            })
        logger.info(f"Loaded {len(districts)} districts from GeoJSON file '{DISTRICT_GEOJSON_PATH}'.")
    return districts


def map_districts_to_tiles():
    """Main execution function to perform spatial mapping and DB upload."""
    engine = create_engine(settings.database_url)
    ensure_mapping_table_exists(engine)

    # 1. Load Districts
    districts = load_districts(engine)
    if not districts:
        logger.error("No district geometries found. Aborting.")
        return False

    # 2. Load Sentinel-2 Grid
    grid_path = get_grid_file_path()
    logger.info(f"Loading Sentinel-2 grid file: {grid_path}")
    t0 = time.time()
    with open(grid_path, "r", encoding="utf-8") as f:
        grid_data = json.load(f)

    logger.info(f"Read {len(grid_data.get('features', []))} raw tile features in {time.time()-t0:.2f}s.")

    # 3. Filter India Candidate Tiles & Build STRtree
    candidate_tiles = []
    candidate_tile_names = []
    for feat in grid_data.get("features", []):
        name = feat.get("properties", {}).get("Name") or feat.get("properties", {}).get("tile_id")
        if not name:
            continue
        geom = shape(feat["geometry"])
        minx, miny, maxx, maxy = geom.bounds
        # Bounding box filter around India geographic extent (Lon: 65E to 100E, Lat: 5N to 40N)
        if (minx <= 100 and maxx >= 65) and (miny <= 40 and maxy >= 5):
            candidate_tiles.append(geom)
            candidate_tile_names.append(str(name).strip())

    logger.info(f"Filtered {len(candidate_tiles)} candidate tiles overlapping India bounding box.")

    logger.info("Building Spatial R-Tree (STRtree) index...")
    t0 = time.time()
    tree = STRtree(candidate_tiles)
    logger.info(f"R-Tree built in {time.time()-t0:.2f}s.")

    # 4. Perform Spatial Intersection
    logger.info("Performing spatial intersection (Districts <-> Sentinel Tiles)...")
    mappings = []
    seen = set()

    for d in districts:
        d_id = d["id"]
        d_uid = d["district_uid"]
        d_name = d["district_name"]
        d_geom = d["geometry"]

        matching_indices = tree.query(d_geom)
        for m_idx in matching_indices:
            t_geom = candidate_tiles[m_idx]
            t_name = candidate_tile_names[m_idx]
            
            # Exact spatial intersection
            if d_geom.intersects(t_geom):
                key = (d_id, t_name)
                if key not in seen:
                    seen.add(key)
                    mappings.append({
                        "district_id": d_id,
                        "district_uid": d_uid,
                        "district_name": d_name,
                        "tile_id": t_name
                    })

    logger.info(f"[SUCCESS] Spatial Intersection Complete! Found {len(mappings)} district-tile mappings across {len(districts)} districts.")

    # 5. Upload to PostgreSQL
    logger.info("Uploading mappings to PostgreSQL table 'district_tiles_mapping'...")
    with engine.connect() as conn:
        conn.execute(text("TRUNCATE TABLE district_tiles_mapping RESTART IDENTITY;"))
        
        # Batch insert for maximum performance
        batch_size = 500
        for i in range(0, len(mappings), batch_size):
            batch = mappings[i:i+batch_size]
            conn.execute(
                text("""
                    INSERT INTO district_tiles_mapping (district_id, district_uid, district_name, tile_id)
                    VALUES (:district_id, :district_uid, :district_name, :tile_id)
                    ON CONFLICT (district_id, tile_id) DO NOTHING;
                """),
                batch
            )
        conn.commit()

    logger.info("=========================================================================")
    logger.info("[SUCCESS] District to Tile Mapping & Database Ingestion Complete!")
    logger.info(f"  - Total Districts Processed: {len(districts)}")
    logger.info(f"  - Total Tile Mappings Inserted: {len(mappings)}")
    logger.info("=========================================================================")
    return True


if __name__ == "__main__":
    map_districts_to_tiles()

