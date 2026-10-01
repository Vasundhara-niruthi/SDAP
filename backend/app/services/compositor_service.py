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
import calendar
import tempfile
import shutil
import logging
from datetime import datetime, date, timedelta
from typing import List, Dict, Any, Tuple, Optional

import numpy as np
import rasterio
from rasterio.mask import mask
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.merge import merge
from shapely.geometry import shape
from sqlalchemy.orm import Session
from sqlalchemy import text

from app.core.config import settings
from app.models.sdap_models import RequestModel, BandFileModel
from app.services.delivery_service import get_district_geometry_from_db
from app.services.downloader_service import verify_raster

logger = logging.getLogger("sdap.compositor")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Date Window Generator
# ─────────────────────────────────────────────────────────────────────────────

def generate_composite_windows(start_date: str, end_date: str, interval: str) -> List[Dict[str, Any]]:
    """
    Slices a date range into discrete composite windows based on the requested interval.
    
    Intervals supported:
      - 'weekly' (7-day intervals)
      - 'fortnightly' / 'biweekly' (15-day intervals)
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

    elif interval_lower in ("fortnightly", "biweekly", "15-day", "15day", "fortnight"):
        cur = start_dt
        w_idx = 1
        while cur <= end_dt:
            w_end = min(end_dt, cur + timedelta(days=14))
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
    index_name: str
) -> List[str]:
    """
    Finds all verified spectral index GeoTIFFs (e.g. NDVI, LSWI) downloaded or computed
    for any tile overlapping district_name within the specified window dates.
    """
    idx_clean = index_name.upper().strip()
    idx_filenames = [f"{idx_clean}.tif", f"{idx_clean}.tiff"]

    w_start_dt = datetime.strptime(window_start, "%Y-%m-%d").date()
    w_end_dt = datetime.strptime(window_end, "%Y-%m-%d").date()

    # Step 1: Query band_files table in DB
    band_rows = db.query(BandFileModel).filter(
        BandFileModel.band.in_([idx_clean, f"NDVI_{district_name}", f"LSWI_{district_name}"]),
        BandFileModel.verified == 1
    ).all()

    raster_paths = []
    seen_paths = set()

    for row in band_rows:
        try:
            s_date = datetime.strptime(str(row.sensing_date).split(" ")[0], "%Y-%m-%d").date()
            if w_start_dt <= s_date <= w_end_dt:
                if row.path and os.path.exists(row.path) and row.path not in seen_paths:
                    raster_paths.append(row.path)
                    seen_paths.add(row.path)
        except Exception:
            continue

    # Step 2: Scan NAS raw archive directory for any missing scene index rasters
    archive_base = settings.RAW_ARCHIVE_DIR
    if os.path.exists(archive_base):
        # Scan under Sentinel-2 and tile folders
        for root, dirs, files in os.walk(archive_base):
            for fn in files:
                if fn.upper() in (f"{idx_clean}.TIF", f"{idx_clean}.TIFF") or fn.upper().startswith(f"{idx_clean}_"):
                    full_p = os.path.join(root, fn)
                    if full_p in seen_paths:
                        continue
                    # Extract date from folder name or filename
                    parts = root.replace("\\", "/").split("/")
                    folder_name = parts[-1] if parts else ""
                    date_match = None
                    import re
                    m = re.search(r"(\d{4})(\d{2})(\d{2})", folder_name)
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
    target_crs: str = "EPSG:4326"
) -> Optional[Dict[str, Any]]:
    """
    Computes a single seamless cloud-masked Maximum Value Composite (MVC) GeoTIFF
    from a list of multi-day index rasters across one or more tiles.
    
    Steps:
      1. Reprojects all rasters to unified target CRS (EPSG:4326).
      2. Mosaics & stacks temporal scenes using maximum value pixel composite (nanmax).
      3. Clips to district polygon boundary if provided.
      4. Saves compressed GeoTIFF with LZW predictor.
      5. Calculates clear coverage percentage & mean index value.
    """
    valid_inputs = [p for p in input_raster_paths if os.path.exists(p) and os.path.getsize(p) > 1024]
    if not valid_inputs:
        logger.warning("No valid input rasters provided for compositing.")
        return None

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp_dir:
        # Step 1: Reproject all candidate rasters to unified target CRS (EPSG:4326)
        reprojected_paths = []
        for i, r_path in enumerate(valid_inputs):
            try:
                with rasterio.open(r_path) as src:
                    # Verify readable
                    _test = src.read(1, window=rasterio.windows.Window(0, 0, min(64, src.width), min(64, src.height)))
                    transform, width, height = calculate_default_transform(
                        src.crs, target_crs, src.width, src.height, *src.bounds
                    )
                    profile = src.profile.copy()
                    profile.update({
                        "crs": target_crs,
                        "transform": transform,
                        "width": width,
                        "height": height,
                        "dtype": "float32",
                        "nodata": np.nan,
                        "compress": "lzw"
                    })

                    reproj_file = os.path.join(tmp_dir, f"reproj_{i}.tif")
                    with rasterio.open(reproj_file, "w", **profile) as dst:
                        reproject(
                            source=rasterio.band(src, 1),
                            destination=rasterio.band(dst, 1),
                            src_transform=src.transform,
                            src_crs=src.crs,
                            dst_transform=transform,
                            dst_crs=target_crs,
                            resampling=Resampling.bilinear
                        )
                    reprojected_paths.append(reproj_file)
            except Exception as e:
                logger.warning(f"Skipping unreadable or corrupted raster '{r_path}': {e}")

        if not reprojected_paths:
            logger.error("Failed to reproject any input rasters for compositing.")
            return None

        # Step 2: Temporal Merge with Maximum Value Composite (MVC / method='max')
        opened_srcs = [rasterio.open(p) for p in reprojected_paths]
        mosaic_meta = opened_srcs[0].profile.copy()
        try:
            mosaic_arr, mosaic_transform = merge(opened_srcs, method="max", nodata=np.nan)
        finally:
            for s in opened_srcs:
                s.close()
        mosaic_meta.update({
            "height": mosaic_arr.shape[1],
            "width": mosaic_arr.shape[2],
            "transform": mosaic_transform,
            "crs": target_crs,
            "nodata": np.nan,
            "dtype": "float32",
            "count": 1,
            "compress": "lzw",
            "predictor": 3,
            "num_threads": "ALL_CPUS"
        })

        temp_mosaic = os.path.join(tmp_dir, "mosaic.tif")
        with rasterio.open(temp_mosaic, "w", **mosaic_meta) as dst:
            dst.write(mosaic_arr.astype("float32"))

        # Step 3: Clip to District Polygon Boundary if provided
        final_arr = mosaic_arr[0]
        final_meta = mosaic_meta

        if district_geom:
            try:
                with rasterio.open(temp_mosaic) as src:
                    clipped_arr, clipped_transform = mask(src, [district_geom], crop=True, nodata=np.nan)
                    final_arr = clipped_arr[0]
                    final_meta = src.profile.copy()
                    final_meta.update({
                        "height": clipped_arr.shape[1],
                        "width": clipped_arr.shape[2],
                        "transform": clipped_transform,
                        "nodata": np.nan,
                        "compress": "lzw",
                        "predictor": 3,
                        "num_threads": "ALL_CPUS"
                    })
            except Exception as mask_err:
                logger.warning(f"Boundary clipping failed: {mask_err}. Retaining full mosaic.")

        # Step 4: Write Final Composite GeoTIFF to local temp then copy to destination
        local_target = os.path.join(tmp_dir, "final_composite.tif")
        with rasterio.open(local_target, "w", **final_meta) as dst:
            dst.write(final_arr.astype("float32"), 1)

        shutil.copy2(local_target, output_path)

    # Step 5: Statistics & Metrics Calculation
    valid_mask = ~np.isnan(final_arr)
    valid_pixels = int(np.count_nonzero(valid_mask))
    total_pixels = final_arr.size
    coverage_pct = float(valid_pixels / total_pixels * 100.0) if total_pixels > 0 else 0.0

    mean_val = float(np.nanmean(final_arr[valid_mask])) if valid_pixels > 0 else 0.0
    min_val = float(np.nanmin(final_arr[valid_mask])) if valid_pixels > 0 else 0.0
    max_val = float(np.nanmax(final_arr[valid_mask])) if valid_pixels > 0 else 0.0
    file_size_mb = os.path.getsize(output_path) / (1024 * 1024)

    stats = {
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

    return stats


# ─────────────────────────────────────────────────────────────────────────────
# 4. Master Composite Pipeline Execution
# ─────────────────────────────────────────────────────────────────────────────

def run_temporal_compositing_for_request(
    db: Session,
    request_id: int,
    composite_interval: Optional[str] = None
) -> List[Dict[str, Any]]:
    """
    Executes Stage 4 Temporal Compositing for a given processing request.
    Generates single merged composite GeoTIFF files for all days in each interval window
    for every requested spectral index (NDVI, LSWI).
    """
    req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
    if not req:
        logger.error(f"Request #{request_id} not found for compositing.")
        return []

    interval = composite_interval or req.composite_interval or "none"
    if not interval or interval.lower() in ("none", "null", "false"):
        logger.info(f"Request #{request_id} composite interval is '{interval}' (no compositing requested).")
        return []

    district_name = req.district or req.state or "Region"
    start_str = req.start_date.strftime("%Y-%m-%d")
    end_str = req.end_date.strftime("%Y-%m-%d")
    req_indices = req.indices if isinstance(req.indices, list) and req.indices else ["NDVI", "LSWI"]

    # Only optical indices (NDVI, LSWI, etc.) support cloud-masked temporal compositing
    spectral_indices = [idx for idx in req_indices if idx.upper() not in ("VV", "VH", "VV/VH", "SAR")]
    if not spectral_indices:
        spectral_indices = ["NDVI", "LSWI"]

    # 1. Compute discrete composite windows (e.g. weekly 7-day, fortnightly 15-day, monthly)
    windows = generate_composite_windows(start_str, end_str, interval)
    if not windows:
        logger.info(f"No composite windows generated for interval '{interval}' between {start_str} and {end_str}.")
        return []

    from scripts.download_district_tiles import append_request_log

    header_msg = (
        f"\n==============================================================================\n"
        f"  [STAGE 4/4] TEMPORAL COMPOSITING & DISTRICT MOSAICING (Interval: '{interval.upper()}')\n"
        f"  District: {district_name} | Date Windows ({len(windows)}): {', '.join([w['label'] for w in windows])}\n"
        f"=============================================================================="
    )
    logger.info(header_msg)
    append_request_log(db, request_id, header_msg)

    # 2. Fetch District Geometry from PostgreSQL
    geom_dict, state_name = get_district_geometry_from_db(db, district_name)
    if geom_dict:
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
            
            # Find all scene rasters for this window and index
            input_rasters = find_index_rasters_for_window(
                db=db,
                district_name=district_name,
                window_start=w_start,
                window_end=w_end,
                index_name=idx_clean
            )

            if not input_rasters:
                warn_msg = f"     ⚠ WARN: No {idx_clean} rasters available for window {w_start} to {w_end}."
                logger.warning(warn_msg)
                append_request_log(db, request_id, warn_msg, level="WARNING")
                continue

            out_filename = f"Composite_{idx_clean}_{interval.lower()}_{district_name}_{w_start.replace('-', '')}_{w_end.replace('-', '')}.tif"
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
                    with rasterio.open(existing_path) as src:
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
                        f"     ✓ [{idx_clean} COMPOSITE ALREADY EXISTS - SKIPPED] Window '{w_label}' ({w_start} to {w_end}) "
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
                target_crs="EPSG:4326"
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
                    f"     ✓ [{idx_clean} TEMPORAL COMPOSITE CREATED] Window '{w_label}' ({w_start} to {w_end}) "
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
