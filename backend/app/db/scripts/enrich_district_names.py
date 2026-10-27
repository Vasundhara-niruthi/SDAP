"""
=============================================================================
SDAP Full Administrative Boundary Processor & Real Name Synchronizer
=============================================================================
Location: backend/scripts/enrich_district_names.py

Description:
    Processes all 768 district geometries from 'All_India_Distwise_UID.shp',
    assigns official, real State and District names (including Telangana, Ladakh,
    Odisha, Uttarakhand, etc.), updates PostgreSQL tables (district_boundaries,
    state_boundaries, country_boundaries, district_tiles_mapping), and refreshes
    all GeoJSON files in backend/data/boundaries/.
=============================================================================
"""

import os
import sys
import json
import time
import logging
from typing import Dict, Any, List

# Ensure backend root is registered in Python path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.strtree import STRtree
from sqlalchemy import create_engine, text
from app.core.config import settings

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.full_boundary_processor")

REF_GEOJSON_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "reference_india_districts.geojson")
BOUNDARIES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "boundaries")
DISTRICT_GEOJSON_PATH = os.path.join(BOUNDARIES_DIR, "district_level.geojson")
STATE_GEOJSON_PATH = os.path.join(BOUNDARIES_DIR, "state_level.geojson")
COUNTRY_GEOJSON_PATH = os.path.join(BOUNDARIES_DIR, "country_level.geojson")

TELANGANA_DISTRICTS = {
    'Adilabad', 'Karimnagar', 'Khammam', 'Mahbubnagar', 'Medak', 
    'Nalgonda', 'Nizamabad', 'Rangareddi', 'Rangareddy', 'Warangal', 'Hyderabad'
}
LADAKH_DISTRICTS = {'Ladakh (Leh)', 'Leh', 'Kargil'}

STATE_NAME_MAPPINGS = {
    'Orissa': 'Odisha',
    'Uttaranchal': 'Uttarakhand',
    'Andaman and Nicobar': 'Andaman and Nicobar Islands',
    'Pondicherry': 'Puducherry'
}


def process_and_synchronize_all():
    """Main execution function to process administrative boundaries and update DB & GeoJSON."""
    engine = create_engine(settings.database_url)
    os.makedirs(BOUNDARIES_DIR, exist_ok=True)

    if not os.path.exists(REF_GEOJSON_PATH):
        logger.error(f"Reference file not found at '{REF_GEOJSON_PATH}'. Aborting.")
        return False

    # 1. Load Reference GeoJSON
    logger.info(f"Loading reference district dataset: {REF_GEOJSON_PATH}")
    with open(REF_GEOJSON_PATH, "r", encoding="utf-8") as f:
        ref_data = json.load(f)

    ref_geoms = [shape(feat["geometry"]) for feat in ref_data["features"]]
    ref_props = [feat["properties"] for feat in ref_data["features"]]

    logger.info("Building Spatial R-Tree over reference district boundaries...")
    tree = STRtree(ref_geoms)

    # 2. Load Target Districts from PostgreSQL or district_level.geojson
    logger.info("Fetching 768 target district geometries from PostgreSQL 'district_boundaries'...")
    districts = []
    with engine.connect() as conn:
        rows = conn.execute(text("SELECT id, geometry FROM district_boundaries ORDER BY id;")).fetchall()
        for row in rows:
            geom_dict = row[1] if isinstance(row[1], dict) else json.loads(row[1])
            districts.append({
                "id": row[0],
                "geometry": shape(geom_dict)
            })

    if not districts and os.path.exists(DISTRICT_GEOJSON_PATH):
        logger.info("DB empty, reading from district_level.geojson...")
        with open(DISTRICT_GEOJSON_PATH, "r", encoding="utf-8") as f:
            d_data = json.load(f)
        for idx, feat in enumerate(d_data.get("features", [])):
            districts.append({
                "id": idx + 1,
                "geometry": shape(feat["geometry"])
            })

    logger.info(f"Loaded {len(districts)} district shapes to enrich.")

    # 3. Perform Spatial Matching (Point-in-Polygon & Max Overlap Fallback)
    logger.info("Matching each district shape to official State and District names...")
    enriched_records = []
    state_groups = {}
    all_district_geoms = []

    for d in districts:
        d_id = d["id"]
        d_geom = d["geometry"]
        all_district_geoms.append(d_geom)
        pt = d_geom.representative_point()

        matches = tree.query(pt)
        matched_prop = None

        for m_idx in matches:
            if ref_geoms[m_idx].contains(pt) or ref_geoms[m_idx].intersects(d_geom):
                matched_prop = ref_props[m_idx]
                break

        # Fallback: Max area intersection overlap
        if not matched_prop:
            max_area = 0.0
            candidates = tree.query(d_geom)
            for m_idx in candidates:
                inter_area = d_geom.intersection(ref_geoms[m_idx]).area
                if inter_area > max_area:
                    max_area = inter_area
                    matched_prop = ref_props[m_idx]

        st_name = matched_prop.get("NAME_1", "India Region") if matched_prop else "India Region"
        dist_name = matched_prop.get("NAME_2", f"District_{d_id}") if matched_prop else f"District_{d_id}"

        # Reclassify Telangana and Ladakh
        if st_name == "Andhra Pradesh" and dist_name in TELANGANA_DISTRICTS:
            st_name = "Telangana"
        elif st_name == "Jammu and Kashmir" and dist_name in LADAKH_DISTRICTS:
            st_name = "Ladakh"
        elif st_name in STATE_NAME_MAPPINGS:
            st_name = STATE_NAME_MAPPINGS[st_name]

        # Clean numeric district UID (e.g. 10001, 10002...)
        clean_dist_uid = str(10000 + d_id)

        record = {
            "id": d_id,
            "district_uid": clean_dist_uid,
            "district_name": dist_name,
            "state_name": st_name,
            "geometry": d_geom
        }
        enriched_records.append(record)

        if st_name not in state_groups:
            state_groups[st_name] = []
        state_groups[st_name].append(d_geom.simplify(0.02, preserve_topology=False))

    logger.info(f"[SUCCESS] Enriched {len(enriched_records)} districts across {len(state_groups)} official States/UTs!")
    logger.info(f"States list ({len(state_groups)}): {sorted(list(state_groups.keys()))}")

    # 4. Update district_boundaries in PostgreSQL
    logger.info("Updating PostgreSQL table 'district_boundaries' with real state and district names...")
    with engine.connect() as conn:
        for r in enriched_records:
            conn.execute(
                text("""
                    UPDATE district_boundaries
                    SET district_uid = :uid,
                        district_name = :d_name,
                        state_name = :s_name
                    WHERE id = :id;
                """),
                {
                    "uid": r["district_uid"],
                    "d_name": r["district_name"],
                    "s_name": r["state_name"],
                    "id": r["id"]
                }
            )
        conn.commit()

    # 5. Build and Update state_boundaries in PostgreSQL
    logger.info("Building state boundary polygons and updating 'state_boundaries' table...")
    state_records = []
    for st_name, geoms in state_groups.items():
        st_union = unary_union(geoms)
        state_records.append({
            "state_name": st_name,
            "district_count": len(geoms),
            "geometry": mapping(st_union)
        })

    with engine.connect() as conn:
        conn.execute(text("TRUNCATE TABLE state_boundaries RESTART IDENTITY;"))
        for s in state_records:
            conn.execute(
                text("""
                    INSERT INTO state_boundaries (state_name, district_count, geometry)
                    VALUES (:state_name, :district_count, :geometry);
                """),
                {
                    "state_name": s["state_name"],
                    "district_count": s["district_count"],
                    "geometry": json.dumps(s["geometry"])
                }
            )
        conn.commit()

    # 6. Build and Update country_boundaries in PostgreSQL
    logger.info("Building national boundary polygon and updating 'country_boundaries' table...")
    simplified_national_geoms = [g.simplify(0.02, preserve_topology=False) for g in all_district_geoms]
    country_union = unary_union(simplified_national_geoms)
    country_record = {
        "country_name": "India",
        "total_districts": len(all_district_geoms),
        "geometry": mapping(country_union)
    }

    with engine.connect() as conn:
        conn.execute(text("TRUNCATE TABLE country_boundaries RESTART IDENTITY;"))
        conn.execute(
            text("""
                INSERT INTO country_boundaries (country_name, total_districts, geometry)
                VALUES (:country_name, :total_districts, :geometry);
            """),
            {
                "country_name": "India",
                "total_districts": country_record["total_districts"],
                "geometry": json.dumps(country_record["geometry"])
            }
        )
        conn.commit()

    # 7. Save updated GeoJSON files
    logger.info("Exporting District, State, and Country GeoJSON files...")

    # District Level GeoJSON
    with open(DISTRICT_GEOJSON_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "id": r["id"],
                        "uid": r["district_uid"],
                        "district_name": r["district_name"],
                        "state_name": r["state_name"]
                    },
                    "geometry": mapping(r["geometry"])
                }
                for r in enriched_records
            ]
        }, f)

    # State Level GeoJSON
    with open(STATE_GEOJSON_PATH, "w", encoding="utf-8") as f:
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

    # Country Level GeoJSON
    with open(COUNTRY_GEOJSON_PATH, "w", encoding="utf-8") as f:
        json.dump({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "properties": {
                        "country_name": "India",
                        "total_districts": country_record["total_districts"]
                    },
                    "geometry": country_record["geometry"]
                }
            ]
        }, f)

    logger.info("[SUCCESS] All 3 Administrative Level GeoJSON files exported successfully.")

    # 8. Re-run map_districts_to_tiles.py to refresh district_tiles_mapping table
    logger.info("Re-running district to tile mapper to refresh 'district_tiles_mapping' table...")
    from app.db.scripts.map_districts_to_tiles import map_districts_to_tiles
    map_districts_to_tiles()

    logger.info("=========================================================================")
    logger.info("[SUCCESS] Full Administrative Boundary Synchronization & Mapping Complete!")
    logger.info(f"  - Districts Processed & Updated: {len(enriched_records)}")
    logger.info(f"  - Official States/UTs Formed: {len(state_records)}")
    logger.info("=========================================================================")
    return True


if __name__ == "__main__":
    process_and_synchronize_all()
