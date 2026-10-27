"""
=============================================================================
SDAP Universal Satellite Acquisition Pipeline (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/download_district_tiles.py
=============================================================================
"""

import runpy
from app.db.scripts.download_district_tiles import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.download_district_tiles", run_name="__main__")
