"""
=============================================================================
SDAP Joining, Reprojection & District Delivery Clipping Service (SRS 8.4.4 & 8.5)
=============================================================================
Location: backend/app/services/delivery_service.py

Description:
    1. Reprojection: Reprojects every input tile raster to a unified projection
       (e.g., EPSG:4326 / EPSG:3857) to prevent UTM zone boundary shift artifacts.
    2. Mosaic/Join: Merges reprojected rasters into a single contiguous image.
    3. District Clipping: Clips mosaic to the district boundary polygon, setting
       pixels outside the boundary to no-data.
    4. Coverage & Stats: Calculates district average of valid pixels and records
       the cloud-free coverage percentage of the district.
=============================================================================
"""

import os
import sys
import json
import logging
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import rasterio
from rasterio.mask import mask
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.merge import merge
from shapely.geometry import shape, mapping
from sqlalchemy.orm import Session
from sqlalchemy import text

logger = logging.getLogger("sdap.delivery")

DELIVERIES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "deliveries")


def get_district_geometry_from_db(db: Session, district_name: str) -> Tuple[Optional[dict], Optional[str]]:
    """Fetches GeoJSON geometry dict and state name for a district from district_boundaries."""
    row = db.execute(
        text("SELECT geometry, state_name FROM district_boundaries WHERE LOWER(district_name) = LOWER(:d_name) LIMIT 1;"),
        {"d_name": district_name}
    ).fetchone()

    if not row:
        row = db.execute(
            text("SELECT geometry, state_name FROM district_boundaries WHERE district_name ILIKE :d_like LIMIT 1;"),
            {"d_like": f"%{district_name}%"}
        ).fetchone()

    if not row:
        return None, None

    geom_dict = row[0] if isinstance(row[0], dict) else json.loads(row[0])
    return geom_dict, row[1]


def reproject_raster_to_target_crs(input_path: str, output_path: str, target_crs: str = "EPSG:4326") -> str:
    """
    Reprojects input raster to target CRS (SRS 8.4.4 mandatory step to prevent UTM zone offset).
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with rasterio.open(input_path) as src:
        transform, width, height = calculate_default_transform(
            src.crs, target_crs, src.width, src.height, *src.bounds
        )
        kwargs = src.meta.copy()
        kwargs.update({
            'crs': target_crs,
            'transform': transform,
            'width': width,
            'height': height,
            'nodata': np.nan
        })

        with rasterio.open(output_path, 'w', **kwargs) as dst:
            for i in range(1, src.count + 1):
                reproject(
                    source=rasterio.band(src, i),
                    destination=rasterio.band(dst, i),
                    src_transform=src.transform,
                    src_crs=src.crs,
                    dst_transform=transform,
                    dst_crs=target_crs,
                    resampling=Resampling.nearest
                )

    return output_path


def produce_district_delivery_output(
    db: Session,
    request_id: int,
    district_name: str,
    index_raster_paths: List[str],
    output_filename: str,
    target_crs: str = "EPSG:4326"
) -> Dict[str, Any]:
    """
    SRS 8.4.4 & 8.5 Delivery Step:
    1. Reprojects tile rasters to single target CRS.
    2. Joins / Mosaics rasters into single image.
    3. Clips mosaic to district boundary polygon.
    4. Computes district average and cloud-free coverage statistic.
    """
    if not index_raster_paths:
        raise ValueError("No index raster paths provided for delivery clipping.")

    delivery_dir = os.path.join(DELIVERIES_DIR, f"request_{request_id}")
    os.makedirs(delivery_dir, exist_ok=True)

    # 1. Fetch District Geometry
    geom_dict, state_name = get_district_geometry_from_db(db, district_name)
    if not geom_dict:
        raise ValueError(f"District geometry for '{district_name}' not found in PostgreSQL database.")

    district_geom = shape(geom_dict)

    # 2. Reproject each tile raster to unified target CRS
    reprojected_paths = []
    for idx, r_path in enumerate(index_raster_paths):
        if not os.path.exists(r_path):
            continue
        reproj_out = os.path.join(delivery_dir, f"reprojected_{idx}.tif")
        reproject_raster_to_target_crs(r_path, reproj_out, target_crs)
        reprojected_paths.append(reproj_out)

    if not reprojected_paths:
        raise FileNotFoundError("None of the specified index rasters could be reprojected.")

    # 3. Join / Mosaic reprojected rasters
    opened_srcs = [rasterio.open(p) for p in reprojected_paths]
    mosaic_array, mosaic_transform = merge(opened_srcs, nodata=np.nan)
    
    mosaic_meta = opened_srcs[0].meta.copy()
    mosaic_meta.update({
        "height": mosaic_array.shape[1],
        "width": mosaic_array.shape[2],
        "transform": mosaic_transform,
        "crs": target_crs,
        "nodata": np.nan
    })

    # Save temporary mosaic
    temp_mosaic_path = os.path.join(delivery_dir, "temp_mosaic.tif")
    with rasterio.open(temp_mosaic_path, "w", **mosaic_meta) as dst:
        dst.write(mosaic_array)

    for src in opened_srcs:
        src.close()

    # 4. Clip Mosaic to District Polygon Boundary
    final_output_path = os.path.join(delivery_dir, output_filename)
    with rasterio.open(temp_mosaic_path) as src:
        out_image, out_transform = mask(src, [geom_dict], crop=True, nodata=np.nan)
        out_meta = src.meta.copy()

    out_meta.update({
        "height": out_image.shape[1],
        "width": out_image.shape[2],
        "transform": out_transform,
        "nodata": np.nan
    })

    # Save final clipped deliverable
    with rasterio.open(final_output_path, "w", **out_meta) as dst:
        dst.write(out_image)

    # Clean up temporary reprojected files
    if os.path.exists(temp_mosaic_path):
        os.remove(temp_mosaic_path)
    for p in reprojected_paths:
        if os.path.exists(p): os.remove(p)

    # 5. Calculate District Average & Cloud-Free Coverage
    valid_data = out_image[~np.isnan(out_image)]
    total_pixels = out_image.size
    valid_count = valid_data.size

    district_avg = float(np.mean(valid_data)) if valid_count > 0 else 0.0
    coverage_pct = float(valid_count / total_pixels * 100.0) if total_pixels > 0 else 0.0

    result = {
        "request_id": request_id,
        "district": district_name,
        "state": state_name,
        "deliverable_path": final_output_path,
        "district_average_value": round(district_avg, 4),
        "cloud_free_coverage_pct": round(coverage_pct, 2),
        "valid_pixels": valid_count,
        "total_district_pixels": total_pixels
    }

    logger.info(f"[DELIVERY COMPLETE] Request #{request_id} District '{district_name}': Average={result['district_average_value']}, Coverage={result['cloud_free_coverage_pct']}% -> '{final_output_path}'")
    return result

