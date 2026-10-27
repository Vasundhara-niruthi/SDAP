"""
=============================================================================
SDAP District to Sentinel-2 Tile Spatial Mapping (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/map_districts_to_tiles.py
=============================================================================
"""

import runpy
from app.db.scripts.map_districts_to_tiles import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.map_districts_to_tiles", run_name="__main__")
