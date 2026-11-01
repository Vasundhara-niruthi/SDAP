"""
Optical cloud removal and full-tile index calculation (SRS 8.4.1 & 8.4.3).

Masks cloud/shadow/cirrus/snow/defective pixels via SCL (dilated ~2 px), then computes
NDVI, LSWI and VV/VH ratio on the full tile before clipping.
"""

import os
import logging
from typing import Dict, Tuple

import numpy as np
import rasterio

logger = logging.getLogger("sdap.processor")

# SCL classes to mask out: 0 no data, 1 saturated/defective, 2 dark area, 3 cloud shadow,
# 8/9 cloud medium/high, 10 thin cirrus, 11 snow
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
    Builds a cloud/shadow/cirrus/snow mask from SCL.tif, dilated by `dilation_pixels` to catch soft edges.
    Returns (mask, raster metadata); mask is True where pixels are invalid.
    """
    if not os.path.exists(scl_path):
        raise FileNotFoundError(f"SCL mask file not found at '{scl_path}'.")

    with rasterio.open(scl_path) as src:
        scl_data = src.read(1)
        profile = src.profile.copy()

    invalid_mask = np.isin(scl_data, list(INVALID_SCL_CLASSES))

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
    Computes an index on the full tile before clipping (SRS 8.4.3).
    NDVI = (B08-B04)/(B08+B04); LSWI = (B08A-B11)/(B08A+B11); VV_VH_RATIO = 10*log10(VV) - 10*log10(VH).
    Returns (output_path, clear_coverage_percentage).
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    index_type = index_type.upper()

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

        denom = nir + red
        denom[denom == 0] = np.nan
        ndvi = (nir - red) / denom
        
        if invalid_mask is not None:
            if invalid_mask.shape != ndvi.shape:
                sy = max(1, ndvi.shape[0] // invalid_mask.shape[0])
                sx = max(1, ndvi.shape[1] // invalid_mask.shape[1])
                invalid_mask = np.repeat(np.repeat(invalid_mask, sy, axis=0), sx, axis=1)
            ndvi[invalid_mask[:ndvi.shape[0], :ndvi.shape[1]]] = np.nan

        valid_pixels = np.count_nonzero(~np.isnan(ndvi))
        coverage_pct = (valid_pixels / ndvi.size) * 100.0

        profile.update(dtype=rasterio.float32, count=1, nodata=np.nan, compress="lzw")
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

        denom = nir + swir
        denom[denom == 0] = np.nan
        lswi = (nir - swir) / denom

        if invalid_mask is not None:
            if invalid_mask.shape != lswi.shape:
                sy = max(1, lswi.shape[0] // invalid_mask.shape[0])
                sx = max(1, lswi.shape[1] // invalid_mask.shape[1])
                invalid_mask = np.repeat(np.repeat(invalid_mask, sy, axis=0), sx, axis=1)
            lswi[invalid_mask[:lswi.shape[0], :lswi.shape[1]]] = np.nan

        valid_pixels = np.count_nonzero(~np.isnan(lswi))
        coverage_pct = (valid_pixels / lswi.size) * 100.0

        profile.update(dtype=rasterio.float32, count=1, nodata=np.nan, compress="lzw")
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

