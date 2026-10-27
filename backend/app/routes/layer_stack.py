"""
=============================================================================
SDAP Multi-Band Layer Stacking API Routes
=============================================================================
Location: backend/app/routes/layer_stack.py

Description:
    Exposes endpoints for creating layer stack jobs, polling execution status,
    cancelling running tasks, downloading stacked GeoTIFF outputs, and
    querying task history.
=============================================================================
"""

import os
import uuid
import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
try:
    from fastapi.responses import FileResponse  # type: ignore
except (ImportError, ModuleNotFoundError):
    from starlette.responses import FileResponse  # type: ignore
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.sdap_models import UserModel, LayerStackJobModel
from app.schemas.request_schema import LayerStackCreate, LayerStackTaskResponse
from app.services.downloader_service import resolve_tif_path
from app.services.stacker_service import (
    launch_layer_stack_task,
    find_matching_layer_stacks_on_nas,
    get_stack_job,
    cancel_layer_stack_task,
    get_latest_stack_job,
    list_db_stack_jobs,
    list_existing_layer_stacks,
    invalidate_request_stacks_cache
)

logger = logging.getLogger("sdap.routes.layer_stack")
router = APIRouter()


@router.post("/layer-stack", response_model=LayerStackTaskResponse, summary="Execute multi-band layer stacking across bands and indices")
def create_layer_stack(
    payload: LayerStackCreate,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Initiates asynchronous multi-band layer stacking with live progress and log tracking:
    Saves to: {RAW_ARCHIVE_DIR}/Composites/stack/{district}/
    Filename: {district}_{season}_{start_date}_{end_date}_{bands}.tif
    """
    try:
        force_recreate = bool(getattr(payload, "force_recreate", False))
        if not force_recreate:
            matches = find_matching_layer_stacks_on_nas(
                district=payload.district,
                state=payload.state,
                season=payload.season or "Kharif",
                start_date=payload.start_date,
                end_date=payload.end_date,
                layers=payload.layers
            )
            if matches:
                top_m = matches[0]
                if payload.request_id:
                    try:
                        existing_rec = db.query(LayerStackJobModel).filter(
                            LayerStackJobModel.request_id == payload.request_id,
                            LayerStackJobModel.filename == top_m["filename"]
                        ).first()
                        if not existing_rec:
                            rec = LayerStackJobModel(
                                task_id=f"stack_ex_{uuid.uuid4().hex[:10]}",
                                request_id=payload.request_id,
                                user_id=current_user.id if current_user else None,
                                district=payload.district,
                                state=payload.state,
                                season=payload.season or "Kharif",
                                start_date=payload.start_date,
                                end_date=payload.end_date,
                                layers=payload.layers,
                                status="SUCCESS",
                                progress=100,
                                step="COMPLETED",
                                output_path=top_m.get("path"),
                                filename=top_m.get("filename"),
                                file_size_mb=top_m.get("file_size_mb")
                            )
                            db.add(rec)
                            db.commit()
                            invalidate_request_stacks_cache()
                    except Exception as e_link:
                        logger.warning(f"Could not link existing NAS match to request #{payload.request_id}: {e_link}")

                return {
                    "status": "EXISTS_ON_NAS",
                    "already_completed": True,
                    "already_in_nas": True,
                    "filename": top_m["filename"],
                    "path": top_m["path"],
                    "file_size_mb": top_m["file_size_mb"],
                    "matches": matches,
                    "district": payload.district,
                    "state": payload.state,
                    "season": payload.season or "Kharif",
                    "layers_order": payload.layers,
                    "message": f"Exact matching layer stack '{top_m['filename']}' is already downloaded and present on NAS storage."
                }

        task_id = launch_layer_stack_task(
            district=payload.district,
            state=payload.state,
            season=payload.season or "Kharif",
            start_date=payload.start_date,
            end_date=payload.end_date,
            layers=payload.layers,
            clip_to_district=payload.clip_to_district if payload.clip_to_district is not None else True,
            output_filename=getattr(payload, "output_filename", None),
            selected_files=getattr(payload, "selected_files", None),
            selected_files_by_band=getattr(payload, "selected_files_by_band", None),
            force_recreate=force_recreate,
            request_id=payload.request_id,
            user_id=current_user.id if current_user else None
        )
        return {
            "status": "RUNNING",
            "task_id": task_id,
            "message": f"Layer stacking background task initiated for {payload.district}."
        }
    except Exception as exc:
        logger.error(f"Failed to initiate layer stack task: {exc}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Layer stacking launch failed: {exc}")


@router.get("/layer-stack/status/{task_id}", summary="Get live status, progress and execution logs for a layer stacking task")
def get_layer_stack_task_status(
    task_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Poll live progress percentage and real-time execution logs for a layer stacking task (checks in-memory & PostgreSQL)."""
    job = get_stack_job(task_id, db=db)
    if not job:
        raise HTTPException(status_code=404, detail=f"Layer stacking task '{task_id}' not found.")
    return job


@router.post("/layer-stack/stop/{task_id}", summary="Stop / Cancel a running layer stacking task immediately")
@router.post("/layer-stack/cancel/{task_id}", summary="Stop / Cancel a running layer stacking task immediately")
def stop_layer_stack_task(
    task_id: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Cancels/stops an active layer stacking task immediately, terminates background workers, and marks status as CANCELLED."""
    cancel_layer_stack_task(task_id)
    return {
        "status": "CANCELLED",
        "task_id": task_id,
        "message": f"Layer stacking task '{task_id}' has been stopped successfully."
    }


@router.get("/layer-stack/latest-active", summary="Get most recent or active layer stacking task for persistence across page refresh")
def get_latest_layer_stack_task(
    district: Optional[str] = Query(None, description="Optional district filter"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Retrieves the latest running or completed layer stack job from PostgreSQL."""
    job = get_latest_stack_job(district=district, db=db)
    return job or {}


@router.get("/layer-stack/jobs", summary="List layer stacking jobs history directly from PostgreSQL")
def get_layer_stack_jobs(
    district: Optional[str] = Query(None, description="Filter by district"),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Lists history of layer stacking executions with their logs and outputs."""
    return list_db_stack_jobs(district=district, limit=limit, db=db)


@router.get("/layer-stack/download", summary="Download a generated layer-stacked GeoTIFF")
def download_layer_stack(
    file_path: str = Query(..., description="Path to the layer-stacked GeoTIFF"),
    token: Optional[str] = Query(None, description="Optional JWT token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    resolved_path, exists = resolve_tif_path(file_path)
    if not exists or not os.path.exists(resolved_path):
        raise HTTPException(status_code=404, detail=f"Layer-stacked GeoTIFF file not found on disk: {file_path}")

    filename = os.path.basename(resolved_path)
    return FileResponse(
        path=resolved_path,
        filename=filename,
        media_type="image/tiff"
    )


@router.get("/layer-stack/history", summary="List previously generated layer-stacked GeoTIFFs")
def list_layer_stacks(
    district: Optional[str] = Query(None, description="Filter by district"),
    state: Optional[str] = Query(None, description="Filter by state"),
    season: Optional[str] = Query(None, description="Filter by season"),
    start_date: Optional[str] = Query(None, description="Filter by start date"),
    end_date: Optional[str] = Query(None, description="Filter by end date"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    return list_existing_layer_stacks(
        district=district,
        state=state,
        season=season,
        start_date=start_date,
        end_date=end_date
    )

