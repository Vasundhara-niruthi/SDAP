"""
=============================================================================
SDAP Optical Cloud Removal & Spectral Indices Processor (Proxy Shim)
=============================================================================
The canonical source of truth is located at:
    backend/app/db/scripts/cloud_removal_and_indices.py
=============================================================================
"""

import runpy
from app.db.scripts.cloud_removal_and_indices import *

if __name__ == "__main__":
    runpy.run_module("app.db.scripts.cloud_removal_and_indices", run_name="__main__")
