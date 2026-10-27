# 🛰️ SDAP Database Operational Scripts (`app/db/scripts/`)

This directory houses operational jobs and ETL pipelines for spatial data ingestion, boundary synchronization, Sentinel tile mapping, and raster acquisition.

---

## 📋 Script Catalog & Responsibilities

| Script Name | Purpose | Target Tables | Primary Command |
|---|---|---|---|
| **`ingest_gadm_boundaries.py`** | Ingests GADM 4.1 administrative boundaries (676 Districts, 36 States/UTs) into PostgreSQL/PostGIS. | `state_boundaries`, `district_boundaries` | `python -m app.db.scripts.ingest_gadm_boundaries` |
| **`process_768_shapefile.py`** | Direct extractor for Survey of India 768 district shapefiles and reverse geocoding. | `district_boundaries` | `python -m app.db.scripts.process_768_shapefile` |
| **`process_and_upload_shapefile.py`** | Reprojects custom shapefile boundaries to EPSG:4326 and uploads geometries to PostGIS. | `district_boundaries` | `python -m app.db.scripts.process_and_upload_shapefile` |
| **`map_districts_to_tiles.py`** | Calculates spatial intersection (`ST_Intersects`) between districts and Sentinel-2 MGRS 100km grid tiles. | `district_tiles_mapping` | `python -m app.db.scripts.map_districts_to_tiles` |
| **`enrich_district_names.py`** | Normalizes district names, synchronizes state assignments, and fixes discrepancies between boundary & mapping tables. | `district_tiles_mapping`, `district_boundaries` | `python -m app.db.scripts.enrich_district_names` |
| **`download_district_tiles.py`** | End-to-end satellite acquisition pipeline: runs gap checks, downloads tiles, generates indices, and updates jobs. | `requests`, `scene`, `band_file`, `process_jobs` | `python -m app.db.scripts.download_district_tiles` |
| **`retrieve_downloaded_data.py`** | Queries and validates held GeoTIFF raster paths for requests from PostgreSQL. | `scene`, `band_file` | `python -m app.db.scripts.retrieve_downloaded_data` |
| **`cloud_removal_and_indices.py`** | Performs cloud masking using SCL / QA60 and calculates NDVI, LSWI, and VV/VH indices. | `band_file`, `process_jobs` | `python -m app.db.scripts.cloud_removal_and_indices` |

---

## 🔄 Recommended Execution Pipeline Order

When bootstrapping a new environment or re-populating spatial datasets:

1. **Initialize Database & Seed Users:**
   ```bash
   python init_db.py
   ```
2. **Ingest Administrative Boundaries:**
   ```bash
   python -m app.db.scripts.ingest_gadm_boundaries
   ```
3. **Map Districts to Sentinel Tiles:**
   ```bash
   python -m app.db.scripts.map_districts_to_tiles
   ```
4. **Synchronize & Enrich District Names:**
   ```bash
   python -m app.db.scripts.enrich_district_names
   ```

