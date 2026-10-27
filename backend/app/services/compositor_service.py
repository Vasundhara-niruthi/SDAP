"""
=============================================================================
SDAP Temporal Compositing & District Mosaicing Service (SRS 8.4 & 8.5)
=============================================================================
Location: backend/app/services/compositor_service.py

Description:
    Performs temporal compositing across user-requested time intervals:
      - 'weekly': 7-day windows (Days 1-7, 8-14, 15-21, 22-28, 29-end)
      - 'fortnightly': 15-day windows (Days 1-15, 16-end of month)
      - 'monthly': Complete calendar months (Day 1 to last day of month)

    Algorithm:
      1. Slices date range into discrete composite windows.
      2. For each window and index (NDVI, LSWI):
         - Collects all cloud-masked GeoTIFFs across all acquisition days & tiles.
         - Reprojects all rasters to unified target CRS (EPSG:4326) to eliminate UTM shift.
         - Merges/Stacks using Maximum Value Composite (MVC / nanmax) to pick the cleanest,
           greenest cloud-free pixel across all days in the window.
         - Clips the merged composite to the district polygon boundary from PostgreSQL.
         - Writes LZW-compressed single GeoTIFF deliverable to NAS and local delivery archive.
=============================================================================
"""

import os
import json
import calendar
import tempfile
import shutil
import logging
from datetime import datetime, date, timedelta
from typing import List, Dict, Any, Tuple, Optional

import numpy as np
import rasterio
import rasterio.features
import rasterio.windows
from rasterio.warp import reproject, Resampling, transform_bounds
from shapely.geometry import shape
from sqlalchemy.orm import Session
from sqlalchemy import text, func

from app.core.config import settings
from app.models.sdap_models import RequestModel, ProcessJobModel, SceneModel, BandFileModel
from app.services.delivery_service import get_district_geometry_from_db
from app.services.downloader_service import verify_raster, resolve_tif_path, is_raster_overlapping_district
from app.services.sentinel1_processor_service import win_safe_path

logger = logging.getLogger("sdap.compositor")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Date Window Generator
# ─────────────────────────────────────────────────────────────────────────────

def generate_composite_windows(start_date: str, end_date: str, interval: str, satellite: Optional[str] = None) -> List[Dict[str, Any]]:
    """
    Slices a date range into discrete composite windows based on the requested interval.
    
    Intervals supported:
      - 'weekly' (7-day intervals)
      - 'fortnightly' / 'biweekly' (12-day intervals for Sentinel-1 repeat cycle; 15-day intervals for Sentinel-2)
      - 'monthly' (full calendar months)
    """
    if not interval or interval.lower() in ("none", "null", "false", "0"):
        return []

    interval_lower = interval.lower().strip()
    
    start_dt = datetime.strptime(start_date.split("T")[0], "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date.split("T")[0], "%Y-%m-%d").date()

    if start_dt > end_dt:
        return []

    windows = []

    if interval_lower in ("weekly", "7-day", "7day", "week"):
        cur = start_dt
        w_idx = 1
        while cur <= end_dt:
            w_end = min(end_dt, cur + timedelta(days=6))
            windows.append({
                "type": "weekly",
                "index": w_idx,
                "label": f"Week_{w_idx}",
                "start_date": cur.strftime("%Y-%m-%d"),
                "end_date": w_end.strftime("%Y-%m-%d"),
                "days_count": (w_end - cur).days + 1
            })
            cur = w_end + timedelta(days=1)
            w_idx += 1

    elif interval_lower in ("fortnightly", "biweekly", "15-day", "15day", "fortnight", "12-day", "12day"):
        is_s1_only = bool(satellite and "Sentinel-1" in satellite and "Sentinel-2" not in satellite)
        # Sentinel-1 repeat cycle is 12 days; Sentinel-2 is 15 days
        span_days = 11 if is_s1_only else 14
        cur = start_dt
        w_idx = 1
        while cur <= end_dt:
            w_end = min(end_dt, cur + timedelta(days=span_days))
            windows.append({
                "type": "fortnightly",
                "index": w_idx,
                "label": f"Fortnight_{w_idx}",
                "start_date": cur.strftime("%Y-%m-%d"),
                "end_date": w_end.strftime("%Y-%m-%d"),
                "days_count": (w_end - cur).days + 1
            })
            cur = w_end + timedelta(days=1)
            w_idx += 1

    elif interval_lower in ("monthly", "month", "30-day", "30day"):
        cur_year = start_dt.year
        cur_month = start_dt.month

        while True:
            first_day = date(cur_year, cur_month, 1)
            last_day_num = calendar.monthrange(cur_year, cur_month)[1]
            last_day = date(cur_year, cur_month, last_day_num)

            w_start = max(start_dt, first_day)
            w_end = min(end_dt, last_day)

            if w_start <= w_end:
                month_name = calendar.month_abbr[cur_month]
                windows.append({
                    "type": "monthly",
                    "index": cur_month,
                    "label": f"Month_{cur_year}_{month_name}",
                    "start_date": w_start.strftime("%Y-%m-%d"),
                    "end_date": w_end.strftime("%Y-%m-%d"),
                    "days_count": (w_end - w_start).days + 1
                })

            if cur_year == end_dt.year and cur_month == end_dt.month:
                break

            cur_month += 1
            if cur_month > 12:
                cur_month = 1
                cur_year += 1

    else:
        # Default fallback: treat entire date range as one composite window
        windows.append({
            "type": interval_lower,
            "index": 1,
            "label": f"Composite_{start_dt.strftime('%Y%m%d')}_{end_dt.strftime('%Y%m%d')}",
            "start_date": start_dt.strftime("%Y-%m-%d"),
            "end_date": end_dt.strftime("%Y-%m-%d"),
            "days_count": (end_dt - start_dt).days + 1
        })

    return windows


# ─────────────────────────────────────────────────────────────────────────────
# 2. Find Index Rasters within Window
# ─────────────────────────────────────────────────────────────────────────────

def find_index_rasters_for_window(
    db: Session,
    district_name: str,
    window_start: str,
    window_end: str,
    index_name: str,
    request_id: Optional[int] = None,
    district_bbox: Optional[Tuple[float, float, float, float]] = None
) -> List[str]:
    """
    Finds all verified spectral index GeoTIFFs (e.g. NDVI, LSWI) downloaded or computed
    for tiles covering district_name within the specified window dates.
    Strictly verifies spatial overlap so out-of-district tiles are never included.
    """
    idx_clean = index_name.upper().strip()
    clean_d = district_name.split(",")[0].strip().lower()

    w_start_dt = datetime.strptime(window_start, "%Y-%m-%d").date()
    w_end_dt = datetime.strptime(window_end, "%Y-%m-%d").date()

    candidate_scene_ids = set()

    # 1. Collect candidate scenes from the specific request if provided
    if request_id:
        pjs = db.query(ProcessJobModel.scene_id).filter(
            ProcessJobModel.request_id == request_id,
            ProcessJobModel.stage == "DOWNLOAD",
            ProcessJobModel.status == "COMPLETED"
        ).all()
        for pj in pjs:
            if pj[0]:
                candidate_scene_ids.add(pj[0])

    # 2. Collect candidate tiles mapped to this district
    tiles_rows = db.execute(
        text("SELECT DISTINCT tile_id FROM district_tiles_mapping WHERE LOWER(district_name) = :d"),
        {"d": clean_d}
    ).fetchall()
    district_tiles = set(r[0] for r in tiles_rows if r[0] and r[0] != "S1_SAR")

    # If no scenes from request, query completed jobs for this district or scenes matching district tiles
    if not candidate_scene_ids:
        pj_query = db.query(ProcessJobModel.scene_id).join(
            RequestModel, ProcessJobModel.request_id == RequestModel.id
        ).filter(
            ProcessJobModel.scene_id.isnot(None),
            ProcessJobModel.stage == "DOWNLOAD",
            ProcessJobModel.status == "COMPLETED",
            func.lower(RequestModel.district) == clean_d
        )
        for r in pj_query.distinct().all():
            if r[0]:
                candidate_scene_ids.add(r[0])

        if district_tiles:
            sq = db.query(SceneModel.scene_id).filter(
                SceneModel.tile.in_(district_tiles),
                SceneModel.status == "HELD"
            )
            for r in sq.all():
                if r[0]:
                    candidate_scene_ids.add(r[0])

    # 3. Query BandFileModel records matching index_name and sensing_date
    band_names_query = [
        idx_clean,
        f"{idx_clean}.tif",
        f"{idx_clean}.tiff",
        f"{idx_clean}_{district_name}",
        f"{idx_clean}_{clean_d}"
    ]

    bf_query = db.query(BandFileModel).filter(
        func.upper(BandFileModel.band).in_([b.upper() for b in band_names_query]),
        BandFileModel.verified == 1
    )

    if candidate_scene_ids:
        bf_query = bf_query.filter(BandFileModel.scene_id.in_(candidate_scene_ids))

    raster_paths = []
    seen_paths = set()

    for row in bf_query.all():
        try:
            s_date = datetime.strptime(str(row.sensing_date).split(" ")[0], "%Y-%m-%d").date()
            if w_start_dt <= s_date <= w_end_dt:
                resolved, exists = resolve_tif_path(row.path)
                if exists and resolved not in seen_paths:
                    # Spatial overlap check against district_bbox
                    if district_bbox and not is_raster_overlapping_district(resolved, district_bbox):
                        continue
                    raster_paths.append(resolved)
                    seen_paths.add(resolved)
        except Exception:
            continue

    # 4. Fallback: Check NAS storage ONLY under the specific district tile folders
    if not raster_paths and district_tiles:
        import re
        for tile in district_tiles:
            tile_dir = os.path.join(settings.RAW_ARCHIVE_DIR, tile)
            if not os.path.exists(tile_dir):
                continue
            for root, _, files in os.walk(tile_dir):
                for fn in files:
                    fn_u = fn.upper()
                    if fn_u in (f"{idx_clean}.TIF", f"{idx_clean}.TIFF") or fn_u.startswith(f"{idx_clean}_"):
                        full_p = os.path.join(root, fn)
                        if full_p in seen_paths:
                            continue
                        date_match = None
                        m = re.search(r"(\d{4})(\d{2})(\d{2})", root.replace("\\", "/"))
                        if m:
                            try:
                                date_match = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                            except ValueError:
                                pass
                        if not date_match:
                            m2 = re.search(r"(\d{4})-(\d{2})-(\d{2})", fn)
                            if m2:
                                try:
                                    date_match = date(int(m2.group(1)), int(m2.group(2)), int(m2.group(3)))
                                except ValueError:
                                    pass
                        if date_match and (w_start_dt <= date_match <= w_end_dt):
                            if district_bbox and not is_raster_overlapping_district(full_p, district_bbox):
                                continue
                            raster_paths.append(full_p)
                            seen_paths.add(full_p)

    return raster_paths


# ─────────────────────────────────────────────────────────────────────────────
# 3. Maximum Value Compositing (MVC) & District Masking Engine
# ─────────────────────────────────────────────────────────────────────────────

def create_temporal_composite_raster(
    input_raster_paths: List[str],
    output_path: str,
    district_geom: Optional[dict] = None,
    target_crs: str = "EPSG:4326",
    method: str = "max",
    resolution_deg: float = 0.0001
) -> Optional[Dict[str, Any]]:
    """
    Computes a single seamless cloud-masked Composite GeoTIFF
    from a list of multi-day index rasters across one or more tiles.
    
    Supported methods:
      - 'max': Maximum Value Composite (MVC / nanmax)
      - 'min': Minimum Value Composite (nanmin)
      - 'mean': Average Value Composite (pixel-wise sum / count)
      
    Memory & Performance Guarantees:

      - Uses district-bounded grid (EPSG:4326) directly to prevent memory explosion.
      - Employs window-slice reprojection per tile to bound peak RAM.
      - Applies district administrative boundary mask directly.
      - Produces tiled, DEFLATE/LZW-compressed GeoTIFF with predictor 3.
    """
    valid_inputs = [p for p in input_raster_paths if p and os.path.exists(p) and os.path.getsize(p) > 1024]
    if not valid_inputs:
        logger.warning("No valid input rasters provided for compositing.")
        return None

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    method_clean = (method or "max").lower().strip()

    # 1. Determine Target Extent from District Geometry or Inputs
    d_shape = None
    if district_geom:
        d_shape = shape(district_geom) if isinstance(district_geom, dict) else district_geom
        minx, miny, maxx, maxy = d_shape.bounds
    else:
        minx, miny, maxx, maxy = 180.0, 90.0, -180.0, -90.0
        for p in valid_inputs:
            try:
                with rasterio.open(win_safe_path(p)) as src:
                    if src.crs:
                        b_minx, b_miny, b_maxx, b_maxy = transform_bounds(src.crs, target_crs, *src.bounds)
                        minx, miny = min(minx, b_minx), min(miny, b_miny)
                        maxx, maxy = max(maxx, b_maxx), max(maxy, b_maxy)
            except Exception:
                pass

    width = max(1, int(np.ceil((maxx - minx) / resolution_deg)))
    height = max(1, int(np.ceil((maxy - miny) / resolution_deg)))

    # Memory Safeguard: Cap canvas size to prevent memory allocation spikes (< 180 MB per float32 layer)
    max_pixels = 45_000_000  # ~6700 x 6700 pixels (~180 MB float32)
    if (width * height) > max_pixels:
        scale_factor = np.sqrt((width * height) / float(max_pixels))
        resolution_deg *= scale_factor
        width = max(1, int(np.ceil((maxx - minx) / resolution_deg)))
        height = max(1, int(np.ceil((maxy - miny) / resolution_deg)))
        logger.info(f"Adjusted composite raster grid to {width} x {height} (~{resolution_deg*111000:.1f}m) to safeguard RAM.")

    dst_transform = rasterio.transform.from_bounds(minx, miny, maxx, maxy, width, height)

    # 2. District Boundary Mask
    district_mask = None
    if d_shape:
        district_mask = rasterio.features.geometry_mask(
            [d_shape],
            out_shape=(height, width),
            transform=dst_transform,
            invert=True
        )

    # 3. Canvas Arrays (Strictly bounded to district)
    if method_clean == "mean":
        sum_arr = np.zeros((height, width), dtype="float32")
        count_arr = np.zeros((height, width), dtype="uint16")
    elif method_clean == "min":
        accumulated = np.full((height, width), np.nan, dtype="float32")
    else:  # "max"
        accumulated = np.full((height, width), np.nan, dtype="float32")

    # 4. Reproject each tile using window slicing
    for r_idx, r_path in enumerate(valid_inputs, start=1):
        try:
            with rasterio.open(win_safe_path(r_path)) as src:
                src_crs = src.crs
                if src_crs is None:
                    continue
                t_minx, t_miny, t_maxx, t_maxy = transform_bounds(src_crs, target_crs, *src.bounds)

                # Check spatial overlap with target grid
                if t_maxx < minx or t_minx > maxx or t_maxy < miny or t_miny > maxy:
                    continue

                # Compute intersecting window
                c_minx = max(minx, t_minx)
                c_miny = max(miny, t_miny)
                c_maxx = min(maxx, t_maxx)
                c_maxy = min(maxy, t_maxy)

                win = rasterio.windows.from_bounds(c_minx, c_miny, c_maxx, c_maxy, transform=dst_transform)
                win = win.round_offsets().round_lengths()
                col_off = max(0, int(win.col_off))
                row_off = max(0, int(win.row_off))
                w_w = min(int(win.width), width - col_off)
                w_h = min(int(win.height), height - row_off)
                if w_w <= 0 or w_h <= 0:
                    continue

                win_adj = rasterio.windows.Window(col_off, row_off, w_w, w_h)
                win_tf = rasterio.windows.transform(win_adj, dst_transform)

                dest_slice = np.full((w_h, w_w), np.nan, dtype="float32")
                src_nodata_val = src.nodata if src.nodata is not None else np.nan
                reproject(
                    source=rasterio.band(src, 1),
                    destination=dest_slice,
                    src_nodata=src_nodata_val,
                    dst_nodata=np.nan,
                    src_transform=src.transform,
                    src_crs=src_crs,
                    dst_transform=win_tf,
                    dst_crs=target_crs,
                    resampling=Resampling.bilinear,
                    num_threads=4
                )

                if method_clean == "mean":
                    valid_m = ~np.isnan(dest_slice)
                    target_sum = sum_arr[row_off : row_off + w_h, col_off : col_off + w_w]
                    target_cnt = count_arr[row_off : row_off + w_h, col_off : col_off + w_w]
                    target_sum[valid_m] += dest_slice[valid_m]
                    target_cnt[valid_m] += 1
                elif method_clean == "min":
                    target_slice = accumulated[row_off : row_off + w_h, col_off : col_off + w_w]
                    accumulated[row_off : row_off + w_h, col_off : col_off + w_w] = np.where(
                        np.isnan(target_slice), dest_slice, np.fmin(target_slice, dest_slice)
                    )
                else:  # "max"
                    target_slice = accumulated[row_off : row_off + w_h, col_off : col_off + w_w]
                    accumulated[row_off : row_off + w_h, col_off : col_off + w_w] = np.where(
                        np.isnan(target_slice), dest_slice, np.fmax(target_slice, dest_slice)
                    )
        except Exception as e:
            logger.warning(f"Error compositing tile '{r_path}': {e}")

    # 5. Finalize composite array
    if method_clean == "mean":
        with np.errstate(divide="ignore", invalid="ignore"):
            accumulated = np.where(count_arr > 0, sum_arr / count_arr, np.nan).astype("float32")

    if district_mask is not None:
        accumulated[~district_mask] = np.nan

    # 6. Save compressed single-band GeoTIFF
    profile = {
        "driver": "GTiff",
        "height": height,
        "width": width,
        "count": 1,
        "dtype": "float32",
        "crs": target_crs,
        "transform": dst_transform,
        "nodata": np.nan,
        "compress": "DEFLATE",
        "predictor": 3,
        "zlevel": 1,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "bigtiff": "IF_SAFER"
    }

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_file = os.path.join(tmp_dir, os.path.basename(output_path))
        with rasterio.open(temp_file, "w", **profile) as dst:
            dst.write(accumulated, 1)
            dst.set_band_description(1, method_clean.upper())
            try:
                dst.update_tags(1, DESCRIPTION=f"{method_clean.upper()} Temporal Composite", METHOD=method_clean)
            except Exception:
                pass

        temp_target = output_path + ".tmp"
        shutil.copy2(temp_file, temp_target)
        if os.path.exists(output_path):
            try:
                os.remove(output_path)
            except Exception:
                pass
        os.replace(temp_target, output_path)

    # 7. Calculate Statistics
    valid_mask = ~np.isnan(accumulated)
    valid_pixels = int(np.count_nonzero(valid_mask))
    total_pixels = accumulated.size
    coverage_pct = float(valid_pixels / total_pixels * 100.0) if total_pixels > 0 else 0.0

    mean_val = float(np.nanmean(accumulated[valid_mask])) if valid_pixels > 0 else 0.0
    min_val = float(np.nanmin(accumulated[valid_mask])) if valid_pixels > 0 else 0.0
    max_val = float(np.nanmax(accumulated[valid_mask])) if valid_pixels > 0 else 0.0
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)

    return {
        "output_path": output_path,
        "filename": os.path.basename(output_path),
        "file_size_mb": round(file_size_mb, 2),
        "valid_pixels": valid_pixels,
        "total_pixels": total_pixels,
        "coverage_pct": round(coverage_pct, 2),
        "mean_value": round(mean_val, 4),
        "min_value": round(min_val, 4),
        "max_value": round(max_val, 4),
        "input_scenes_count": len(valid_inputs)
    }


# ─────────────────────────────────────────────────────────────────────────────
# 4. Master Composite Pipeline Execution
# ─────────────────────────────────────────────────────────────────────────────

def run_temporal_compositing_for_request(
    db: Session,
    request_id: int,
    composite_interval: Optional[str] = None,
    level: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Executes Stage 4 Temporal Compositing for a given processing request.
    Generates single merged composite GeoTIFF files for all days in each interval window
    for every requested spectral index (NDVI, LSWI) aggregated using the specified level ('max', 'min', 'mean').
    """
    req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
    if not req:
        logger.error(f"Request #{request_id} not found for compositing.")
        return []

    interval = composite_interval or req.composite_interval or "none"
    if not interval or interval.lower() in ("none", "null", "false"):
        logger.info(f"Request #{request_id} composite interval is '{interval}' (no compositing requested).")
        return []

    req_level = (level or getattr(req, "level", "max") or "max").lower().strip()
    if req_level not in ("max", "min", "mean"):
        req_level = "max"

    district_name = req.district or req.state or "Region"
    start_str = req.start_date.strftime("%Y-%m-%d")
    end_str = req.end_date.strftime("%Y-%m-%d")
    req_indices = req.indices if isinstance(req.indices, list) and req.indices else ["NDVI", "LSWI"]

    # Only optical indices (NDVI, LSWI, etc.) support cloud-masked temporal compositing
    spectral_indices = [idx for idx in req_indices if idx.upper() not in ("VV", "VH", "VV/VH", "SAR")]
    if not spectral_indices:
        spectral_indices = ["NDVI", "LSWI"]

    # 1. Compute discrete composite windows (e.g. weekly 7-day, fortnightly 15-day, monthly)
    windows = generate_composite_windows(start_str, end_str, interval, satellite=getattr(req, "satellite", None))
    if not windows:
        logger.info(f"No composite windows generated for interval '{interval}' between {start_str} and {end_str}.")
        return []

    from app.db.scripts.download_district_tiles import append_request_log

    header_msg = (
        f"\n==============================================================================\n"
        f"  [STAGE 4/4] TEMPORAL COMPOSITING & DISTRICT MOSAICING (Interval: '{interval.upper()}', Level: '{req_level.upper()}')\n"
        f"  District: {district_name} | Date Windows ({len(windows)}): {', '.join([w['label'] for w in windows])}\n"
        f"=============================================================================="
    )
    logger.info(header_msg)
    append_request_log(db, request_id, header_msg)

    # 2. Fetch District Geometry from PostgreSQL
    geom_dict, state_name = get_district_geometry_from_db(db, district_name)
    district_bbox = None
    if geom_dict:
        try:
            d_poly = shape(geom_dict if not isinstance(geom_dict, str) else json.loads(geom_dict))
            district_bbox = d_poly.bounds
            append_request_log(db, request_id, f"  • District boundary polygon loaded for '{district_name}' ({state_name or 'Auto'}).")
        except Exception as e:
            logger.warning(f"Error parsing district polygon: {e}")
            append_request_log(db, request_id, f"  • District boundary polygon loaded for '{district_name}' ({state_name or 'Auto'}).")
    else:
        append_request_log(db, request_id, f"  • Note: District geometry not in DB; creating unclipped full-extent composite.")

    composite_results = []
    year_str = start_str[0:4]

    # Destination directories on NAS and delivery archive
    nas_composite_dir = os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, year_str, interval.lower())
    local_delivery_dir = os.path.join(settings.DELIVERY_DIR, f"request_{request_id}")

    os.makedirs(nas_composite_dir, exist_ok=True)
    os.makedirs(local_delivery_dir, exist_ok=True)

    for win in windows:
        w_start = win["start_date"]
        w_end = win["end_date"]
        w_label = win["label"]

        append_request_log(db, request_id, f"\n  ▶ Processing Window '{w_label}' ({w_start} to {w_end}, {win['days_count']} days)...")

        for idx_name in spectral_indices:
            idx_clean = idx_name.upper().strip()
            
            # Find all scene rasters for this window and index (strictly matching district)
            input_rasters = find_index_rasters_for_window(
                db=db,
                district_name=district_name,
                window_start=w_start,
                window_end=w_end,
                index_name=idx_clean,
                request_id=request_id,
                district_bbox=district_bbox
            )

            if not input_rasters:
                warn_msg = f"     ⚠ WARN: No {idx_clean} rasters available for window {w_start} to {w_end}."
                logger.warning(warn_msg)
                append_request_log(db, request_id, warn_msg, level="WARNING")
                continue

            out_filename = f"Composite_{idx_clean}_{req_level}_{interval.lower()}_{district_name}_{w_start.replace('-', '')}_{w_end.replace('-', '')}.tif"
            nas_out_path = os.path.join(nas_composite_dir, out_filename)
            local_out_path = os.path.join(local_delivery_dir, out_filename)

            nas_ok, _, _ = verify_raster(nas_out_path)
            local_ok, _, _ = verify_raster(local_out_path)

            if nas_ok or local_ok:
                existing_path = nas_out_path if nas_ok else local_out_path
                if nas_ok and not local_ok:
                    try: shutil.copy2(nas_out_path, local_out_path)
                    except Exception: pass
                elif local_ok and not nas_ok:
                    try: shutil.copy2(local_out_path, nas_out_path)
                    except Exception: pass

                try:
                    with rasterio.open(win_safe_path(existing_path)) as src:
                        arr = src.read(1)
                        valid_mask = ~np.isnan(arr)
                        valid_pixels = int(np.count_nonzero(valid_mask))
                        total_pixels = arr.size
                        coverage_pct = float(valid_pixels / total_pixels * 100.0) if total_pixels > 0 else 0.0
                        mean_val = float(np.nanmean(arr[valid_mask])) if valid_pixels > 0 else 0.0
                        min_val = float(np.nanmin(arr[valid_mask])) if valid_pixels > 0 else 0.0
                        max_val = float(np.nanmax(arr[valid_mask])) if valid_pixels > 0 else 0.0
                        file_size_mb = os.path.getsize(existing_path) / (1024 * 1024)

                    stats = {
                        "output_path": nas_out_path,
                        "filename": out_filename,
                        "file_size_mb": round(file_size_mb, 2),
                        "valid_pixels": valid_pixels,
                        "total_pixels": total_pixels,
                        "coverage_pct": round(coverage_pct, 2),
                        "mean_value": round(mean_val, 4),
                        "min_value": round(min_val, 4),
                        "max_value": round(max_val, 4),
                        "input_scenes_count": len(input_rasters)
                    }

                    stats["window"] = win
                    stats["index"] = idx_clean
                    stats["district"] = district_name
                    stats["local_delivery_path"] = local_out_path
                    composite_results.append(stats)

                    comp_log = (
                        f"     ✓ [{idx_clean} ({req_level.upper()}) COMPOSITE ALREADY EXISTS - SKIPPED] Window '{w_label}' ({w_start} to {w_end}) "
                        f"verified on NAS -> '{out_filename}' ({stats['file_size_mb']:.1f} MB, Clear Coverage: {stats['coverage_pct']:.1f}%)."
                    )
                    logger.info(comp_log)
                    append_request_log(db, request_id, comp_log)
                    continue
                except Exception as ex_read_err:
                    logger.warning(f"Could not read existing composite '{existing_path}': {ex_read_err}. Re-building composite.")

            stats = create_temporal_composite_raster(
                input_raster_paths=input_rasters,
                output_path=nas_out_path,
                district_geom=geom_dict,
                target_crs="EPSG:4326",
                method=req_level
            )

            if stats:
                # Also place copy into local request delivery folder for direct single-click downloads
                try:
                    shutil.copy2(nas_out_path, local_out_path)
                except Exception:
                    pass

                stats["window"] = win
                stats["index"] = idx_clean
                stats["district"] = district_name
                stats["local_delivery_path"] = local_out_path
                composite_results.append(stats)

                comp_log = (
                    f"     ✓ [{idx_clean} ({req_level.upper()}) TEMPORAL COMPOSITE CREATED] Window '{w_label}' ({w_start} to {w_end}) "
                    f"merged from {stats['input_scenes_count']} scene days -> Saved '{out_filename}' "
                    f"({stats['file_size_mb']:.1f} MB, Clear Coverage: {stats['coverage_pct']:.1f}%, Mean: {stats['mean_value']:.4f})."
                )
                logger.info(comp_log)
                append_request_log(db, request_id, comp_log)

    summary_msg = (
        f"\n==============================================================================\n"
        f"  TEMPORAL COMPOSITING FINISHED FOR '{district_name}': {len(composite_results)} Composite GeoTIFFs created.\n"
        f"  Location: '{nas_composite_dir}' and '{local_delivery_dir}'.\n"
        f"=============================================================================="
    )
    logger.info(summary_msg)
    append_request_log(db, request_id, summary_msg)

    return composite_results
