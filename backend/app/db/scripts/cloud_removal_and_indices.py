"""
=============================================================================
SDAP Optical Cloud Removal & Spectral Indices Processor (SRS 8.4.1 & 8.4.3)
=============================================================================
Location: backend/scripts/cloud_removal_and_indices.py

Description:
    Computes cloud-masked NDVI and LSWI spectral indices from downloaded
    Sentinel-2 Level-2A bands (B04, B08, B11, SCL).

    1. Spatial Grid Alignment:
       Resamples 20m bands (B11 SWIR, SCL Cloud Mask) to match the 10m grid
       (B04 Red, B08 NIR) exactly (10980x10980) using rasterio reprojection.
    2. Cloud & Shadow Masking (SRS 8.4.1):
       Uses SCL (Scene Classification Layer) to mask out classes 3, 8, 9, 10
       (Cloud Shadows, Med/High Cloud, Thin Cirrus).
    3. Radiometric Offset Correction:
       Applies Sentinel-2 baseline 04.00+ processing baseline offset if applicable.
    4. Index Calculations:
       - NDVI: (NIR - RED) / (NIR + RED)
       - LSWI: (NIR - SWIR) / (NIR + SWIR)
    5. Output Generation:
       Saves compressed (LZW) GeoTIFF rasters for ONLY 'NDVI.tif' and 'LSWI.tif'.
    6. Returns:
       (ndvi_path, lswi_path, clear_coverage_percentage)
=============================================================================
"""

import os
import datetime
from typing import Tuple, Union
import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling

SCL_DROP_CLASSES = [3, 8, 9, 10]  # cloud shadow, cloud med/high probability, thin cirrus
BASELINE_04_CUTOFF = datetime.date(2022, 1, 25)
BASELINE_04_OFFSET = 0.0  # DN units — 0 for AWS sentinel-s2-l2a-cogs


def _read_band(path: str) -> Tuple[np.ndarray, dict]:
    with rasterio.open(path) as src:
        arr = src.read(1).astype("float32")
        profile = src.profile.copy()
    return arr, profile


def _resample_to_match(
    src_path: str,
    ref_profile: dict,
    resampling: Resampling = Resampling.bilinear
) -> np.ndarray:
    """Resamples source raster to match target reference raster shape, CRS, and transform."""
    with rasterio.open(src_path) as src:
        dst = np.empty((ref_profile["height"], ref_profile["width"]), dtype="float32")
        reproject(
            source=rasterio.band(src, 1),
            destination=dst,
            src_transform=src.transform,
            src_crs=src.crs,
            dst_transform=ref_profile["transform"],
            dst_crs=ref_profile["crs"],
            resampling=resampling,
        )
    return dst


def _apply_baseline_offset(band_array: np.ndarray, acq_date: datetime.date) -> np.ndarray:
    if acq_date >= BASELINE_04_CUTOFF and BASELINE_04_OFFSET != 0.0:
        return band_array + BASELINE_04_OFFSET
    return band_array


def process_and_save_indices(
    red_path: str,
    nir_path: str,
    swir1_path: str,
    scl_path: str,
    district: str,
    acq_date: Union[str, datetime.date],
    output_dir: str
) -> Tuple[str, str, float]:
    """
    Computes cloud-masked NDVI & LSWI GeoTIFF rasters from Sentinel-2 bands.
    Saves ONLY 'NDVI.tif' and 'LSWI.tif' into output_dir (the scene folder).

    Returns:
        (ndvi_path, lswi_path, clear_coverage_percentage)
    """
    if isinstance(acq_date, str):
        try:
            acq_date_obj = datetime.datetime.strptime(acq_date.split("T")[0], "%Y-%m-%d").date()
        except ValueError:
            acq_date_obj = datetime.date.today()
    else:
        acq_date_obj = acq_date

    # 1. Read Red (B04) — defines 10m reference grid
    red, profile = _read_band(red_path)
    nir, _ = _read_band(nir_path)

    # 2. Resample B11 (20m) and SCL (20m) to 10m grid
    swir1 = _resample_to_match(swir1_path, profile, resampling=Resampling.bilinear)
    scl = _resample_to_match(scl_path, profile, resampling=Resampling.nearest)

    # 3. Apply baseline offset
    red = _apply_baseline_offset(red, acq_date_obj)
    nir = _apply_baseline_offset(nir, acq_date_obj)
    swir1 = _apply_baseline_offset(swir1, acq_date_obj)

    # 4. Cloud-free mask (True = clear pixel)
    cloud_free = np.isin(scl, SCL_DROP_CLASSES, invert=True)

    # 5. Compute indices
    with np.errstate(divide="ignore", invalid="ignore"):
        denom_ndvi = nir + red
        denom_ndvi[denom_ndvi == 0] = np.nan
        ndvi = (nir - red) / denom_ndvi

        denom_lswi = nir + swir1
        denom_lswi[denom_lswi == 0] = np.nan
        lswi = (nir - swir1) / denom_lswi

    # Clamp to valid range [-1.0, 1.0]
    ndvi = np.where(np.isfinite(ndvi) & (ndvi >= -1.0) & (ndvi <= 1.0), ndvi, np.nan)
    lswi = np.where(np.isfinite(lswi) & (lswi >= -1.0) & (lswi <= 1.0), lswi, np.nan)

    # Apply cloud mask
    ndvi = np.where(cloud_free, ndvi, np.nan).astype("float32")
    lswi = np.where(cloud_free, lswi, np.nan).astype("float32")

    # 6. Coverage %
    valid_pixels = int(np.count_nonzero(~np.isnan(ndvi)))
    total_pixels = ndvi.size
    coverage_pct = round((valid_pixels / total_pixels) * 100.0, 2) if total_pixels > 0 else 0.0

    # 7. Output profile
    os.makedirs(output_dir, exist_ok=True)
    out_profile = dict(profile)
    out_profile.update(
        dtype="float32",
        count=1,
        nodata=np.nan,
        compress="lzw",
        predictor=3
    )

    # 8. Save ONLY NDVI.tif and LSWI.tif into scene folder
    ndvi_direct = os.path.join(output_dir, "NDVI.tif")
    lswi_direct = os.path.join(output_dir, "LSWI.tif")

    for path, arr in [(ndvi_direct, ndvi), (lswi_direct, lswi)]:
        with rasterio.open(path, "w", **out_profile) as dst:
            dst.write(arr, 1)

    return ndvi_direct, lswi_direct, coverage_pct

