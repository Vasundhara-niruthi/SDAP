"""
=============================================================================
SDAP Optical Cloud Removal & Full-Tile Index Processor (SRS 8.4.1 & 8.4.3)
=============================================================================
Location: backend/app/services/processor_service.py

Description:
    1. Cloud Masking (Optical): Uses SCL (Scene Classification Layer) to discard
       pixels labelled cloud (8, 9), cloud shadow (3), cirrus (10), snow (11),
       and defective (1). Retains vegetation (4), bare soil (5), and water (6).
    2. Cloud Mask Dilation: Expands cloud mask by ~2 pixels using pure numpy dilation.
    3. Full-Tile Index Calculation (SRS 8.4.3): Calculates NDVI, LSWI, VV/VH ratio
       on the FULL tile prior to clipping, saving the indexed tile to the archive.
=============================================================================
"""

import os
import sys
import logging
from typing import Dict, Any, Tuple, Optional, List

import numpy as np
import rasterio

logger = logging.getLogger("sdap.processor")

# SCL Scene Classification Values to MASK OUT (discard):
# 0: No Data, 1: Saturated/Defective, 2: Dark Area Pixels, 3: Cloud Shadows,
# 8: Cloud Medium Probability, 9: Cloud High Probability, 10: Thin Cirrus, 11: Snow
INVALID_SCL_CLASSES = {0, 1, 2, 3, 8, 9, 10, 11}


def dilate_mask_numpy(mask: np.ndarray, dilation_pixels: int = 2) -> np.ndarray:
    """Expands boolean mask by dilation_pixels using pure numpy array rolls."""
    dilated = mask.copy()
    for dy in range(-dilation_pixels, dilation_pixels + 1):
        for dx in range(-dilation_pixels, dilation_pixels + 1):
            if dy == 0 and dx == 0:
                continue
            dilated |= np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
    return dilated


def generate_dilated_cloud_mask(scl_path: str, dilation_pixels: int = 2) -> Tuple[np.ndarray, dict]:
    """
    Reads SCL.tif, identifies cloud/shadow/cirrus/snow pixels, and dilates the mask
    by `dilation_pixels` (default 2 pixels) to catch soft cloud edges (SRS 8.4.1).
    Returns boolean mask (True = INVALID/DISCARD, False = VALID) and raster metadata.
    """
    if not os.path.exists(scl_path):
        raise FileNotFoundError(f"SCL mask file not found at '{scl_path}'.")

    with rasterio.open(scl_path) as src:
        scl_data = src.read(1)
        profile = src.profile.copy()

    # Create initial boolean mask of invalid classes
    invalid_mask = np.isin(scl_data, list(INVALID_SCL_CLASSES))

    # Dilate invalid mask by 2 pixels using pure NumPy dilation
    if dilation_pixels > 0:
        dilated_mask = dilate_mask_numpy(invalid_mask, dilation_pixels)
    else:
        dilated_mask = invalid_mask

    valid_count = np.count_nonzero(~dilated_mask)
    total_pixels = dilated_mask.size
    logger.info(f"Cloud masking (dilated {dilation_pixels}px): {valid_count:,}/{total_pixels:,} valid pixels ({valid_count/total_pixels*100:.1f}% clear)")

    return dilated_mask, profile


def compute_full_tile_index(
    band_paths: Dict[str, str],
    index_type: str,
    output_path: str,
    dilation_pixels: int = 2
) -> Tuple[str, float]:
    """
    Computes specified index on the FULL TILE before clipping (SRS 8.4.3).
    - NDVI: (B08 - B04) / (B08 + B04)
    - LSWI: (B08A - B11) / (B08A + B11)
    - VV_VH_RATIO: 10 * log10(VV) - 10 * log10(VH)
    
    Returns (output_path, clear_coverage_percentage).
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    index_type = index_type.upper()

    # 1. Cloud Masking via SCL.tif if present
    invalid_mask = None
    if "SCL" in band_paths and os.path.exists(band_paths["SCL"]):
        invalid_mask, scl_profile = generate_dilated_cloud_mask(band_paths["SCL"], dilation_pixels)

    if index_type == "NDVI":
        b04_path = band_paths.get("B04")
        b08_path = band_paths.get("B08")
        if not b04_path or not b08_path:
            raise ValueError("NDVI requires both 'B04' and 'B08' band paths.")

        with rasterio.open(b04_path) as src_red, rasterio.open(b08_path) as src_nir:
            red = src_red.read(1).astype(np.float32)
            nir = src_nir.read(1).astype(np.float32)
            profile = src_nir.profile.copy()

        # Calculate NDVI: (NIR - RED) / (NIR + RED)
        denom = nir + red
        denom[denom == 0] = np.nan
        ndvi = (nir - red) / denom
        
        # Apply cloud mask (set invalid pixels to NaN)
        if invalid_mask is not None:
            if invalid_mask.shape != ndvi.shape:
                # Resize mask if SCL resolution differs (e.g. 20m vs 10m)
                from rasterio.enums import Resampling
                # Fast slice sampling if dimensions differ
                invalid_mask = invalid_mask[::2, ::2] if ndvi.shape[0] > invalid_mask.shape[0] else invalid_mask
            ndvi[invalid_mask[:ndvi.shape[0], :ndvi.shape[1]]] = np.nan

        valid_pixels = np.count_nonzero(~np.isnan(ndvi))
        coverage_pct = (valid_pixels / ndvi.size) * 100.0

        # Save indexed raster
        profile.update(dtype=rasterio.float32, count=1, nodata=np.nan)
        with rasterio.open(output_path, "w", **profile) as dst:
            dst.write(ndvi.astype(np.float32), 1)

        logger.info(f"[INDEX COMPUTED] Full-Tile NDVI -> '{output_path}' (Clear Coverage: {coverage_pct:.2f}%)")
        return output_path, round(coverage_pct, 2)

    elif index_type == "LSWI":
        b08a_path = band_paths.get("B08A") or band_paths.get("B8A")
        b11_path = band_paths.get("B11")
        if not b08a_path or not b11_path:
            raise ValueError("LSWI requires both 'B08A' and 'B11' band paths.")

        with rasterio.open(b08a_path) as src_nir, rasterio.open(b11_path) as src_swir:
            nir = src_nir.read(1).astype(np.float32)
            swir = src_swir.read(1).astype(np.float32)
            profile = src_swir.profile.copy()

        # Calculate LSWI: (NIR - SWIR) / (NIR + SWIR)
        denom = nir + swir
        denom[denom == 0] = np.nan
        lswi = (nir - swir) / denom

        if invalid_mask is not None:
            lswi[invalid_mask[:lswi.shape[0], :lswi.shape[1]]] = np.nan

        valid_pixels = np.count_nonzero(~np.isnan(lswi))
        coverage_pct = (valid_pixels / lswi.size) * 100.0

        profile.update(dtype=rasterio.float32, count=1, nodata=np.nan)
        with rasterio.open(output_path, "w", **profile) as dst:
            dst.write(lswi.astype(np.float32), 1)

        logger.info(f"[INDEX COMPUTED] Full-Tile LSWI -> '{output_path}' (Clear Coverage: {coverage_pct:.2f}%)")
        return output_path, round(coverage_pct, 2)

    elif index_type in {"VV_VH", "VV/VH", "RADAR_RATIO"}:
        vv_path = band_paths.get("VV")
        vh_path = band_paths.get("VH")
        if not vv_path or not vh_path:
            raise ValueError("Radar VV/VH ratio requires both 'VV' and 'VH' band paths.")

        with rasterio.open(vv_path) as src_vv, rasterio.open(vh_path) as src_vh:
            vv = src_vv.read(1).astype(np.float32)
            vh = src_vh.read(1).astype(np.float32)
            profile = src_vv.profile.copy()

        vv[vv <= 0] = np.nan
        vh[vh <= 0] = np.nan
        ratio_db = 10.0 * np.log10(vv) - 10.0 * np.log10(vh)

        valid_pixels = np.count_nonzero(~np.isnan(ratio_db))
        coverage_pct = (valid_pixels / ratio_db.size) * 100.0

        profile.update(dtype=rasterio.float32, count=1, nodata=np.nan)
        with rasterio.open(output_path, "w", **profile) as dst:
            dst.write(ratio_db.astype(np.float32), 1)

        logger.info(f"[INDEX COMPUTED] Full-Tile VV/VH Ratio -> '{output_path}' (Coverage: {coverage_pct:.2f}%)")
        return output_path, round(coverage_pct, 2)

    else:
        raise NotImplementedError(f"Index type '{index_type}' is not supported. Supported: NDVI, LSWI, VV/VH.")

