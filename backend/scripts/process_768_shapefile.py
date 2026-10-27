"""
=============================================================================
SDAP 768 Shapefile Extractor & Geocoder (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/process_768_shapefile.py
=============================================================================
"""

import runpy
from app.db.scripts.process_768_shapefile import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.process_768_shapefile", run_name="__main__")
