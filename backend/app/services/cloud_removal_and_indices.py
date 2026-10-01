"""
=============================================================================
SDAP Optical Cloud Removal & Spectral Indices Processor (SRS 8.4.1 & 8.4.3)
=============================================================================
Location: backend/app/services/cloud_removal_and_indices.py

Description:
    Pass-through wrapper module that re-exports `process_and_save_indices`
    from `scripts.cloud_removal_and_indices` to maintain a single source
    of truth and prevent duplicate code drift across the codebase.
=============================================================================
"""

from scripts.cloud_removal_and_indices import (
    process_and_save_indices,
    SCL_DROP_CLASSES,
    BASELINE_04_CUTOFF,
    BASELINE_04_OFFSET,
    _read_band,
    _resample_to_match,
    _apply_baseline_offset
)

__all__ = [
    "process_and_save_indices",
    "SCL_DROP_CLASSES",
    "BASELINE_04_CUTOFF",
    "BASELINE_04_OFFSET",
    "_read_band",
    "_resample_to_match",
    "_apply_baseline_offset"
]

