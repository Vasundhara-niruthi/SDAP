"""
=============================================================================
SDAP Administrative Boundary Name Synchronizer (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/enrich_district_names.py
=============================================================================
"""

import runpy
from app.db.scripts.enrich_district_names import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.enrich_district_names", run_name="__main__")
