"""
=============================================================================
SDAP GeoTIFF Data Retrieval Script (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/retrieve_downloaded_data.py
=============================================================================
"""

import runpy
from app.db.scripts.retrieve_downloaded_data import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.retrieve_downloaded_data", run_name="__main__")
