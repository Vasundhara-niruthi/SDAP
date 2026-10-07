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
      3. Saves output GeoTIFF in:
         {settings.RAW_ARCHIVE_DIR}/Composites/stack/{district_name}/
         Filename: {district_name}_{season_name}_{date_range}_{bands}.tif
=============================================================================
"""

import os
import re
import json
import tempfile
import shutil
import logging
from datetime import datetime
from typing import List, Dict, Any, Tuple, Optional

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
from app.services.downloader_service import resolve_tif_path

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
    # GDAL on Windows requires forward slashes for UNC paths like //172.16.16.52/...
    return path.replace("\\", "/")


def find_band_rasters_for_district(
    db: Session,
    district: str,
    state: Optional[str],
    band_name: str,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
) -> List[str]:
    """
    Finds verified GeoTIFF raster paths for a specific band associated with the district.
    """
    clean_d = district.split(",")[0].strip().lower()
    clean_b = band_name.replace(".tif", "").replace(".tiff", "").strip()

    # Query scenes linked through completed download process jobs for this district
    pj_query = db.query(ProcessJobModel.scene_id).join(
        RequestModel, ProcessJobModel.request_id == RequestModel.id
    ).filter(
        ProcessJobModel.scene_id.isnot(None),
        ProcessJobModel.stage == "DOWNLOAD",
        ProcessJobModel.status == "COMPLETED",
        func.lower(RequestModel.district) == clean_d
    )
    if state and state.strip() and state.upper() != "ALL":
        pj_query = pj_query.filter(func.lower(RequestModel.state) == state.strip().lower())

    scene_ids = [r[0] for r in pj_query.distinct().all() if r[0]]
    if not scene_ids:
        # Fallback: check district_tiles_mapping
        tiles_rows = db.execute(
            text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = :d"),
            {"d": clean_d}
        ).fetchall()
        tiles = [r[0] for r in tiles_rows if r[0]]
        if tiles:
            scene_query = db.query(SceneModel.scene_id).filter(
                SceneModel.status == "HELD",
                SceneModel.tile.in_(tiles)
            )
            if start_date:
                scene_query = scene_query.filter(SceneModel.sensing_date >= start_date)
            if end_date:
                scene_query = scene_query.filter(SceneModel.sensing_date <= end_date)
            scene_ids = [r[0] for r in scene_query.all()]

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

    # Match exact band or case-insensitive band
    bf_query = bf_query.filter(
        (func.lower(BandFileModel.band) == clean_b.lower()) |
        (func.lower(BandFileModel.band) == f"{clean_b.lower()}.tif")
    )

    records = bf_query.all()
    found_paths = []
    for r in records:
        resolved, exists = resolve_tif_path(r.path)
        if exists and os.path.exists(resolved):
            found_paths.append(_normalize_unc_path(resolved))

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
                b_minx, b_miny, b_maxx, b_maxy = transform_bounds(src.crs, TARGET_CRS, *src.bounds)
                minx, miny = min(minx, b_minx), min(miny, b_miny)
                maxx, maxy = max(maxx, b_maxx), max(maxy, b_maxy)

    width = max(1, int(np.ceil((maxx - minx) / resolution_deg)))
    height = max(1, int(np.ceil((maxy - miny) / resolution_deg)))
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
    target_crs: str = TARGET_CRS
) -> np.ndarray:
    """
    Directly reprojects and mosaics input rasters for a band onto the unified district grid.
    Applies district boundary mask and returns (height, width) float32 array.
    """
    accumulated = np.full((height, width), np.nan, dtype="float32")
    g_minx, g_miny, g_maxx, g_maxy = rasterio.transform.array_bounds(height, width, dst_transform)

    for p in input_paths:
        norm_p = _normalize_unc_path(p)
        try:
            with rasterio.open(norm_p) as src:
                # Check spatial bounds overlap
                t_minx, t_miny, t_maxx, t_maxy = transform_bounds(src.crs, target_crs, *src.bounds)
                if t_maxx < g_minx or t_minx > g_maxx or t_maxy < g_miny or t_miny > g_maxy:
                    continue

                dest_tile = np.full((height, width), np.nan, dtype="float32")
                reproject(
                    source=rasterio.band(src, 1),
                    destination=dest_tile,
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=dst_transform,
                    dst_crs=target_crs,
                    resampling=Resampling.bilinear,
                    num_threads=4
                )
                accumulated = np.where(np.isnan(accumulated), dest_tile, np.fmax(accumulated, dest_tile))
                logger.info(f"   Tile {os.path.basename(p)} reprojected successfully.")
        except Exception as e:
            logger.warning(f"Error reprojecting tile {p}: {e}")

    if district_mask is not None:
        accumulated[~district_mask] = np.nan

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
    selected_files: Optional[List[str]] = None
) -> Dict[str, Any]:
    """
    Executes ordered layer stacking of selected bands and indices for a district.
    
    Steps:
      1. Validates inputs & layer order.
      2. Discovers underlying band files on NAS storage.
      3. Computes district geometry grid and directly reprojects bands.
      4. Stacks layers in user's exact selection sequence into a multi-band GeoTIFF.
      5. Saves to {RAW_ARCHIVE_DIR}/Composites/stack/{district}/
         as {district}_{season}_{start_date}-{end_date}_{bands}.tif
    """
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

    logger.info(f"Initiating Layer Stacking for '{clean_dist}', Season='{clean_season}', Range={s_clean} to {e_clean}, Layers={layers}")

    # 1. Fetch District Polygon Boundary Geometry if available
    district_geom = None
    if clip_to_district:
        geom_dict, _ = get_district_geometry_from_db(db, clean_dist)
        if geom_dict:
            district_geom = geom_dict if not isinstance(geom_dict, str) else json.loads(geom_dict)

    # 2. Determine all required raw bands (including those needed to calculate indices)
    needed_raw_bands = set()
    for lyr in layers:
        lyr_upper = lyr.upper().strip()
        direct_paths = find_band_rasters_for_district(
            db=db, district=clean_dist, state=clean_state, band_name=lyr_upper,
            start_date=s_clean, end_date=e_clean
        ) or find_band_rasters_for_district(
            db=db, district=clean_dist, state=clean_state, band_name=lyr_upper
        )
        if direct_paths:
            needed_raw_bands.add(lyr_upper)
        elif lyr_upper in INDEX_DEPENDENCIES:
            needed_raw_bands.update(INDEX_DEPENDENCIES[lyr_upper])
        else:
            needed_raw_bands.add(lyr_upper)

    # 3. Locate files for each needed raw band
    raw_band_paths = {}
    sample_candidate_paths = []
    filter_norm_paths = set(_normalize_unc_path(p) for p in selected_files) if selected_files else set()

    for b_name in needed_raw_bands:
        # Check if selected_files provides direct paths for this band
        direct_selected = [
            p for p in filter_norm_paths
            if os.path.basename(p).upper().startswith(b_name)
            or f"/{b_name.lower()}." in p.lower()
            or f"/{b_name.lower()}/" in p.lower()
        ]
        if direct_selected:
            paths = direct_selected
        else:
            paths = find_band_rasters_for_district(
                db=db,
                district=clean_dist,
                state=clean_state,
                band_name=b_name,
                start_date=s_clean,
                end_date=e_clean
            )
            if not paths:
                # Try without strict date bounds for held rasters
                paths = find_band_rasters_for_district(
                    db=db,
                    district=clean_dist,
                    state=clean_state,
                    band_name=b_name
                )
            if filter_norm_paths:
                subset = [p for p in paths if _normalize_unc_path(p) in filter_norm_paths]
                if subset:
                    paths = subset

        if not paths:
            raise FileNotFoundError(
                f"Band '{b_name}' GeoTIFF raster not found on NAS storage for district '{clean_dist}'. "
                f"Please verify data exists on NAS for this district."
            )

        raw_band_paths[b_name] = paths
        sample_candidate_paths.extend(paths[:2])

    # 4. Compute target grid covering district
    width, height, dst_transform, district_mask = create_district_grid(
        district_geom=district_geom,
        candidate_paths=sample_candidate_paths,
        resolution_deg=0.0001
    )

    logger.info(f"Target raster grid established: {width} x {height} pixels (resolution ~10m)")

    # 5. Reproject and mosaic each raw band onto the grid
    raw_band_arrays = {}
    for b_name, paths in raw_band_paths.items():
        logger.info(f"Processing band {b_name} across {len(paths)} tile(s)...")
        b_arr = reproject_and_mosaic_band_to_grid(
            input_paths=paths,
            width=width,
            height=height,
            dst_transform=dst_transform,
            district_mask=district_mask,
            target_crs=TARGET_CRS
        )
        raw_band_arrays[b_name] = b_arr

    # 6. Construct stacked layers in EXACT user-selected order
    stacked_arrays = []
    layer_names_ordered = []

    for lyr in layers:
        lyr_clean = lyr.strip().upper()
        if lyr_clean in raw_band_arrays:
            # Direct raster (e.g. B02, B03, B04, B08, B8A, B11, SCL or pre-computed LSWI / NDVI)
            stacked_arrays.append(raw_band_arrays[lyr_clean].astype("float32"))
            layer_names_ordered.append(lyr_clean)
        elif lyr_clean in INDEX_DEPENDENCIES:
            logger.info(f"Computing index '{lyr_clean}' on-the-fly...")
            idx_arr = compute_spectral_index(lyr_clean, raw_band_arrays)
            stacked_arrays.append(idx_arr.astype("float32"))
            layer_names_ordered.append(lyr_clean)
        else:
            raise ValueError(f"Requested layer '{lyr}' could not be computed or found on storage.")

    # 7. Form Output Folder & File Name
    # User specified requirement:
    # "create a folder in composite folder name as stack inside the stack folder create another folder with district name
    # inside the save the tiff with districtname_season name_datr range_bands which are used.tiff"
    nas_stack_dir = os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", "stack", clean_dist)
    local_fallback_dir = os.path.join(settings.BASE_DATA_DIR, "archive", "Composites", "stack", clean_dist)
    
    # Ensure directories exist
    target_dir = nas_stack_dir
    try:
        os.makedirs(target_dir, exist_ok=True)
    except Exception as e:
        logger.warning(f"Could not create NAS stack dir '{nas_stack_dir}': {e}. Falling back to local.")
        target_dir = local_fallback_dir
        os.makedirs(target_dir, exist_ok=True)

    # File name formatting: preserve original filename if requested or if single band/index is stacked
    if output_filename and output_filename.strip():
        fn_clean = output_filename.strip()
        if not (fn_clean.lower().endswith(".tif") or fn_clean.lower().endswith(".tiff")):
            fn_clean += ".tif"
        filename = fn_clean
    elif len(layer_names_ordered) == 1:
        # User specified requirement:
        # "ex. if user select the NDVI which are already downloaded NDVI are stcaking right. while stacking don't change it's file name which are before keep filename same."
        if selected_files and len(selected_files) > 0:
            filename = os.path.basename(selected_files[0])
        elif raw_band_paths.get(layer_names_ordered[0]):
            filename = os.path.basename(raw_band_paths[layer_names_ordered[0]][0])
        else:
            filename = f"{layer_names_ordered[0]}.tif"
    else:
        d_range_str = f"{s_clean.replace('-', '')}-{e_clean.replace('-', '')}"
        bands_str = "_".join(layer_names_ordered)
        clean_fn_dist = clean_dist.replace(" ", "_")
        clean_fn_season = clean_season.replace(" ", "_")
        filename = f"{clean_fn_dist}_{clean_fn_season}_{d_range_str}_{bands_str}.tif"

    output_file_path = os.path.join(target_dir, filename)

    # 8. Write Multi-band Layer Stacked GeoTIFF
    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": len(stacked_arrays),
        "dtype": "float32",
        "crs": TARGET_CRS,
        "transform": dst_transform,
        "nodata": np.nan,
        "compress": "lzw",
        "predictor": 3,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512
    }

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_out = os.path.join(tmp_dir, filename)
        with rasterio.open(temp_out, "w", **profile) as dst:
            for band_idx, arr_2d in enumerate(stacked_arrays, start=1):
                dst.write(arr_2d, band_idx)
                dst.set_band_description(band_idx, layer_names_ordered[band_idx - 1])

        # Copy to target directory (NAS or local)
        shutil.copy2(temp_out, output_file_path)

        # If NAS was used, also copy to local fallback directory for resilient web download
        if target_dir == nas_stack_dir:
            try:
                os.makedirs(local_fallback_dir, exist_ok=True)
                shutil.copy2(temp_out, os.path.join(local_fallback_dir, filename))
            except Exception as e:
                logger.warning(f"Could not replicate stack to local fallback: {e}")

    file_size_bytes = os.path.getsize(output_file_path)
    file_size_mb = round(file_size_bytes / (1024 * 1024), 2)

    logger.info(f"Layer stack created successfully: {output_file_path} ({file_size_mb} MB, {len(layer_names_ordered)} bands)")

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


def list_existing_layer_stacks(district: Optional[str] = None) -> List[Dict[str, Any]]:
    """Lists existing layer-stacked GeoTIFF files found in the stack folder."""
    results = []
    seen_files = set()

    search_dirs = []
    if district and district.strip():
        search_dirs.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", "stack", district.strip()))
        search_dirs.append(os.path.join(settings.BASE_DATA_DIR, "archive", "Composites", "stack", district.strip()))
    else:
        search_dirs.append(os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", "stack"))
        search_dirs.append(os.path.join(settings.BASE_DATA_DIR, "archive", "Composites", "stack"))

    for base_d in search_dirs:
        if not os.path.exists(base_d):
            continue
        for root, _, files in os.walk(base_d):
            for f in files:
                if f.lower().endswith(".tif") or f.lower().endswith(".tiff"):
                    if f in seen_files:
                        continue
                    full_p = os.path.join(root, f)
                    try:
                        sz = os.path.getsize(full_p)
                        mtime = os.path.getmtime(full_p)
                        dist_folder = os.path.basename(root)
                        seen_files.add(f)
                        results.append({
                            "filename": f,
                            "path": full_p,
                            "district": dist_folder if dist_folder != "stack" else "",
                            "size_mb": round(sz / (1024 * 1024), 2),
                            "modified_at": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
                        })
                    except Exception:
                        pass

    results.sort(key=lambda x: x.get("modified_at", ""), reverse=True)
    return results
