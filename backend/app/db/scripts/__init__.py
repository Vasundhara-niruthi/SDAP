"""
=============================================================================
SDAP Database Scripts Package
=============================================================================
Location: backend/app/db/scripts/__init__.py

Description:
    Operational and ETL scripts for:
    - Shapefile and boundary polygon ingestion (GADM / Survey of India)
    - Spatial intersections and District-to-Tile mapping
    - Boundary name normalization and enrichment
    - Satellite acquisition data downloading and verification
    - GeoTIFF raster retrieval and index processing
=============================================================================
"""

__all__ = [
    "cloud_removal_and_indices",
    "download_district_tiles",
    "enrich_district_names",
    "ingest_gadm_boundaries",
    "map_districts_to_tiles",
    "process_768_shapefile",
    "process_and_upload_shapefile",
    "retrieve_downloaded_data",
]

