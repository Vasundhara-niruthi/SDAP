"""
Reprojection, mosaicing and district clipping (SRS 8.4.4 & 8.5).

Reprojects tiles to one CRS (avoids UTM zone shifts), mosaics them, clips to the
district polygon, and computes the valid-pixel average and cloud-free coverage.
"""

import os
import json
import logging
from typing import Dict, Any, List, Tuple, Optional

import numpy as np
import rasterio
from rasterio.mask import mask
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.merge import merge
from shapely.geometry import shape
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings

logger = logging.getLogger("sdap.delivery")

DELIVERIES_DIR = settings.DELIVERY_DIR


def get_district_geometry_from_db(
    db: Session,
    district_name: str,
    state_name: Optional[str] = None
) -> Tuple[Optional[dict], Optional[str]]:
    """Fetches GeoJSON geometry dict and state name for a district from district_boundaries."""
    if not district_name:
        return None, None
    clean_d = district_name.strip()
    clean_s = state_name.strip() if state_name and state_name.strip() and state_name.strip().upper() != "ALL" else None

    row = None
    if clean_s:
        row = db.execute(
            text("""
                SELECT geometry, state_name FROM district_boundaries
                WHERE LOWER(district_name) = LOWER(:d_name) AND LOWER(state_name) = LOWER(:s_name)
                LIMIT 1;
            """),
            {"d_name": clean_d, "s_name": clean_s}
        ).fetchone()
        if not row:
            row = db.execute(
                text("""
                    SELECT geometry, state_name FROM district_boundaries
                    WHERE district_name ILIKE :d_like AND LOWER(state_name) = LOWER(:s_name)
                    LIMIT 1;
                """),
                {"d_like": f"%{clean_d}%", "s_name": clean_s}
            ).fetchone()

    if not row:
        row = db.execute(
            text("SELECT geometry, state_name FROM district_boundaries WHERE LOWER(district_name) = LOWER(:d_name) LIMIT 1;"),
            {"d_name": clean_d}
        ).fetchone()

    if not row:
        row = db.execute(
            text("SELECT geometry, state_name FROM district_boundaries WHERE district_name ILIKE :d_like LIMIT 1;"),
            {"d_like": f"%{clean_d}%"}
        ).fetchone()

    if not row:
        return None, None

    geom_dict = row[0] if isinstance(row[0], dict) else json.loads(row[0])
    return geom_dict, row[1]


def reproject_raster_to_target_crs(input_path: str, output_path: str, target_crs: str = "EPSG:4326") -> str:
    """
    Reprojects a raster to the target CRS (SRS 8.4.4; prevents UTM zone offsets).
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
    SRS 8.4.4 & 8.5 delivery: reproject, mosaic, clip to the district, and compute average and coverage.
    """
    if not index_raster_paths:
        raise ValueError("No index raster paths provided for delivery clipping.")

    delivery_dir = os.path.join(DELIVERIES_DIR, f"request_{request_id}")
    os.makedirs(delivery_dir, exist_ok=True)

    geom_dict, state_name = get_district_geometry_from_db(db, district_name)
    if not geom_dict:
        raise ValueError(f"District geometry for '{district_name}' not found in PostgreSQL database.")

    district_geom = shape(geom_dict)

    reprojected_paths = []
    temp_mosaic_path = os.path.join(delivery_dir, "temp_mosaic.tif")
    final_output_path = os.path.join(delivery_dir, output_filename)
    try:
        for idx, r_path in enumerate(index_raster_paths):
            if not os.path.exists(r_path):
                continue
            reproj_out = os.path.join(delivery_dir, f"reprojected_{idx}.tif")
            reprojected_paths.append(reproj_out)
            reproject_raster_to_target_crs(r_path, reproj_out, target_crs)

        if not reprojected_paths:
            raise FileNotFoundError("None of the specified index rasters could be reprojected.")

        opened_srcs = []
        try:
            for p in reprojected_paths:
                opened_srcs.append(rasterio.open(p))
            mosaic_array, mosaic_transform = merge(opened_srcs, bounds=district_geom.bounds, nodata=np.nan)

            mosaic_meta = opened_srcs[0].meta.copy()
            mosaic_meta.update({
                "height": mosaic_array.shape[1],
                "width": mosaic_array.shape[2],
                "transform": mosaic_transform,
                "crs": target_crs,
                "nodata": np.nan
            })

            with rasterio.open(temp_mosaic_path, "w", **mosaic_meta) as dst:
                dst.write(mosaic_array)
        finally:
            for src in opened_srcs:
                src.close()

        with rasterio.open(temp_mosaic_path) as src:
            out_image, out_transform = mask(src, [geom_dict], crop=True, nodata=np.nan)
            out_meta = src.meta.copy()

        out_meta.update({
            "height": out_image.shape[1],
            "width": out_image.shape[2],
            "transform": out_transform,
            "nodata": np.nan
        })

        with rasterio.open(final_output_path, "w", **out_meta) as dst:
            dst.write(out_image)
    finally:
        # Intermediates are removed on success and on failure
        for p in [temp_mosaic_path] + reprojected_paths:
            if os.path.exists(p):
                os.remove(p)

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

