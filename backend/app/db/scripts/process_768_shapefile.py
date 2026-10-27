"""
=============================================================================
SDAP 768 Shapefile Direct Extractor & Reverse Geocoder
=============================================================================
Location: backend/scripts/process_768_shapefile.py

Description:
    Reads 'All_India_Distwise_UID.shp' directly (768 shapes), reverse-geocodes
    each representative point to fetch the exact real State & District name,
    updates PostgreSQL tables (district_boundaries, state_boundaries, country_boundaries,
    district_tiles_mapping), and exports all 3 administrative level GeoJSON files.
=============================================================================
"""

import os
import sys
import json
import time
import urllib.request
import logging
from typing import Dict, Any, List

# Ensure backend root is registered in Python path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import shapefile
from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from sqlalchemy import create_engine, text
from app.core.config import settings

# Configure Logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sdap.shp_768_processor")

SHP_PATH = os.getenv("SHP_PATH", os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "All_India_Distwise_UID.shp"))
BOUNDARIES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "boundaries")
CACHE_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "shp_768_geocode_cache.json")


def clean_state_name(state: str) -> str:
    """Standardize state names for official Indian administrative standards."""
    if not state:
        return "India Region"
    state = state.strip()
    mapping = {
        "Orissa": "Odisha",
        "Uttaranchal": "Uttarakhand",
        "Andaman and Nicobar": "Andaman and Nicobar Islands",
        "Andaman and Nicobar Islands": "Andaman and Nicobar Islands",
        "Pondicherry": "Puducherry",
        "The Government of Puducherry": "Puducherry",
        "National Capital Territory of Delhi": "Delhi",
        "NCT of Delhi": "Delhi",
        "Dadra and Nagar Haveli and Daman and Diu": "Dadra and Nagar Haveli and Daman and Diu",
        "Daman and Diu": "Dadra and Nagar Haveli and Daman and Diu",
        "Dadra and Nagar Haveli": "Dadra and Nagar Haveli and Daman and Diu"
    }
    return mapping.get(state, state)


def clean_district_name(district: str, fallback_id: int) -> str:
    """Clean district names."""
    if not district:
        return f"District_{fallback_id}"
    district = district.strip()
    # Strip unwanted suffixes if present
    for suffix in [" District", " district", " Mandal", " mandal", " Taluk", " taluk", " Tehsil", " tehsil", " Sub-Division"]:
        if district.endswith(suffix):
            district = district[:-len(suffix)].strip()
    return district


def geocode_point(lat: float, lon: float) -> tuple[str, str]:
    """Reverse geocodes lat/lon using OpenStreetMap Nominatim with retry."""
    url = f"https://nominatim.openstreetmap.org/reverse?lat={lat}&lon={lon}&format=json&accept-language=en"
    req = urllib.request.Request(url, headers={"User-Agent": "SDAP_GIS_Processor/1.0 (contact@sdap.in)"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            addr = data.get("address", {})
            state = addr.get("state") or addr.get("state_district") or "India Region"
            district = addr.get("county") or addr.get("state_district") or addr.get("district") or addr.get("city") or addr.get("town") or addr.get("suburb")
            return state, district
    except Exception as e:
        logger.warning(f"Geocode error for ({lat}, {lon}): {e}")
        return "India Region", None


def process_768_shapefile():
    """Main processing script for 768 shapes in All_India_Distwise_UID.shp."""
    if not os.path.exists(SHP_PATH):
        logger.error(f"Shapefile not found at '{SHP_PATH}'. Aborting.")
        return False

    logger.info(f"Reading shapefile: {SHP_PATH}")
    sf = shapefile.Reader(SHP_PATH)
    shapes = sf.shapes()
    logger.info(f"Loaded {len(shapes)} geometry shapes from shapefile.")

    # Load cache if available
    geocode_cache = {}
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, "r", encoding="utf-8") as f:
                geocode_cache = json.load(f)
            logger.info(f"Loaded {len(geocode_cache)} cached geocode entries.")
        except Exception as e:
            logger.warning(f"Could not load geocode cache: {e}")

    # Process all 768 shapes
    districts = []
    updated_cache = False

    for idx, s in enumerate(shapes):
        d_id = idx + 1
        g = shape(s.__geo_interface__)
        pt = g.representative_point()
        cache_key = f"{d_id}"

        if cache_key in geocode_cache:
            st_raw = geocode_cache[cache_key]["state"]
            dt_raw = geocode_cache[cache_key]["district"]
        else:
            st_raw, dt_raw = geocode_point(pt.y, pt.x)
            geocode_cache[cache_key] = {"state": st_raw, "district": dt_raw, "lat": pt.y, "lon": pt.x}
            updated_cache = True
            time.sleep(1.05) # Respect Nominatim rate limit (1 req/sec)

        st_name = clean_state_name(st_raw)
        dt_name = clean_district_name(dt_raw, d_id)
        dist_uid = str(10000 + d_id)

        districts.append({
            "id": d_id,
            "district_uid": dist_uid,
            "district_name": dt_name,
            "state_name": st_name,
            "geometry": g
        })

        if d_id % 50 == 0 or d_id == len(shapes):
            logger.info(f"Processed {d_id}/{len(shapes)} shapes...")
            if updated_cache:
                with open(CACHE_FILE, "w", encoding="utf-8") as f:
                    json.dump(geocode_cache, f, indent=2)

    logger.info(f"[SUCCESS] Processed and enriched all {len(districts)} shapes from {SHP_PATH}.")

    # Grouping by State
    state_groups = {}
    for d in districts:
        st = d["state_name"]
        if st not in state_groups:
            state_groups[st] = []
        state_groups[st].append(d["geometry"].simplify(0.02, preserve_topology=False))

    logger.info(f"Grouped shapes into {len(state_groups)} States/UTs.")

    # Save to PostgreSQL
    engine = create_engine(settings.database_url)

    logger.info("Updating PostgreSQL database tables...")
    with engine.connect() as conn:
        # 1. Clear existing boundary tables
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
        national_geoms = [d["geometry"].simplify(0.02, preserve_topology=False) for d in districts]
        country_union = unary_union(national_geoms)
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

    # 5. Export GeoJSON Files
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

    logger.info("[SUCCESS] Exported all 3 GeoJSON files.")

    # 6. Re-run map_districts_to_tiles.py to refresh district_tiles_mapping table
    logger.info("Refreshing district to tile mappings in PostgreSQL...")
    from app.db.scripts.map_districts_to_tiles import map_districts_to_tiles
    map_districts_to_tiles()

    logger.info("=========================================================================")
    logger.info("[SUCCESS] 768 Shapefile Direct Extraction & DB Upload Complete!")
    logger.info("=========================================================================")
    return True


if __name__ == "__main__":
    process_768_shapefile()

