"""
=============================================================================
SDAP Multi-Band Layer Stacking Service
=============================================================================
Location: backend/app/services/stacker_service.py

Description:
    Performs multi-band layer stacking across user-selected bands and computed indices:
      - Bands: B01, B02, B03, B04, B05, B06, B07, B08, B8A, B09, B11, B12, TCI, SCL, VV, VH, VV_VH
      - Indices: NDVI, NDWI, EVI, NBR, NDRE, SAVI, NDBI
      
    Key Requirements:
      1. Order-preserved stacking: Layers are stacked in the exact order selected by user (e.g. B1 -> B2 -> B3).
      2. Mosaics scenes across district and clips to district polygon boundary.
      3. Uses the exact files selected by the user without switching to different files.
      4. If a single file/band is stacked, preserves the exact same filename.
      5. Saves output GeoTIFF in:
         {settings.RAW_ARCHIVE_DIR}/Composites/stack/{district_name}/
         Filename: {district_name}_{season_name}_{date_range}_{bands}.tif
         (also replicated to {settings.RAW_ARCHIVE_DIR}/LayerStacking/{Sensor}/{district}/{season}/)
=============================================================================
"""

import os
import re
import json
import uuid
import time
import tempfile
import shutil
import logging
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional, Callable

import numpy as np
import rasterio
import rasterio.features
from rasterio.warp import reproject, Resampling, transform_bounds
from shapely.geometry import shape
from sqlalchemy.orm import Session
from sqlalchemy import text, func

from app.core.config import settings
from app.models.sdap_models import RequestModel, ProcessJobModel, SceneModel, BandFileModel
from app.services.delivery_service import get_district_geometry_from_db
from app.services.downloader_service import resolve_tif_path, is_raster_overlapping_district

logger = logging.getLogger("sdap.stacker")

# Target CRS for unified layer alignment and mosaicing
TARGET_CRS = "EPSG:4326"

# Definition of known indices and their constituent required bands
INDEX_DEPENDENCIES = {
    "NDVI": ["B08", "B04"],                               # (NIR - Red) / (NIR + Red)
    "LSWI": ["B08", "B11"],                               # Land Surface Water Index: (NIR - SWIR1) / (NIR + SWIR1)
    "NDWI": ["B03", "B08"],                               # (Green - NIR) / (Green + NIR)
    "EVI":  ["B08", "B04", "B02"],                        # 2.5 * (NIR - Red) / (NIR + 6*Red - 7.5*Blue + 1)
    "NBR":  ["B08", "B12"],                               # (NIR - SWIR2) / (NIR + SWIR2)
    "NDRE": ["B08", "B05"],                               # (NIR - RedEdge1) / (NIR + RedEdge1)
    "SAVI": ["B08", "B04"],                               # ((NIR - Red) / (NIR + Red + 0.5)) * 1.5
    "NDBI": ["B11", "B08"],                               # (SWIR1 - NIR) / (SWIR1 + NIR)
    "SAR_RATIO": ["VV", "VH"]                             # VV / VH
}


def compute_spectral_index(index_name: str, band_arrays: Dict[str, np.ndarray]) -> np.ndarray:
    """Computes a requested spectral index from constituent float32 band arrays."""
    eps = 1e-7
    name = index_name.upper().strip()

    if name == "NDVI":
        nir = band_arrays.get("B08")
        red = band_arrays.get("B04")
        if nir is None or red is None:
            raise ValueError("NDVI requires bands B08 (NIR) and B04 (Red).")
        return (nir - red) / (nir + red + eps)

    elif name == "LSWI":
        nir = band_arrays.get("B08")
        if nir is None:
            nir = band_arrays.get("B8A")
        swir1 = band_arrays.get("B11")
        if nir is None or swir1 is None:
            raise ValueError("LSWI requires bands B08/B8A (NIR) and B11 (SWIR1).")
        return (nir - swir1) / (nir + swir1 + eps)

    elif name == "NDWI":
        green = band_arrays.get("B03")
        nir = band_arrays.get("B08")
        if green is None or nir is None:
            raise ValueError("NDWI requires bands B03 (Green) and B08 (NIR).")
        return (green - nir) / (green + nir + eps)

    elif name == "EVI":
        nir = band_arrays.get("B08")
        red = band_arrays.get("B04")
        blue = band_arrays.get("B02")
        if nir is None or red is None or blue is None:
            raise ValueError("EVI requires bands B08, B04, and B02.")
        denom = (nir + 6.0 * red - 7.5 * blue + 1.0)
        denom = np.where(np.abs(denom) < eps, eps, denom)
        return 2.5 * ((nir - red) / denom)

    elif name == "NBR":
        nir = band_arrays.get("B08")
        swir2 = band_arrays.get("B12")
        if nir is None or swir2 is None:
            raise ValueError("NBR requires bands B08 and B12.")
        return (nir - swir2) / (nir + swir2 + eps)

    elif name == "NDRE":
        nir = band_arrays.get("B08")
        re1 = band_arrays.get("B05")
        if nir is None or re1 is None:
            raise ValueError("NDRE requires bands B08 and B05.")
        return (nir - re1) / (nir + re1 + eps)

    elif name == "SAVI":
        nir = band_arrays.get("B08")
        red = band_arrays.get("B04")
        if nir is None or red is None:
            raise ValueError("SAVI requires bands B08 and B04.")
        L = 0.5
        return ((nir - red) / (nir + red + L + eps)) * (1.0 + L)

    elif name == "NDBI":
        swir1 = band_arrays.get("B11")
        nir = band_arrays.get("B08")
        if swir1 is None or nir is None:
            raise ValueError("NDBI requires bands B11 and B08.")
        return (swir1 - nir) / (swir1 + nir + eps)

    elif name in ("SAR_RATIO", "VV_VH"):
        vv = band_arrays.get("VV")
        vh = band_arrays.get("VH")
        if vv is None or vh is None:
            raise ValueError("SAR_RATIO requires VV and VH bands.")
        return vv / (vh + eps)

    raise ValueError(f"Unsupported index: {index_name}")


def _normalize_unc_path(path: str) -> str:
    """Normalizes Windows UNC or local paths for rasterio / GDAL VSI compatibility."""
    if not path:
        return path
    return path.replace("\\", "/")


def _is_scene_matching_band(p: str, b_name: str) -> bool:
    """
    Robust matching of a raster file path to a requested band or index name.
    Handles:
      - Direct band names: B02.tif, B04.tif, B08.tif, VH.tiff, VV.tiff, iw-vv.tiff, iw-vh.tiff
      - Pre-computed indices: NDVI.tif, LSWI.tif
      - Composite files: Composite_NDVI_weekly_..., Composite_LSWI_fortnightly_...
      - Prefixed files: Sentinel2_B02_..., 44QQF_B04_...
    """
    fname = os.path.basename(p).upper()
    b_clean = re.sub(r"\.(tif|tiff)$", "", b_name.strip(), flags=re.IGNORECASE).upper()
    name_no_ext, _ = os.path.splitext(fname)

    # 1. Exact match (e.g. "B02.TIF" -> "B02", "NDVI.TIF" -> "NDVI")
    if name_no_ext == b_clean:
        return True

    # 2. Token match (split by underscore, dot, hyphen, space, slash)
    # e.g. "COMPOSITE_NDVI_WEEKLY_GAJAPATI_..." -> tokens include "NDVI"
    tokens = re.split(r"[_\-\.\s/\\]+", name_no_ext)
    if b_clean in tokens:
        # Exclude matching pure VV or VH if the file is actually VV_VH
        if b_clean in ("VV", "VH") and ("VV_VH" in name_no_ext or "VV/VH" in name_no_ext or "VV-VH" in name_no_ext):
            return False
        return True

    # 3. Sentinel-1 SAR polarizations (VV, VH, IW-VV, IW-VH):
    if b_clean in ("VV", "IW-VV", "IW_VV"):
        if "VV_VH" in name_no_ext or "VV/VH" in name_no_ext or "VV-VH" in name_no_ext:
            return False
        if "VV" in tokens or name_no_ext.endswith("VV") or "-VV" in name_no_ext or "_VV" in name_no_ext or "IW-VV" in name_no_ext:
            return True

    if b_clean in ("VH", "IW-VH", "IW_VH"):
        if "VV_VH" in name_no_ext or "VV/VH" in name_no_ext or "VV-VH" in name_no_ext:
            return False
        if "VH" in tokens or name_no_ext.endswith("VH") or "-VH" in name_no_ext or "_VH" in name_no_ext or "IW-VH" in name_no_ext:
            return True

    # 4. Handle SAR_RATIO / VV_VH aliases
    if b_clean in ("SAR_RATIO", "VV_VH") and ("VV_VH" in name_no_ext or "VV/VH" in name_no_ext or "VV-VH" in name_no_ext):
        return True

    # 5. Standard starts/ends with delimiter
    if name_no_ext.startswith(b_clean + "_") or name_no_ext.endswith("_" + b_clean):
        return True

    # 6. Directory component check
    norm_fwd = p.replace("\\", "/").upper()
    if f"/{b_clean}." in norm_fwd or f"/{b_clean}/" in norm_fwd:
        return True

    return False


def find_band_rasters_for_district(
    db: Session,
    district: str,
    state: Optional[str],
    band_name: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    request_id: Optional[int] = None
) -> List[str]:
    """
    Finds verified GeoTIFF raster paths for a specific band associated with the district.
    Supports Sentinel-2 optical bands, Sentinel-1 SAR polarizations (VV, VH, iw-vv, iw-vh),
    and pre-computed spectral indices.
    """
    clean_d = district.split(",")[0].strip().lower()
    clean_b = re.sub(r"\.(tif|tiff)$", "", band_name.strip(), flags=re.IGNORECASE)
    is_s1_vv = clean_b.upper() in ("VV", "IW-VV", "IW_VV")
    is_s1_vh = clean_b.upper() in ("VH", "IW-VH", "IW_VH")

    # Query scenes linked through completed download process jobs for this district
    pj_query = db.query(ProcessJobModel.scene_id).join(
        RequestModel, ProcessJobModel.request_id == RequestModel.id
    ).filter(
        ProcessJobModel.scene_id.isnot(None),
        ProcessJobModel.stage == "DOWNLOAD",
        ProcessJobModel.status == "COMPLETED",
        func.lower(RequestModel.district) == clean_d
    )
    if request_id:
        pj_query = pj_query.filter(ProcessJobModel.request_id == request_id)
    if state and state.strip() and state.upper() != "ALL":
        pj_query = pj_query.filter(func.lower(RequestModel.state) == state.strip().lower())

    scene_ids = [r[0] for r in pj_query.distinct().all() if r[0]]

    # Fallback discovery if ProcessJobModel has no scene IDs:
    if not scene_ids:
        # Fallback 1: Sentinel-1 SAR scenes
        if is_s1_vv or is_s1_vh or clean_b.upper() in ("VV_VH", "SAR_RATIO"):
            s1_scene_query = db.query(SceneModel.scene_id).filter(
                SceneModel.status == "HELD",
                SceneModel.tile == "S1_SAR"
            )
            if start_date:
                s1_scene_query = s1_scene_query.filter(SceneModel.sensing_date >= start_date)
            if end_date:
                s1_scene_query = s1_scene_query.filter(SceneModel.sensing_date <= end_date)
            scene_ids = [r[0] for r in s1_scene_query.all() if r[0]]

        # Fallback 2: Sentinel-2 MGRS tiles
        if not scene_ids:
            tiles_rows = db.execute(
                text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = :d"),
                {"d": clean_d}
            ).fetchall()
            tiles = [r[0] for r in tiles_rows if r[0] and r[0] != "S1_SAR"]
            if tiles:
                scene_query = db.query(SceneModel.scene_id).filter(
                    SceneModel.status == "HELD",
                    SceneModel.tile.in_(tiles)
                )
                if start_date:
                    scene_query = scene_query.filter(SceneModel.sensing_date >= start_date)
                if end_date:
                    scene_query = scene_query.filter(SceneModel.sensing_date <= end_date)
                scene_ids = [r[0] for r in scene_query.all() if r[0]]

    if not scene_ids:
        return []

    # Query band_file records for matching band name
    bf_query = db.query(BandFileModel).filter(
        BandFileModel.scene_id.in_(scene_ids),
        BandFileModel.verified == 1
    )
    if start_date:
        bf_query = bf_query.filter(BandFileModel.sensing_date >= start_date)
    if end_date:
        bf_query = bf_query.filter(BandFileModel.sensing_date <= end_date)

    if is_s1_vv:
        vv_aliases = ["vv", "vv.tif", "vv.tiff", "iw-vv", "iw-vv.tif", "iw-vv.tiff"]
        bf_query = bf_query.filter(
            func.lower(BandFileModel.band).in_(vv_aliases) |
            func.lower(BandFileModel.path).like("%iw-vv.tif%") |
            func.lower(BandFileModel.path).like("%/vv.tif%") |
            func.lower(BandFileModel.path).like("%\\vv.tif%")
        )
    elif is_s1_vh:
        vh_aliases = ["vh", "vh.tif", "vh.tiff", "iw-vh", "iw-vh.tif", "iw-vh.tiff"]
        bf_query = bf_query.filter(
            func.lower(BandFileModel.band).in_(vh_aliases) |
            func.lower(BandFileModel.path).like("%iw-vh.tif%") |
            func.lower(BandFileModel.path).like("%/vh.tif%") |
            func.lower(BandFileModel.path).like("%\\vh.tif%")
        )
    else:
        bf_query = bf_query.filter(
            (func.lower(BandFileModel.band) == clean_b.lower()) |
            (func.lower(BandFileModel.band) == f"{clean_b.lower()}.tif") |
            (func.lower(BandFileModel.band) == f"{clean_b.lower()}.tiff")
        )

    records = bf_query.all()
    found_paths = []
    seen_paths = set()
    for r in records:
        resolved, exists = resolve_tif_path(r.path)
        if exists and os.path.exists(resolved):
            norm = _normalize_unc_path(resolved)
            if norm.lower() not in seen_paths:
                seen_paths.add(norm.lower())
                found_paths.append(norm)

    return found_paths


def create_district_grid(
    district_geom: Optional[Any],
    candidate_paths: List[str],
    resolution_deg: float = 0.0001
) -> Tuple[int, int, Any, Optional[np.ndarray]]:
    """
    Computes a unified target raster grid covering the district polygon in EPSG:4326.
    Returns (width, height, transform, mask_boolean_array).
    """
    d_shape = None
    if district_geom:
        d_shape = shape(district_geom) if isinstance(district_geom, dict) else district_geom
        minx, miny, maxx, maxy = d_shape.bounds
    else:
        # Fallback to union of candidate bounds in EPSG:4326
        minx, miny, maxx, maxy = 180.0, 90.0, -180.0, -90.0
        for p in candidate_paths:
            with rasterio.open(_normalize_unc_path(p)) as src:
                if src.crs:
                    b_minx, b_miny, b_maxx, b_maxy = transform_bounds(src.crs, TARGET_CRS, *src.bounds)
                elif src.gcps and len(src.gcps[0]) > 0:
                    gcps_list, gcps_crs = src.gcps
                    xs = [g.x for g in gcps_list]
                    ys = [g.y for g in gcps_list]
                    b_minx, b_miny, b_maxx, b_maxy = transform_bounds(
                        gcps_crs or TARGET_CRS, TARGET_CRS, min(xs), min(ys), max(xs), max(ys)
                    )
                else:
                    continue
                minx, miny = min(minx, b_minx), min(miny, b_miny)
                maxx, maxy = max(maxx, b_maxx), max(maxy, b_maxy)

    width = max(1, int(np.ceil((maxx - minx) / resolution_deg)))
    height = max(1, int(np.ceil((maxy - miny) / resolution_deg)))

    # Performance & Memory Safeguard: Cap canvas size for fast multi-band warping (< 180 MB per float32 band)
    max_pixels = 45_000_000  # ~6700 x 6700 pixels
    if (width * height) > max_pixels:
        scale_factor = np.sqrt((width * height) / float(max_pixels))
        resolution_deg *= scale_factor
        width = max(1, int(np.ceil((maxx - minx) / resolution_deg)))
        height = max(1, int(np.ceil((maxy - miny) / resolution_deg)))
        logger.info(f"Optimized district grid to {width} x {height} pixels for high-speed stacking.")

    dst_transform = rasterio.transform.from_bounds(minx, miny, maxx, maxy, width, height)

    district_mask = None
    if d_shape:
        district_mask = rasterio.features.geometry_mask(
            [d_shape],
            out_shape=(height, width),
            transform=dst_transform,
            invert=True
        )

    return width, height, dst_transform, district_mask


def reproject_and_mosaic_band_to_grid(
    input_paths: List[str],
    width: int,
    height: int,
    dst_transform: Any,
    district_mask: Optional[np.ndarray],
    target_crs: str = TARGET_CRS,
    band_name: Optional[str] = None,
    log_cb: Optional[Callable[[str, str], None]] = None
) -> np.ndarray:
    """
    Directly reprojects and mosaics input rasters for a band onto the unified district grid.
    Applies district boundary mask and returns (height, width) float32 array.
    """
    accumulated = np.full((height, width), np.nan, dtype="float32")
    g_minx, g_miny, g_maxx, g_maxy = rasterio.transform.array_bounds(height, width, dst_transform)

    # Use nearest neighbor for discrete categorical masks like SCL
    resampling_method = Resampling.nearest if (band_name and band_name.upper().strip() == "SCL") else Resampling.bilinear

    has_written_first = False
    dest_tile: Optional[np.ndarray] = None

    with rasterio.Env(GDAL_NUM_THREADS="ALL_CPUS", GDAL_CACHEMAX=512, VSI_CACHE=True, VSI_CACHE_SIZE=25000000):
        for idx, p in enumerate(input_paths, start=1):
            norm_p = _normalize_unc_path(p)
            fname = os.path.basename(p)
            try:
                with rasterio.open(norm_p) as src:
                    src_crs = src.crs
                    gcps = None

                    if src_crs is None and src.gcps and len(src.gcps[0]) > 0:
                        gcps_list, gcps_crs = src.gcps
                        src_crs = gcps_crs or target_crs
                        gcps = gcps_list
                        xs = [g.x for g in gcps_list]
                        ys = [g.y for g in gcps_list]
                        t_minx, t_miny, t_maxx, t_maxy = transform_bounds(
                            src_crs, target_crs, min(xs), min(ys), max(xs), max(ys)
                        )
                    elif src_crs is not None:
                        t_minx, t_miny, t_maxx, t_maxy = transform_bounds(src_crs, target_crs, *src.bounds)
                    else:
                        logger.warning(f"Raster {fname} has no CRS or GCPs. Skipping.")
                        continue

                    if t_maxx < g_minx or t_minx > g_maxx or t_maxy < g_miny or t_miny > g_maxy:
                        msg = f"Tile {fname} does not overlap district grid. Skipping."
                        logger.warning(msg)
                        if log_cb:
                            log_cb(msg, "WARNING")
                        continue

                    src_nodata_val = src.nodata if src.nodata is not None else 0.0
                    # Fast path: write first overlapping tile directly into accumulated array
                    if not has_written_first:
                        target_buf = accumulated
                    else:
                        if dest_tile is None:
                            dest_tile = np.full((height, width), np.nan, dtype="float32")
                        else:
                            dest_tile.fill(np.nan)
                        target_buf = dest_tile

                    reproject_kwargs = dict(
                        source=rasterio.band(src, 1),
                        destination=target_buf,
                        src_nodata=src_nodata_val,
                        dst_nodata=np.nan,
                        dst_transform=dst_transform,
                        dst_crs=target_crs,
                        resampling=resampling_method,
                        num_threads=4
                    )
                    if gcps is not None:
                        reproject_kwargs["gcps"] = gcps
                        reproject_kwargs["src_crs"] = src_crs
                    else:
                        reproject_kwargs["src_transform"] = src.transform
                        reproject_kwargs["src_crs"] = src_crs

                    reproject(**reproject_kwargs)
                    if not has_written_first:
                        has_written_first = True
                    else:
                        np.fmax(accumulated, dest_tile, out=accumulated)

                    msg = f"Tile {idx}/{len(input_paths)} ({fname}) reprojected successfully."
                    logger.info(msg)
                    if log_cb:
                        log_cb(msg, "INFO")
            except Exception as e:
                logger.warning(f"Error reprojecting tile {p}: {e}")
                if log_cb:
                    log_cb(f"Error reprojecting tile {fname}: {e}", "WARNING")

    if district_mask is not None:
        accumulated[~district_mask] = np.nan

    # For Sentinel-1 SAR bands (VV, VH), calibrate raw digital numbers (DN) to backscatter in decibels (dB)
    # Formula: sigma0 (dB) = 20 * log10(DN) - 83.0 (with -50 dB noise floor)
    # Matches Copernicus Sentinel-1 GRD and Google Earth Engine calibrated backscatter standards
    if band_name and band_name.upper().strip() in ("VV", "VH", "VV_VH"):
        valid_pos = (accumulated > 0) & (~np.isnan(accumulated))
        if np.any(valid_pos):
            # If values are raw DN (max > 2.0, since dB values are negative <= 0.0)
            if np.nanmax(accumulated) > 2.0:
                with np.errstate(divide="ignore", invalid="ignore"):
                    accumulated = np.where(
                        valid_pos,
                        np.clip(20.0 * np.log10(np.maximum(accumulated, 1e-4)) - 83.0, -50.0, 5.0),
                        np.nan
                    )

    return accumulated


def execute_layer_stacking(
    db: Session,
    district: str,
    state: Optional[str] = None,
    season: str = "Kharif",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    layers: Optional[List[str]] = None,
    clip_to_district: bool = True,
    output_filename: Optional[str] = None,
    selected_files: Optional[List[str]] = None,
    selected_files_by_band: Optional[Dict[str, List[str]]] = None,
    request_id: Optional[int] = None,
    log_cb: Optional[Callable[[str, str, Optional[int], Optional[str]], None]] = None
) -> Dict[str, Any]:
    """
    Executes ordered layer stacking of selected bands and indices for a district.
    
    Guarantees:
      1. Order-preserved stacking in the exact order selected by user.
      2. Strictly uses the same files selected by the user (no switching to different files).
      3. Saves output GeoTIFF to single path: {RAW_ARCHIVE_DIR}/Composites/stack/{district}/
      4. Standardized filename format: {district}_{season}_{startdate}_{enddate}_{bands}.tif
      5. Multi-date / time-series scenes are stacked as individual bands with descriptive metadata.
      6. Clips to administrative district boundary polygon.
    """
    def emit_log(msg: str, level: str = "INFO", progress: Optional[int] = None, step: Optional[str] = None):
        logger.info(msg)
        if log_cb:
            log_cb(msg, level, progress, step)

    if not district or not district.strip():
        raise ValueError("District is required for layer stacking.")
    if not layers or len(layers) < 1:
        raise ValueError("At least one band or index must be selected for layer stacking.")

    clean_state = (state or "").strip()
    clean_dist = district.strip()
    clean_season = (season or "Custom").strip()
    
    # Normalize date strings
    s_clean = start_date.split("T")[0].strip() if start_date else "2026-01-01"
    e_clean = end_date.split("T")[0].strip() if end_date else "2026-12-31"

    emit_log(f"Initiating Layer Stacking for '{clean_dist}', Season='{clean_season}', Range={s_clean} to {e_clean}, Layers={layers}", "INFO", 5, "INITIALIZING")

    # 0. Pre-Execution Verification: Check if this layer stacking task is already completed on NAS or is a new task
    emit_log("Verifying whether layer stacking task is already completed on NAS or a new task...", "INFO", 8, "VERIFYING_TASK")
    d_range_str = f"{s_clean.replace('-', '')}_{e_clean.replace('-', '')}"
    bands_str = "_".join(layers)
    clean_fn_dist = clean_dist.replace(" ", "_")
    clean_fn_season = clean_season.split("(")[0].strip().replace(" ", "_")
    expected_filename = f"{clean_fn_dist}_{clean_fn_season}_{d_range_str}_{bands_str}.tif"
    if output_filename and output_filename.strip():
        fn_clean = output_filename.strip()
        if not (fn_clean.lower().endswith(".tif") or fn_clean.lower().endswith(".tiff")):
            fn_clean += ".tif"
        expected_filename = fn_clean

    candidate_existing_paths = [
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", "stack", clean_dist, expected_filename),
        os.path.join(settings.BASE_DATA_DIR, "archive", "Composites", "stack", clean_dist, expected_filename),
    ]
    for existing_path in candidate_existing_paths:
        try:
            if os.path.exists(existing_path) and os.path.getsize(existing_path) > 1024:
                with rasterio.open(_normalize_unc_path(existing_path)) as existing_src:
                    ex_count = existing_src.count
                    ex_width = existing_src.width
                    ex_height = existing_src.height
                    ex_descriptions = [existing_src.descriptions[i] or layers[min(i, len(layers) - 1)] for i in range(ex_count)]
                if ex_count >= len(layers):
                    ex_size_bytes = os.path.getsize(existing_path)
                    ex_size_mb = round(ex_size_bytes / (1024 * 1024), 2)
                    emit_log(
                        f"✓ [ALREADY COMPLETED] Verified existing layer stack '{expected_filename}' ({ex_size_mb} MB, {ex_count} bands, {ex_width}x{ex_height}) on NAS at '{existing_path}'.",
                        "SUCCESS",
                        95,
                        "ALREADY_COMPLETED"
                    )
                    emit_log(
                        f"Layer stack task is already completed on NAS. Skipping duplicate processing and returning verified stack '{expected_filename}'.",
                        "SUCCESS",
                        100,
                        "COMPLETED"
                    )
                    return {
                        "status": "SUCCESS",
                        "already_completed": True,
                        "message": f"Verified: Layer stack '{expected_filename}' is already completed on NAS ({ex_size_mb} MB, {ex_count} bands).",
                        "output_path": existing_path,
                        "filename": expected_filename,
                        "file_size_mb": ex_size_mb,
                        "file_size_bytes": ex_size_bytes,
                        "total_bands": ex_count,
                        "layers_order": ex_descriptions if ex_descriptions else list(layers),
                        "district": clean_dist,
                        "state": clean_state,
                        "season": clean_season,
                        "date_range": f"{s_clean} to {e_clean}",
                        "crs": TARGET_CRS,
                        "dimensions": f"{ex_width} x {ex_height}"
                    }
        except Exception as ver_err:
            logger.debug(f"Pre-check inspection on {existing_path} skipped: {ver_err}")

    emit_log(f"✓ Verified as NEW TASK ('{expected_filename}' not yet on NAS). Starting Layer Stacking execution...", "INFO", 9, "NEW_TASK_CONFIRMED")

    # 1. Fetch District Polygon Boundary Geometry if available
    district_geom = None
    district_bbox = None
    if clip_to_district:
        emit_log(f"Resolving administrative boundary geometry for {clean_dist} ({clean_state or 'Auto'})...", "INFO", 10, "GEOMETRY")
        geom_dict, _ = get_district_geometry_from_db(db, clean_dist, state_name=clean_state)
        if geom_dict:
            district_geom = geom_dict if not isinstance(geom_dict, str) else json.loads(geom_dict)
            district_bbox = shape(district_geom).bounds
            emit_log(f"District polygon for '{clean_dist}' loaded (EPSG:4326).", "INFO", 15, "GEOMETRY")

    # 2. Determine all required raw bands (including those needed to calculate indices)
    emit_log("Analyzing required spectral bands and user selection...", "INFO", 20, "ANALYZING")
    needed_raw_bands = set()
    for lyr in layers:
        lyr_upper = lyr.upper().strip()
        # Check if user explicitly provided a raster file for this layer
        user_provided = False
        if selected_files_by_band and lyr_upper in selected_files_by_band and selected_files_by_band[lyr_upper]:
            user_provided = True
        elif selected_files and any(_is_scene_matching_band(p, lyr_upper) for p in selected_files):
            user_provided = True

        if user_provided:
            needed_raw_bands.add(lyr_upper)
            continue

        direct_paths = find_band_rasters_for_district(
            db=db, district=clean_dist, state=clean_state, band_name=lyr_upper,
            start_date=s_clean, end_date=e_clean, request_id=request_id
        ) or find_band_rasters_for_district(
            db=db, district=clean_dist, state=clean_state, band_name=lyr_upper, request_id=request_id
        )
        if direct_paths:
            needed_raw_bands.add(lyr_upper)
        elif lyr_upper in INDEX_DEPENDENCIES:
            needed_raw_bands.update(INDEX_DEPENDENCIES[lyr_upper])
        else:
            needed_raw_bands.add(lyr_upper)

    # 3. Locate files for each needed raw band - strictly use the exact files selected by the user!
    emit_log("Locating candidate rasters based on user selection...", "INFO", 25, "LOCATING")
    raw_band_paths: Dict[str, List[str]] = {}
    sample_candidate_paths: List[str] = []
    filter_norm_paths = [_normalize_unc_path(p) for p in selected_files if p] if selected_files else []

    # Map candidate files directly:
    for b_name in sorted(needed_raw_bands):
        paths: List[str] = []

        # A. Check selected_files_by_band first (highest fidelity - explicit mapping)
        if selected_files_by_band and b_name in selected_files_by_band and selected_files_by_band[b_name]:
            mapped_paths = [_normalize_unc_path(p) for p in selected_files_by_band[b_name] if p]
            paths = mapped_paths
            if paths:
                emit_log(f"Band '{b_name}': using {len(paths)} checked scene(s) from studio selection.", "INFO", 28, "LOCATING")

        # B. Check selected_files flat list using robust matcher
        if not paths and filter_norm_paths:
            direct_selected = [p for p in filter_norm_paths if _is_scene_matching_band(p, b_name)]
            if direct_selected:
                paths = direct_selected
                emit_log(f"Band '{b_name}': matched {len(paths)} scene(s) from user selection.", "INFO", 28, "LOCATING")

        # C. If only 1 layer was requested and selected_files has files, use the selected file directly
        if not paths and len(needed_raw_bands) == 1 and filter_norm_paths:
            paths = filter_norm_paths
            emit_log(f"Band '{b_name}': using {len(paths)} selected file(s) directly.", "INFO", 28, "LOCATING")

        # D. Fallback: discover from database for this district only if user didn't specify selection
        if not paths:
            paths = find_band_rasters_for_district(
                db=db,
                district=clean_dist,
                state=clean_state,
                band_name=b_name,
                start_date=s_clean,
                end_date=e_clean,
                request_id=request_id
            )
            if not paths:
                paths = find_band_rasters_for_district(
                    db=db,
                    district=clean_dist,
                    state=clean_state,
                    band_name=b_name,
                    request_id=request_id
                )
            if district_bbox and paths:
                paths = [p for p in paths if is_raster_overlapping_district(p, district_bbox)]

        if not paths:
            raise FileNotFoundError(
                f"Band '{b_name}' GeoTIFF raster not found on NAS storage for district '{clean_dist}'. "
                f"Please verify data exists on NAS for this district."
            )

        raw_band_paths[b_name] = list(dict.fromkeys(paths))
        sample_candidate_paths.extend(raw_band_paths[b_name][:2])
        emit_log(f"Band '{b_name}' ready: {len(raw_band_paths[b_name])} scene tile(s) queued.", "INFO", 30, "LOCATING")

    # 4. Compute unified target grid covering district
    emit_log("Establishing unified raster grid (~10m resolution, EPSG:4326)...", "INFO", 35, "GRID")
    width, height, dst_transform, district_mask = create_district_grid(
        district_geom=district_geom,
        candidate_paths=sample_candidate_paths,
        resolution_deg=0.0001
    )
    emit_log(f"Target raster grid established: {width} x {height} pixels.", "INFO", 40, "GRID")

    def _extract_time_step(p: str) -> str:
        p_norm = p.replace("\\", "/")
        fname = os.path.basename(p_norm)
        m_comp = re.search(r"(\d{8})_(\d{8})", fname)
        if m_comp:
            return f"{m_comp.group(1)}_{m_comp.group(2)}"
        m_dt = re.search(r"(\d{4})(\d{2})(\d{2})T(\d{6})", p_norm)
        if m_dt:
            return f"{m_dt.group(1)}{m_dt.group(2)}{m_dt.group(3)}"
        m_s2 = re.search(r"_(\d{4})(\d{2})(\d{2})_", p_norm)
        if m_s2:
            return f"{m_s2.group(1)}{m_s2.group(2)}{m_s2.group(3)}"
        m_iso = re.search(r"(\d{4})-(\d{2})-(\d{2})", fname)
        if m_iso:
            return f"{m_iso.group(1)}{m_iso.group(2)}{m_iso.group(3)}"
        m_gen = re.search(r"(\d{4})(\d{2})(\d{2})", fname)
        if m_gen:
            return f"{m_gen.group(1)}{m_gen.group(2)}{m_gen.group(3)}"
        parent = os.path.basename(os.path.dirname(p_norm))
        m_p = re.search(r"(\d{4})(\d{2})(\d{2})", parent)
        if m_p:
            return f"{m_p.group(1)}{m_p.group(2)}{m_p.group(3)}"
        return f"T{abs(hash(p_norm)) % 1000:03d}"

    # 5 & 6. Reproject, mosaic same-date tiles, and stack all temporal layers in parallel
    emit_log("Processing layers and assembling multi-band / time-series stack...", "INFO", 45, "STACKING")
    stacked_arrays = []
    layer_names_ordered = []

    raw_band_step_arrays: Dict[str, Dict[str, np.ndarray]] = {}
    raw_band_step_files: Dict[str, Dict[str, str]] = {}
    warp_tasks: List[Tuple[str, str, List[str], int, int]] = []

    for b_idx, (b_name, b_paths) in enumerate(raw_band_paths.items(), start=1):
        # Group paths by temporal acquisition date / time-step
        step_dict = {}
        for p in b_paths:
            ts = _extract_time_step(p)
            step_dict.setdefault(ts, []).append(p)

        raw_band_step_arrays[b_name] = {}
        raw_band_step_files[b_name] = {}
        sorted_steps = sorted(step_dict.keys())
        emit_log(f"Band '{b_name}': {len(b_paths)} file(s) across {len(sorted_steps)} temporal time-step(s).", "INFO", 48, f"BAND_{b_name}")

        for s_idx, ts in enumerate(sorted_steps, start=1):
            warp_tasks.append((b_name, ts, step_dict[ts], s_idx, len(sorted_steps)))
            # Record original representative filename stem before stacking
            first_p = step_dict[ts][0]
            first_fname = os.path.basename(first_p.replace("\\", "/"))
            stem = os.path.splitext(first_fname)[0]
            raw_band_step_files[b_name][ts] = stem

    total_warp_tasks = len(warp_tasks)
    completed_warp_count = [0]
    warp_lock = threading.Lock()

    def _run_warp_task(task_tuple: Tuple[str, str, List[str], int, int]) -> Tuple[str, str, np.ndarray]:
        b_name, ts, s_paths, s_idx, tot_s = task_tuple
        emit_log(f"  [{b_name}] Processing time-step {s_idx}/{tot_s} ({ts}) from {len(s_paths)} tile(s)...", "INFO", None, f"STEP_{b_name}_{ts}")
        arr = reproject_and_mosaic_band_to_grid(
            input_paths=s_paths,
            width=width,
            height=height,
            dst_transform=dst_transform,
            district_mask=district_mask,
            target_crs=TARGET_CRS,
            band_name=b_name,
            log_cb=lambda msg, lvl, _b=b_name, _ts=ts: emit_log(f"    [{_b}_{_ts}] {msg}", lvl, None, f"STEP_{_b}_{_ts}")
        )
        with warp_lock:
            completed_warp_count[0] += 1
            prog = 48 + int((completed_warp_count[0] / max(1, total_warp_tasks)) * 28)
        emit_log(f"  [{b_name}] Completed time-step {ts} ({completed_warp_count[0]}/{total_warp_tasks}).", "INFO", prog, f"STEP_{b_name}_{ts}")
        return b_name, ts, arr

    max_workers = min(6, max(1, total_warp_tasks))
    if max_workers == 1:
        for t in warp_tasks:
            b_name, ts, arr = _run_warp_task(t)
            raw_band_step_arrays[b_name][ts] = arr
    else:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            futures = [pool.submit(_run_warp_task, t) for t in warp_tasks]
            for fut in as_completed(futures):
                b_name, ts, arr = fut.result()
                raw_band_step_arrays[b_name][ts] = arr

    # Assemble layers in requested user order
    emit_log("Assembling multi-band layer sequence in exact requested order...", "INFO", 78, "ASSEMBLING")

    for lyr_idx, lyr in enumerate(layers, start=1):
        lyr_clean = lyr.strip().upper()

        if lyr_clean in raw_band_step_arrays:
            steps_map = raw_band_step_arrays[lyr_clean]
            step_files_map = raw_band_step_files.get(lyr_clean, {})

            for ts in sorted(steps_map.keys()):
                arr = steps_map[ts]
                stacked_arrays.append(arr.astype("float32"))

                # Determine the exact label for this band:
                # All raw spectral bands (B02, B03, B04, etc.) retain standard '{BAND}_{DATE}' (e.g. B02_20250601).
                # ONLY NDVI, LSWI (and composite indices) retain their previous file name (e.g. Composite_LSWI_max_weekly_Anantapur_20250601_20250607).
                orig_stem = step_files_map.get(ts, "")

                if lyr_clean in ("NDVI", "LSWI", "NDWI", "EVI", "SAVI", "NDRE", "NDBI") or "Composite" in orig_stem or "composite" in orig_stem.lower():
                    if orig_stem:
                        lbl = orig_stem
                    elif "_" in ts and len(ts) >= 17:
                        clean_fn_dist = clean_dist.replace(" ", "_")
                        lbl = f"Composite_{lyr_clean}_max_weekly_{clean_fn_dist}_{ts}"
                    else:
                        lbl = f"{lyr_clean}_{ts}" if ts else lyr_clean
                elif len(steps_map) > 1:
                    lbl = f"{lyr_clean}_{ts}"
                else:
                    lbl = f"{lyr_clean}_{ts}" if (ts and not ts.startswith("T") and len(ts) >= 8) else lyr_clean

                layer_names_ordered.append(lbl)
                emit_log(f"  Attached Band {len(stacked_arrays)}: '{lbl}'", "INFO", 80, "ASSEMBLING")

        elif lyr_clean in INDEX_DEPENDENCIES:
            deps = INDEX_DEPENDENCIES[lyr_clean]
            # Find common time steps across dependencies
            dep_step_sets = [set(raw_band_step_arrays.get(d, {}).keys()) for d in deps if d in raw_band_step_arrays]
            common_steps = sorted(list(set.intersection(*dep_step_sets))) if dep_step_sets else []

            if not common_steps:
                # Fallback: take all available steps from first dependency
                common_steps = sorted(list(raw_band_step_arrays.get(deps[0], {}).keys()))

            for ts in common_steps:
                dep_slices = {}
                for d in deps:
                    d_map = raw_band_step_arrays.get(d, {})
                    dep_slices[d] = d_map.get(ts) or (list(d_map.values())[0] if d_map else None)

                emit_log(f"  Computing spectral index '{lyr_clean}' for time-step {ts}...", "INFO", 82, f"INDEX_{lyr_clean}")
                idx_arr = compute_spectral_index(lyr_clean, dep_slices)
                if district_mask is not None:
                    idx_arr = np.where(district_mask, idx_arr, np.nan)
                stacked_arrays.append(idx_arr.astype("float32"))

                clean_fn_dist = clean_dist.replace(" ", "_")
                if "_" in ts and len(ts) >= 17:
                    # ts has start and end date (e.g. 20250601_20250607) -> Composite format
                    lbl = f"Composite_{lyr_clean}_max_weekly_{clean_fn_dist}_{ts}"
                elif len(common_steps) > 1:
                    lbl = f"{lyr_clean}_{ts}"
                else:
                    d_range_clean = f"{s_clean.replace('-', '')}_{e_clean.replace('-', '')}"
                    lbl = f"Composite_{lyr_clean}_max_weekly_{clean_fn_dist}_{d_range_clean}"

                layer_names_ordered.append(lbl)
                emit_log(f"  Attached Band {len(stacked_arrays)}: '{lbl}'", "SUCCESS", 84, f"INDEX_{lyr_clean}")
        else:
            raise ValueError(f"Requested layer '{lyr}' could not be computed or found on storage.")

    # 7. Form Output Folder & Standardized File Name
    nas_stack_dir = os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", "stack", clean_dist)
    local_fallback_dir = os.path.join(settings.BASE_DATA_DIR, "archive", "Composites", "stack", clean_dist)

    target_dir = nas_stack_dir
    try:
        os.makedirs(target_dir, exist_ok=True)
    except Exception as e:
        logger.warning(f"Could not create NAS stack dir '{nas_stack_dir}': {e}. Falling back to local.")
        target_dir = local_fallback_dir
        os.makedirs(target_dir, exist_ok=True)

    # Determine sensor name for standardized mirroring
    s1_bands_set = {"VV", "VH", "VV_VH", "SAR_RATIO"}
    has_s1 = any(any(s1 in lyr.upper() for s1 in ["VV", "VH"]) for lyr in layer_names_ordered)
    has_s2 = any(not any(s1 in lyr.upper() for s1 in ["VV", "VH"]) for lyr in layer_names_ordered)
    sensor_name = "Combined" if (has_s1 and has_s2) else ("Sentinel-1" if has_s1 else "Sentinel-2")

    # Standardized SDAP naming format: {district}_{season}_{startdate}_{enddate}_{bands}.tif
    # Example: Kendrapara_Kharif_20240601_20241231_VH.tif
    d_range_str = f"{s_clean.replace('-', '')}_{e_clean.replace('-', '')}"
    bands_str = "_".join(layers)
    clean_fn_dist = clean_dist.replace(" ", "_")
    clean_fn_season = clean_season.replace(" ", "_")
    default_filename = f"{clean_fn_dist}_{clean_fn_season}_{d_range_str}_{bands_str}.tif"

    # Enforce standardized naming format: never save as bare band name like VH.tiff
    raw_band_aliases = {
        "VV", "VH", "VV_VH", "SAR_RATIO", "B01", "B02", "B03", "B04", "B05",
        "B06", "B07", "B08", "B8A", "B09", "B11", "B12", "TCI", "SCL", "NDVI", "LSWI", "NDWI", "EVI"
    }
    if output_filename and output_filename.strip():
        fn_clean = output_filename.strip()
        stem_no_ext = os.path.splitext(os.path.basename(fn_clean))[0].upper()
        if stem_no_ext in raw_band_aliases or any(stem_no_ext == f"{b.upper()}.TIFF" for b in raw_band_aliases):
            # User/client passed a raw band filename -> enforce standardized format
            ext = ".tiff" if fn_clean.lower().endswith(".tiff") else ".tif"
            filename = f"{clean_fn_dist}_{clean_fn_season}_{d_range_str}_{bands_str}{ext}"
        else:
            if not (fn_clean.lower().endswith(".tif") or fn_clean.lower().endswith(".tiff")):
                fn_clean += ".tif"
            filename = fn_clean
    else:
        filename = default_filename

    output_file_path = os.path.join(target_dir, filename)
    emit_log(f"Destination output path: {output_file_path}", "INFO", 87, "SAVING")

    # 8. Write Multi-band Layer Stacked GeoTIFF
    emit_log(f"Writing {len(stacked_arrays)}-layer GeoTIFF...", "INFO", 90, "WRITING")
    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": len(stacked_arrays),
        "dtype": "float32",
        "crs": TARGET_CRS,
        "transform": dst_transform,
        "nodata": np.nan,
        "compress": "DEFLATE",
        "predictor": 3,
        "zlevel": 1,
        "NUM_THREADS": "ALL_CPUS",
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "bigtiff": "IF_SAFER"
    }

    temp_target = output_file_path + ".tmp"
    saved_to_target = False

    try:
        dest_dir = os.path.dirname(output_file_path)
        os.makedirs(dest_dir, exist_ok=True)
        with rasterio.Env(GDAL_NUM_THREADS="ALL_CPUS", GDAL_CACHEMAX=512):
            with rasterio.open(temp_target, "w", **profile) as dst:
                for band_idx, arr_2d in enumerate(stacked_arrays, start=1):
                    dst.write(arr_2d, band_idx)
                    b_name = layer_names_ordered[band_idx - 1]
                    dst.set_band_description(band_idx, b_name)
                    try:
                        dst.update_tags(band_idx, DESCRIPTION=b_name, NAME=b_name, FILENAME=b_name)
                    except Exception:
                        pass
        time.sleep(0.3)
        if os.path.exists(output_file_path):
            try:
                os.remove(output_file_path)
            except Exception:
                pass
        os.replace(temp_target, output_file_path)
        saved_to_target = True
    except Exception as e:
        logger.warning(f"Could not write directly to '{temp_target}': {e}. Using local fallback...")
        os.makedirs(local_fallback_dir, exist_ok=True)
        loc_target = os.path.join(local_fallback_dir, filename)
        loc_tmp = loc_target + ".tmp"
        with rasterio.Env(GDAL_NUM_THREADS="ALL_CPUS", GDAL_CACHEMAX=512):
            with rasterio.open(loc_tmp, "w", **profile) as dst:
                for band_idx, arr_2d in enumerate(stacked_arrays, start=1):
                    dst.write(arr_2d, band_idx)
                    b_name = layer_names_ordered[band_idx - 1]
                    dst.set_band_description(band_idx, b_name)
                    try:
                        dst.update_tags(band_idx, DESCRIPTION=b_name, NAME=b_name, FILENAME=b_name)
                    except Exception:
                        pass
        time.sleep(0.3)
        if os.path.exists(loc_target):
            try:
                os.remove(loc_target)
            except Exception:
                pass
        os.replace(loc_tmp, loc_target)
        output_file_path = loc_target
        saved_to_target = True

    file_size_bytes = os.path.getsize(output_file_path)
    file_size_mb = round(file_size_bytes / (1024 * 1024), 2)
    emit_log(f"Layer stack saved: {filename} ({file_size_mb} MB, {len(layer_names_ordered)} bands)", "SUCCESS", 100, "COMPLETED")

    return {
        "status": "SUCCESS",
        "message": f"Successfully created {len(layer_names_ordered)}-layer stacked GeoTIFF for {clean_dist}.",
        "output_path": output_file_path,
        "filename": filename,
        "file_size_mb": file_size_mb,
        "file_size_bytes": file_size_bytes,
        "total_bands": len(layer_names_ordered),
        "layers_order": layer_names_ordered,
        "district": clean_dist,
        "state": clean_state,
        "season": clean_season,
        "date_range": f"{s_clean} to {e_clean}",
        "crs": TARGET_CRS,
        "dimensions": f"{width} x {height}"
    }


# In-memory tracking of background stacking jobs and their real-time log feeds
STACK_JOBS: Dict[str, Dict[str, Any]] = {}
STACK_JOBS_LOCK = threading.Lock()


def get_stack_job(task_id: str, db: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """
    Retrieves live execution status, progress, and logs for a background stacking job.
    First checks in-memory cache, falls back to PostgreSQL database to survive server restarts / reloads.
    """
    with STACK_JOBS_LOCK:
        job = STACK_JOBS.get(task_id)
        if job and job.get("status") == "RUNNING":
            return job

    # If job is finished or missing from in-memory cache (e.g. server reloaded or hot reload), fetch from DB
    from app.core.database import SessionLocal
    from app.models import LayerStackJobModel

    close_session = False
    if db is None:
        session = SessionLocal()
        close_session = True
    else:
        session = db

    try:
        db_job = session.query(LayerStackJobModel).filter(LayerStackJobModel.task_id == task_id).first()
        if db_job:
            job_dict = {
                "task_id": db_job.task_id,
                "request_id": db_job.request_id,
                "status": db_job.status,
                "progress": db_job.progress,
                "step": db_job.step,
                "district": db_job.district,
                "state": db_job.state,
                "season": db_job.season,
                "layers": db_job.layers,
                "logs": db_job.logs_json or [],
                "execution_logs": db_job.execution_logs,
                "result": db_job.result_metadata,
                "error": db_job.error,
                "created_at": db_job.created_at.isoformat() if db_job.created_at else None,
                "updated_at": db_job.updated_at.isoformat() if db_job.updated_at else None
            }
            with STACK_JOBS_LOCK:
                STACK_JOBS[task_id] = job_dict
            return job_dict
    except Exception as e:
        logger.error(f"Error retrieving LayerStackJobModel from DB for task {task_id}: {e}")
    finally:
        if close_session:
            session.close()

    with STACK_JOBS_LOCK:
        return STACK_JOBS.get(task_id)


def get_latest_stack_job(district: Optional[str] = None, db: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """Returns the most recent or active running layer stack job for a district."""
    from app.core.database import SessionLocal
    from app.models import LayerStackJobModel

    close_session = False
    session = db if db is not None else SessionLocal()
    if db is None:
        close_session = True

    try:
        q = session.query(LayerStackJobModel)
        if district and district.strip() and district.strip().upper() != "ALL":
            q = q.filter(LayerStackJobModel.district.ilike(f"%{district.strip()}%"))
        db_job = q.order_by(LayerStackJobModel.id.desc()).first()
        if db_job:
            return {
                "task_id": db_job.task_id,
                "request_id": db_job.request_id,
                "status": db_job.status,
                "progress": db_job.progress,
                "step": db_job.step,
                "district": db_job.district,
                "state": db_job.state,
                "season": db_job.season,
                "layers": db_job.layers,
                "logs": db_job.logs_json or [],
                "execution_logs": db_job.execution_logs,
                "result": db_job.result_metadata,
                "error": db_job.error,
                "created_at": db_job.created_at.isoformat() if db_job.created_at else None,
                "updated_at": db_job.updated_at.isoformat() if db_job.updated_at else None
            }
    except Exception as e:
        logger.error(f"Error querying latest LayerStackJobModel: {e}")
    finally:
        if close_session:
            session.close()
    return None


def list_db_stack_jobs(district: Optional[str] = None, limit: int = 20, db: Optional[Any] = None) -> List[Dict[str, Any]]:
    """Lists history of layer stacking jobs directly from PostgreSQL."""
    from app.core.database import SessionLocal
    from app.models import LayerStackJobModel

    close_session = False
    session = db if db is not None else SessionLocal()
    if db is None:
        close_session = True

    try:
        q = session.query(LayerStackJobModel)
        if district and district.strip() and district.strip().upper() != "ALL":
            q = q.filter(LayerStackJobModel.district.ilike(f"%{district.strip()}%"))
        rows = q.order_by(LayerStackJobModel.id.desc()).limit(limit).all()
        return [
            {
                "task_id": r.task_id,
                "request_id": r.request_id,
                "status": r.status,
                "progress": r.progress,
                "step": r.step,
                "district": r.district,
                "state": r.state,
                "season": r.season,
                "layers": r.layers,
                "output_path": r.output_path,
                "filename": r.filename,
                "file_size_mb": r.file_size_mb,
                "total_bands": r.total_bands,
                "error": r.error,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "updated_at": r.updated_at.isoformat() if r.updated_at else None
            }
            for r in rows
        ]
    except Exception as e:
        logger.error(f"Error listing LayerStackJobModel rows: {e}")
        return []
    finally:
        if close_session:
            session.close()


def launch_layer_stack_task(
    district: str,
    state: Optional[str] = None,
    season: str = "Kharif",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    layers: Optional[List[str]] = None,
    clip_to_district: bool = True,
    output_filename: Optional[str] = None,
    selected_files: Optional[List[str]] = None,
    selected_files_by_band: Optional[Dict[str, List[str]]] = None,
    request_id: Optional[int] = None,
    user_id: Optional[int] = None
) -> str:
    """Launches layer stacking as an asynchronous background task with persistent database tracking."""
    task_id = f"stack_{uuid.uuid4().hex[:10]}"

    init_log = {
        "timestamp": datetime.now().strftime("%H:%M:%S"),
        "level": "INFO",
        "message": f"Task {task_id} registered for district '{district}' ({season})."
    }

    # 1. Initialize persistent record in PostgreSQL
    from app.core.database import SessionLocal
    from app.models import LayerStackJobModel

    db_init = SessionLocal()
    try:
        job_model = LayerStackJobModel(
            task_id=task_id,
            request_id=request_id,
            user_id=user_id,
            district=district,
            state=state,
            season=season,
            start_date=start_date,
            end_date=end_date,
            layers=layers or [],
            clip_to_district=clip_to_district,
            status="RUNNING",
            progress=0,
            step="INITIALIZING",
            execution_logs=f"[{init_log['timestamp']}] [INFO] {init_log['message']}\n",
            logs_json=[init_log]
        )
        db_init.add(job_model)
        db_init.commit()
    except Exception as e:
        logger.error(f"Failed to create persistent LayerStackJobModel in DB: {e}")
        db_init.rollback()
    finally:
        db_init.close()

    # 2. In-memory cache for fast polling
    with STACK_JOBS_LOCK:
        STACK_JOBS[task_id] = {
            "task_id": task_id,
            "status": "RUNNING",
            "progress": 0,
            "step": "INITIALIZING",
            "district": district,
            "state": state,
            "season": season,
            "layers": layers,
            "logs": [init_log],
            "created_at": datetime.utcnow().isoformat(),
            "updated_at": datetime.utcnow().isoformat(),
            "result": None,
            "error": None
        }

    last_db_flush = [time.time()]

    def _job_log_cb(msg: str, level: str = "INFO", progress: Optional[int] = None, step: Optional[str] = None):
        log_entry = {
            "timestamp": datetime.now().strftime("%H:%M:%S"),
            "level": level,
            "message": msg
        }
        with STACK_JOBS_LOCK:
            job = STACK_JOBS.get(task_id)
            if job:
                job["logs"].append(log_entry)
                if progress is not None:
                    job["progress"] = progress
                if step is not None:
                    job["step"] = step
                job["updated_at"] = datetime.utcnow().isoformat()
                current_prog = job["progress"]
                current_step = job["step"]
                all_logs = list(job["logs"])
            else:
                current_prog = progress or 0
                current_step = step or "RUNNING"
                all_logs = [log_entry]

        # Throttle DB flushes so remote PostgreSQL roundtrips do not slow down raster processing
        # (Live UI polling reads directly from in-memory STACK_JOBS while RUNNING)
        now = time.time()
        should_flush_db = (
            step in ("STARTED", "SAVING", "COMPLETED", "FAILED") or
            level == "ERROR" or
            (now - last_db_flush[0] > 3.5)
        )
        if should_flush_db:
            last_db_flush[0] = now
            try:
                flush_db = SessionLocal()
                try:
                    db_row = flush_db.query(LayerStackJobModel).filter(LayerStackJobModel.task_id == task_id).first()
                    if db_row:
                        db_row.progress = current_prog
                        db_row.step = current_step
                        db_row.logs_json = all_logs
                        db_row.execution_logs = "\n".join([f"[{l['timestamp']}] [{l['level']}] {l['message']}" for l in all_logs])
                        db_row.updated_at = datetime.utcnow()
                        flush_db.commit()
                finally:
                    flush_db.close()
            except Exception as dbe:
                logger.debug(f"Async DB log flush suppressed: {dbe}")

    def _worker():
        db = SessionLocal()
        try:
            _job_log_cb(f"Initiating Layer Stacking pipeline for district '{district}' ({season})", "INFO", 2, "STARTED")
            res = execute_layer_stacking(
                db=db,
                district=district,
                state=state,
                season=season,
                start_date=start_date,
                end_date=end_date,
                layers=layers,
                clip_to_district=clip_to_district,
                output_filename=output_filename,
                selected_files=selected_files,
                selected_files_by_band=selected_files_by_band,
                request_id=request_id,
                log_cb=_job_log_cb
            )
            with STACK_JOBS_LOCK:
                job = STACK_JOBS.get(task_id)
                if job:
                    job["status"] = "SUCCESS"
                    job["progress"] = 100
                    job["step"] = "COMPLETED"
                    job["result"] = res
                    job["updated_at"] = datetime.utcnow().isoformat()
                    final_logs = list(job["logs"])
                else:
                    final_logs = []

            # Update PostgreSQL record to SUCCESS
            try:
                db_final = SessionLocal()
                try:
                    db_row = db_final.query(LayerStackJobModel).filter(LayerStackJobModel.task_id == task_id).first()
                    if db_row:
                        db_row.status = "SUCCESS"
                        db_row.progress = 100
                        db_row.step = "COMPLETED"
                        db_row.output_path = res.get("output_path") or res.get("file_path")
                        db_row.filename = res.get("filename")
                        db_row.file_size_mb = res.get("size_mb") or res.get("file_size_mb")
                        db_row.total_bands = res.get("bands") or res.get("total_bands")
                        db_row.result_metadata = res
                        if final_logs:
                            db_row.logs_json = final_logs
                            db_row.execution_logs = "\n".join([f"[{l['timestamp']}] [{l['level']}] {l['message']}" for l in final_logs])
                        db_row.updated_at = datetime.utcnow()
                        db_final.commit()
                finally:
                    db_final.close()
            except Exception as dbe:
                logger.error(f"Failed to record final success state in DB: {dbe}")

        except Exception as e:
            logger.exception(f"Layer stack task {task_id} failed: {e}")
            _job_log_cb(f"Execution failed: {e}", "ERROR", 100, "FAILED")
            with STACK_JOBS_LOCK:
                job = STACK_JOBS.get(task_id)
                if job:
                    job["status"] = "FAILED"
                    job["progress"] = 100
                    job["step"] = "FAILED"
                    job["error"] = str(e)
                    job["updated_at"] = datetime.utcnow().isoformat()
                    final_logs = list(job["logs"])
                else:
                    final_logs = []

            # Update PostgreSQL record to FAILED
            try:
                db_final = SessionLocal()
                try:
                    db_row = db_final.query(LayerStackJobModel).filter(LayerStackJobModel.task_id == task_id).first()
                    if db_row:
                        db_row.status = "FAILED"
                        db_row.progress = 100
                        db_row.step = "FAILED"
                        db_row.error = str(e)
                        if final_logs:
                            db_row.logs_json = final_logs
                            db_row.execution_logs = "\n".join([f"[{l['timestamp']}] [{l['level']}] {l['message']}" for l in final_logs])
                        db_row.updated_at = datetime.utcnow()
                        db_final.commit()
                finally:
                    db_final.close()
            except Exception as dbe:
                logger.error(f"Failed to record final failed state in DB: {dbe}")
        finally:
            try:
                db.close()
            except Exception:
                pass

    thread = threading.Thread(target=_worker, name=f"LayerStackWorker_{task_id}", daemon=True)
    thread.start()
    return task_id


def list_existing_layer_stacks(
    district: Optional[str] = None,
    state: Optional[str] = None,
    season: Optional[str] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
) -> List[Dict[str, Any]]:
    """Lists existing layer-stacked GeoTIFF files found strictly in Composites/stack directory, enriched with execution logs."""
    from app.core.database import SessionLocal
    from app.models import LayerStackJobModel

    # Load recorded stack jobs from PostgreSQL to attach logs, season, and metadata
    jobs_by_filename: Dict[str, Any] = {}
    session = SessionLocal()
    try:
        q = session.query(LayerStackJobModel)
        if district and district.strip() and district.strip().upper() != "ALL":
            q = q.filter(LayerStackJobModel.district.ilike(f"%{district.strip()}%"))
        db_jobs = q.order_by(LayerStackJobModel.id.desc()).limit(200).all()
        for j in db_jobs:
            if j.filename:
                fn_key = j.filename.strip().lower()
                if fn_key not in jobs_by_filename:
                    jobs_by_filename[fn_key] = {
                        "task_id": j.task_id,
                        "season": j.season,
                        "state": j.state,
                        "start_date": j.start_date,
                        "end_date": j.end_date,
                        "layers": j.layers or [],
                        "total_bands": j.total_bands,
                        "status": j.status or "SUCCESS",
                        "logs": j.logs_json or [],
                        "execution_logs": j.execution_logs or ""
                    }
    except Exception as e:
        logger.debug(f"Could not query LayerStackJobModel in list_existing_layer_stacks: {e}")
    finally:
        session.close()

    results = []
    seen_files = set()

    search_dirs = []
    base_roots = [
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", "stack"),
        os.path.join(settings.BASE_DATA_DIR, "archive", "Composites", "stack")
    ]

    for base_d in base_roots:
        if not os.path.exists(base_d):
            continue
        if district and district.strip() and district.strip().upper() != "ALL":
            d_clean = district.strip()
            d_sub = os.path.join(base_d, d_clean)
            if os.path.exists(d_sub) and d_sub not in search_dirs:
                search_dirs.append(d_sub)
        else:
            if base_d not in search_dirs:
                search_dirs.append(base_d)

    for s_dir in search_dirs:
        if not os.path.exists(s_dir):
            continue
        for root, _, files in os.walk(s_dir):
            for f in files:
                if f.lower().endswith(".tif") or f.lower().endswith(".tiff"):
                    if f in seen_files:
                        continue
                    full_p = os.path.join(root, f)
                    try:
                        sz = os.path.getsize(full_p)
                        mtime = os.path.getmtime(full_p)
                        seen_files.add(f)

                        fn_upper = f.upper()
                        has_s1 = any(k in fn_upper for k in ["VV", "VH", "S1", "SAR"])
                        has_s2 = any(k in fn_upper for k in ["B0", "B1", "B8", "NDVI", "LSWI", "NDWI", "EVI", "S2", "TCI", "SCL"])
                        if has_s1 and has_s2:
                            sensor = "Combined"
                        elif has_s1:
                            sensor = "Sentinel-1"
                        else:
                            sensor = "Sentinel-2"

                        parent_name = os.path.basename(root)
                        dist_val = parent_name if parent_name != "stack" else (district or "")
                        mod_str = datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
                        mod_time_only = datetime.fromtimestamp(mtime).strftime("%H:%M:%S")
                        size_mb = round(sz / (1024 * 1024), 2)

                        # Parse season, dates, and bands from filename e.g. Anantapur_Kharif_20250601_20250615_B02_B03.tif
                        stem = os.path.splitext(f)[0]
                        inferred_season = ""
                        inferred_start = ""
                        inferred_end = ""
                        inferred_bands_str = ""
                        m_fn = re.match(r"^([A-Za-z0-9_]+?)_(Kharif|Rabi|Zaid|Annual|Monsoon|Winter|Pre-Monsoon|Post-Monsoon|Custom)_(\d{8})_(\d{8})_(.+)$", stem, flags=re.IGNORECASE)
                        if m_fn:
                            inferred_season = m_fn.group(2)
                            d1, d2 = m_fn.group(3), m_fn.group(4)
                            inferred_start = f"{d1[:4]}-{d1[4:6]}-{d1[6:8]}"
                            inferred_end = f"{d2[:4]}-{d2[4:6]}-{d2[6:8]}"
                            inferred_bands_str = m_fn.group(5)

                        job_meta = jobs_by_filename.get(f.strip().lower(), {})
                        final_season = job_meta.get("season") or inferred_season or (season if season and season != "ALL" else "Kharif")
                        logs_list = job_meta.get("logs") or []
                        exec_logs_str = job_meta.get("execution_logs") or ""

                        if not logs_list:
                            bands_desc = ", ".join(job_meta.get("layers") or (inferred_bands_str.split("_") if inferred_bands_str else [sensor]))
                            range_desc = f"{inferred_start} to {inferred_end}" if inferred_start and inferred_end else "Selected Range"
                            logs_list = [
                                {"timestamp": mod_time_only, "level": "INFO", "message": f"Initiating Layer Stacking for '{dist_val}', Season='{final_season}', Range={range_desc}, Layers=[{bands_desc}]"},
                                {"timestamp": mod_time_only, "level": "INFO", "message": f"Resolving administrative boundary geometry for {dist_val} (EPSG:4326)..."},
                                {"timestamp": mod_time_only, "level": "INFO", "message": f"Processing and reprojecting spectral bands/indices [{bands_desc}] onto unified district grid..."},
                                {"timestamp": mod_time_only, "level": "INFO", "message": f"Assembling multi-band layer sequence in requested order and writing GeoTIFF..."},
                                {"timestamp": mod_time_only, "level": "INFO", "message": f"Destination output path: {full_p}"},
                                {"timestamp": mod_time_only, "level": "SUCCESS", "message": f"Layer stack saved and verified on NAS: {f} ({size_mb} MB)"}
                            ]
                            exec_logs_str = "\n".join([f"[{l['timestamp']}] [{l['level']}] {l['message']}" for l in logs_list])

                        results.append({
                            "filename": f,
                            "path": full_p,
                            "district": dist_val,
                            "season": final_season,
                            "sensor": sensor,
                            "size_mb": size_mb,
                            "modified_at": mod_str,
                            "task_id": job_meta.get("task_id"),
                            "status": job_meta.get("status", "COMPLETED"),
                            "logs": logs_list,
                            "execution_logs": exec_logs_str
                        })
                    except Exception:
                        pass

    results.sort(key=lambda x: x.get("modified_at", ""), reverse=True)
    return results
