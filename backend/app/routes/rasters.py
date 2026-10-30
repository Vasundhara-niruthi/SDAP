"""
=============================================================================
SDAP Downloaded GeoTIFF Raster Retrieval & Export API Routes
=============================================================================
Location: backend/app/routes/rasters.py

Description:
    Exposes endpoints to query held rasters, stream individual GeoTIFF files,
    bundle batches into streamed ZIP archives, and query region coverage.
=============================================================================
"""

import os
import shutil
import tempfile
import zipfile
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
try:
    from fastapi.responses import FileResponse  # type: ignore
except (ImportError, ModuleNotFoundError):
    from starlette.responses import FileResponse  # type: ignore
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.sdap_models import UserModel
from app.services.downloader_service import (
    ensure_nas_connection,
    get_available_downloaded_regions,
    resolve_tif_path,
    search_downloaded_tifs_by_region,
    strip_win_extended_prefix,
)
from app.services.sentinel1_processor_service import win_safe_path

router = APIRouter()


@router.get("/tifs/available-regions", summary="Get all States and Districts with downloaded GeoTIFF rasters")
def get_downloaded_regions(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns only the States and Districts that have actual held scenes and downloaded
    GeoTIFF rasters stored in PostgreSQL. Used to populate the frontend Data Retrieval Form.
    """
    return get_available_downloaded_regions(db)


@router.get("/tifs/download-file", summary="Download a specific GeoTIFF raster file directly")
def download_tif_file(
    file_path: str = Query(..., description="Path to the GeoTIFF .tif file"),
    token: Optional[str] = Query(None, description="Optional JWT authentication token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Streams a downloaded GeoTIFF raster file directly to the user's browser for download.
    """
    resolved_path, exists = resolve_tif_path(file_path)

    if not exists or not os.path.exists(resolved_path):
        raise HTTPException(
            status_code=404,
            detail=f"GeoTIFF raster file not found on disk: {file_path}"
        )

    filename = os.path.basename(resolved_path)
    return FileResponse(
        path=resolved_path,
        filename=filename,
        media_type="image/tiff"
    )


@router.get("/tifs/download-zip", summary="Batch download matching GeoTIFF rasters as a ZIP archive")
def download_tifs_zip(
    state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    satellite: Optional[str] = Query(None),
    band: Optional[str] = Query(None),
    composite_interval: Optional[str] = Query(None, description="Temporal interval: weekly, fortnightly, monthly, or none"),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    request_id: Optional[int] = Query(None, description="Optional Acquisition Request ID filter"),
    token: Optional[str] = Query(None, description="Optional JWT authentication token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Bundles all matching verified GeoTIFF rasters into a ZIP archive and streams it to the user.
    """
    ret = search_downloaded_tifs_by_region(
        db=db, state=state, district=district, satellite=satellite,
        band=band, start_date=start_date, end_date=end_date,
        composite_interval=composite_interval, request_id=request_id
    )

    tifs = ret.get("tifs", [])
    if not tifs:
        raise HTTPException(status_code=404, detail="No matching downloaded GeoTIFF files found to archive.")

    total_mb = ret.get("total_size_mb", 0)
    if total_mb and total_mb > 15000:
        raise HTTPException(
            status_code=400,
            detail=f"The selected dataset is too large ({total_mb:.1f} MB across {len(tifs)} files) to download as a single ZIP archive. Please filter by specific Spectral/SAR Bands (e.g. NDVI, B04, B08, VV, VH) or select a narrower Date Range."
        )

    tmp_dir = tempfile.mkdtemp()
    zip_filename = f"SDAP_GeoTIFFs_{district or state or ('Request_' + str(request_id) if request_id else 'Batch')}.zip"
    zip_path = os.path.join(tmp_dir, zip_filename)

    seen_paths = set()
    seen_arcnames = set()
    is_pure_s1 = bool(satellite and "Sentinel-1" in satellite and "Sentinel-2" not in satellite)
    s1_valid_stems = ("vv_orb_tnr_cal_tc_db", "vh_orb_tnr_cal_tc_db", "vv_vh_orb_tnr_cal_tc_db")

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
        for item in tifs:
            try:
                raw_p = item.get("path", "")
                p, exists = resolve_tif_path(raw_p)
                safe_p = win_safe_path(p) if p else ""
                if not exists and not (os.path.exists(safe_p) or os.path.exists(p)):
                    clean_raw = strip_win_extended_prefix(raw_p)
                    ensure_nas_connection(clean_raw)
                    safe_raw = win_safe_path(clean_raw)
                    if os.path.exists(safe_raw) or os.path.exists(clean_raw):
                        p = clean_raw
                        safe_p = safe_raw
                        exists = True
                    else:
                        continue

                abs_p = os.path.normcase(os.path.abspath(p))
                if abs_p in seen_paths:
                    continue
                seen_paths.add(abs_p)

                norm_p = os.path.normpath(p)
                parts = norm_p.split(os.sep)
                fname = os.path.basename(norm_p)
                dist_folder = district or item.get("tile") or "Rasters"
                sc_id = item.get("scene_id")

                # Check if this is a composite raster
                is_composite = (
                    fname.lower().startswith("composite_") or 
                    "composites" in [pt.lower() for pt in parts] or
                    item.get("is_composite") or
                    (item.get("satellite") == "Composite Deliverable")
                )

                # Pure Sentinel-1 requests: archive ONLY calibrated products or Sentinel-1 composites
                stem = os.path.splitext(fname)[0].lower()
                if is_pure_s1 and not is_composite and not any(v in stem for v in s1_valid_stems):
                    continue

                if is_composite:
                    arcname = f"{dist_folder}/Composites/{fname}"
                elif sc_id and not sc_id.lower().startswith("composite"):
                    arcname = f"{dist_folder}/{sc_id}/{fname}"
                elif "SDAP_DATA_STORAGE" in parts:
                    storage_idx = parts.index("SDAP_DATA_STORAGE")
                    rel_parts = [rp for rp in parts[storage_idx + 1:] if rp.lower() != "delivery" and not rp.lower().startswith("request_")]
                    arcname = "/".join(rel_parts)
                elif "archive" in parts:
                    arch_idx = parts.index("archive")
                    rel_parts = [rp for rp in parts[arch_idx + 1:] if rp.lower() != "delivery" and not rp.lower().startswith("request_")]
                    arcname = "/".join(rel_parts)
                else:
                    arcname = f"{dist_folder}/{fname}"

                clean_parts = [ap for ap in arcname.split("/") if ap and ap.lower() != "delivery" and not ap.lower().startswith("request_")]
                clean_arcname = "/".join(clean_parts)
                if not clean_arcname or clean_arcname == fname:
                    if sc_id and not sc_id.lower().startswith("composite"):
                        clean_arcname = f"{dist_folder}/{sc_id}/{fname}"
                    else:
                        clean_arcname = f"{dist_folder}/{fname}"

                base_arcname = clean_arcname
                counter = 1
                while clean_arcname.lower() in seen_arcnames:
                    root, ext = os.path.splitext(base_arcname)
                    clean_arcname = f"{root}_{counter}{ext}"
                    counter += 1

                seen_arcnames.add(clean_arcname.lower())
                write_target = safe_p if os.path.exists(safe_p) else p

                # High-speed 16MB buffered stream from NAS for maximum SMB network throughput
                import time
                mtime = os.path.getmtime(write_target) if os.path.exists(write_target) else time.time()
                fsize = os.path.getsize(write_target) if os.path.exists(write_target) else 0

                zinfo = zipfile.ZipInfo(clean_arcname, date_time=time.localtime(mtime)[:6])
                zinfo.compress_type = zipfile.ZIP_STORED
                zinfo.file_size = fsize

                BUFFER_SIZE = 16 * 1024 * 1024
                with open(write_target, "rb", buffering=BUFFER_SIZE) as src, zf.open(zinfo, "w") as dest:
                    shutil.copyfileobj(src, dest, length=BUFFER_SIZE)
            except Exception as item_err:
                import logging
                logging.getLogger("sdap.rasters").warning(f"Failed to write raster {item.get('path')} into zip: {item_err}")

    if not seen_paths:
        try:
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass
        raise HTTPException(
            status_code=404,
            detail="None of the matching GeoTIFF raster files currently exist on disk or NAS storage."
        )

    def _cleanup():
        try:
            if os.path.exists(tmp_dir):
                shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass

    file_size = os.path.getsize(zip_path) if os.path.exists(zip_path) else None
    resp_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f'attachment; filename="{zip_filename}"',
    }
    if file_size:
        resp_headers["Content-Length"] = str(file_size)

    return FileResponse(
        path=zip_path,
        filename=zip_filename,
        media_type="application/zip",
        headers=resp_headers,
        background=BackgroundTask(_cleanup)
    )


@router.get("/tifs/retrieve", summary="Retrieve downloaded GeoTIFF rasters by State and District")
def retrieve_tifs_by_region(
    state: Optional[str] = Query(None, description="Filter by State name (e.g. Telangana, Odisha)"),
    district: Optional[str] = Query(None, description="Filter by District name (e.g. Khammam, Cuttack)"),
    satellite: Optional[str] = Query(None, description="Filter by Satellite (Sentinel-1, Sentinel-2)"),
    band: Optional[str] = Query(None, description="Filter by Band name (e.g. B04, B08, TCI, SCL, VV, VH)"),
    composite_interval: Optional[str] = Query(None, description="Filter by Composite interval (weekly, fortnightly, monthly, none)"),
    start_date: Optional[str] = Query(None, description="Filter start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="Filter end date YYYY-MM-DD"),
    request_id: Optional[int] = Query(None, description="Filter by Acquisition Request ID"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Matches the State and District to tile IDs in district_tiles_mapping, queries PostgreSQL
    for all stored GeoTIFF (.tif) file paths in held scenes, and returns verified file paths
    and metadata for user retrieval and next processing steps.
    """
    try:
        return search_downloaded_tifs_by_region(
            db=db,
            state=state,
            district=district,
            satellite=satellite,
            band=band,
            start_date=start_date,
            end_date=end_date,
            composite_interval=composite_interval,
            request_id=request_id
        )
    except Exception as e:
        import traceback
        import logging
        logging.getLogger("sdap.rasters").error(
            f"Error querying raster files for {district}, {state}: {e}\n{traceback.format_exc()}"
        )
        raise HTTPException(
            status_code=500,
            detail=f"Error querying NAS storage: {str(e)}"
        )

