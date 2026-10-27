"""
=============================================================================
SDAP Administrative Boundary Processor & Importer (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/process_and_upload_shapefile.py
=============================================================================
"""

import runpy
from app.db.scripts.process_and_upload_shapefile import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.process_and_upload_shapefile", run_name="__main__")
