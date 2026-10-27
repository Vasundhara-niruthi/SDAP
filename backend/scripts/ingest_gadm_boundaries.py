"""
=============================================================================
SDAP Administrative Boundary Ingester (GADM 4.1) (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/ingest_gadm_boundaries.py
=============================================================================
"""

import runpy
from app.db.scripts.ingest_gadm_boundaries import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.ingest_gadm_boundaries", run_name="__main__")
