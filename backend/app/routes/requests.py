"""Satellite acquisition request routes: estimation, submit/query/update, cancel/re-run, deliverables.

Also mounts the raster and layer-stack sub-routers under the /requests namespace.
"""

import os
import math
import time
import queue
import logging
import threading
from datetime import datetime
from typing import List, Optional, Dict, Any, Tuple, Callable

from fastapi import APIRouter, Depends, HTTPException, status, Query
try:
    from fastapi.responses import FileResponse  # type: ignore
except (ImportError, ModuleNotFoundError):
    from starlette.responses import FileResponse  # type: ignore
from sqlalchemy.orm import Session, joinedload, defer
from sqlalchemy import text, func

from app.db import get_db, SessionLocal
from app.core.security import get_current_user, get_current_admin
from app.db.models import RequestModel, UserModel, ProcessJobModel
from app.schemas.request_schema import (
    RequestCreate, RequestResponse, RequestEstimateResponse,
)
from app.core.config import settings

from app.routes.rasters import router as rasters_router
from app.routes.layer_stack import router as layer_stack_router

logger = logging.getLogger("sdap.routes.requests")
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

# Storage thresholds (SRS 8.3 & 11.2)
MAX_TOTAL_STORAGE_GB = 10_000.0    # 10 TB usable NAS (SRS 11.2)
APPROVAL_THRESHOLD_PCT = 0.20      # Hold for approval: would use > 20% of free storage
APPROVAL_THRESHOLD_GB = MAX_TOTAL_STORAGE_GB * APPROVAL_THRESHOLD_PCT   # 2,000 GB

# Daily submission quota for non-admin users
MAX_DAILY_REQUESTS = 3
ADMIN_DAILY_LIMIT_DISPLAY = 999
# Namespace key for pg_advisory_xact_lock(namespace, user_id) guarding quota check + insert
_QUOTA_LOCK_NAMESPACE = 0x5DA9

# Legacy cap on the execution_logs field returned in RequestResponse (tail window)
LOG_RESPONSE_CAP = 200_000

# Every status a request row may legitimately hold (pipeline + admin workflow)
ALLOWED_REQUEST_STATUSES = {
    "SUBMITTED", "ACCEPTED", "HOLD_FOR_APPROVAL", "REJECTED",
    "PROCESSING", "COMPLETED", "FAILED", "STOPPED", "HELD", "CANCELLED",
}
# Statuses a non-admin may NOT (re)start a pipeline from
_APPROVAL_GATED_STATUSES = {"HOLD_FOR_APPROVAL", "REJECTED"}


# ─────────────────────────────────────────────────────────────────────────────
# Ownership / authorization helpers
# ─────────────────────────────────────────────────────────────────────────────

def _is_admin(user: Optional[UserModel]) -> bool:
    return (getattr(user, "role", None) or "").strip().upper() == "ADMIN"


def _assert_owner_or_admin(owner_id: Optional[int], current_user: UserModel, action: str = "access") -> None:
    """Same rule as the original /stop endpoint: request owner or ADMIN only."""
    if not _is_admin(current_user) and owner_id != current_user.id:
        raise HTTPException(status_code=403, detail=f"Not authorized to {action} this request.")


def get_owned_request_or_403(
    db: Session,
    request_id: int,
    current_user: UserModel,
    action: str = "access",
    include_logs: bool = True,
) -> RequestModel:
    """Load a request (with its user) or raise 404; raise 403 unless caller owns it or is ADMIN.

    include_logs=False defers the (potentially 200KB+) execution_logs column; it is still
    lazily loaded if accessed later.
    """
    opts = [joinedload(RequestModel.user)]
    if not include_logs:
        opts.append(defer(RequestModel.execution_logs))
    req = db.query(RequestModel).options(*opts).filter(RequestModel.id == request_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")
    _assert_owner_or_admin(req.user_id, current_user, action)
    return req


def _assert_owner_by_id(db: Session, request_id: int, current_user: UserModel, action: str = "access") -> None:
    """Cheap ownership check that only selects user_id (no full row / logs)."""
    row = db.query(RequestModel.user_id).filter(RequestModel.id == request_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    _assert_owner_or_admin(row[0], current_user, action)


def _assert_pipeline_start_allowed(req: RequestModel, current_user: UserModel) -> None:
    """Non-admins may not start/re-run a request that is awaiting approval or was rejected."""
    if _is_admin(current_user):
        return
    st = (req.status or "").strip().upper()
    if st == "HOLD_FOR_APPROVAL":
        raise HTTPException(
            status_code=403,
            detail=f"Request #{req.id} is awaiting admin approval and cannot be started until it is approved."
        )
    if st in _APPROVAL_GATED_STATUSES:
        raise HTTPException(status_code=403, detail=f"Request #{req.id} was rejected and cannot be started.")


def _append_log_and_set_status(db: Session, request_id: int, log_line: str, new_status: str) -> None:
    """Atomically append to execution_logs and set status (no read-modify-write race with
    the pipeline's concurrent append_request_log UPDATEs). Caller commits."""
    db.query(RequestModel).filter(RequestModel.id == request_id).update(
        {
            RequestModel.execution_logs: func.coalesce(RequestModel.execution_logs, "") + log_line,
            RequestModel.status: new_status,
        },
        synchronize_session=False,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Short-TTL cache for NAS-backed listings (/tifs, /composites)
# ─────────────────────────────────────────────────────────────────────────────

_DISK_CACHE_TTL_SEC = 8.0
_disk_cache_lock = threading.Lock()
_FINISHED_CACHE_TTL_SEC = 120.0  # finished requests no longer change
_TERMINAL_STATUSES = {"COMPLETED", "FAILED", "CANCELLED", "STOPPED", "REJECTED"}
_tifs_cache: Dict[int, Tuple[float, Any, float]] = {}
_composites_cache: Dict[int, Tuple[float, Any, float]] = {}


def _cache_get(cache: Dict[int, Tuple[float, Any, float]], key: int) -> Any:
    with _disk_cache_lock:
        entry = cache.get(key)
    if entry and (time.monotonic() - entry[0]) < entry[2]:
        return entry[1]
    return None


def _cache_put(cache: Dict[int, Tuple[float, Any, float]], key: int, value: Any, ttl: float = _DISK_CACHE_TTL_SEC) -> None:
    now = time.monotonic()
    with _disk_cache_lock:
        for k in [k for k, (ts, _, t) in cache.items() if now - ts >= t]:
            cache.pop(k, None)
        cache[key] = (now, value, ttl)


def invalidate_request_disk_cache(request_id: int) -> None:
    with _disk_cache_lock:
        _tifs_cache.pop(request_id, None)
        _composites_cache.pop(request_id, None)


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline execution: bounded daemon worker pool + duplicate-run guard
# ─────────────────────────────────────────────────────────────────────────────

def _pipeline_worker_count() -> int:
    raw = (
        getattr(settings, "PIPELINE_MAX_WORKERS", None)
        or os.environ.get("SDAP_PIPELINE_MAX_WORKERS")
        or os.environ.get("PIPELINE_MAX_WORKERS")
    )
    try:
        return max(1, int(raw)) if raw else 2
    except (TypeError, ValueError):
        return 2


class _BoundedDaemonPool:
    """Fixed-size pool of daemon worker threads fed by a FIFO queue.

    Used instead of concurrent.futures.ThreadPoolExecutor because its workers are joined at
    interpreter exit, which would block server shutdown/reload behind multi-hour pipelines
    (the previous implementation used daemon threads).
    """

    def __init__(self, max_workers: int, name: str):
        self.max_workers = max(1, int(max_workers))
        self._name = name
        self._queue: "queue.Queue[Tuple[Callable[..., Any], tuple]]" = queue.Queue()
        self._lock = threading.Lock()
        self._workers: List[threading.Thread] = []
        self._busy = 0

    def _ensure_workers(self) -> None:
        self._workers = [t for t in self._workers if t.is_alive()]
        while len(self._workers) < self.max_workers:
            t = threading.Thread(
                target=self._run, daemon=True, name=f"{self._name}-{len(self._workers) + 1}"
            )
            t.start()
            self._workers.append(t)

    def submit(self, fn: Callable[..., Any], *args: Any) -> bool:
        """Queue fn(*args). Returns True if a worker is (probably) free to start it now."""
        with self._lock:
            self._ensure_workers()
            starts_now = (self._busy + self._queue.qsize()) < self.max_workers
            self._queue.put((fn, args))
        return starts_now

    def _run(self) -> None:
        while True:
            fn, args = self._queue.get()
            with self._lock:
                self._busy += 1
            try:
                fn(*args)
            except Exception:
                logger.exception("Unhandled error in pipeline worker")
            finally:
                with self._lock:
                    self._busy -= 1
                self._queue.task_done()


PIPELINE_POOL = _BoundedDaemonPool(_pipeline_worker_count(), name="sdap-pipeline")

# Request IDs queued or running in this process (duplicate-run guard)
active_request_threads = set()
active_threads_lock = threading.Lock()


def trigger_pipeline_in_thread(request_id: int):
    """Queues the pipeline on the bounded worker pool if not already queued/running."""
    with active_threads_lock:
        if request_id in active_request_threads:
            logger.info(f"Request #{request_id} is already running in a background thread.")
            return
        active_request_threads.add(request_id)

    def _worker():
        try:
            run_pipeline_background(request_id)
        finally:
            with active_threads_lock:
                active_request_threads.discard(request_id)

    starts_now = PIPELINE_POOL.submit(_worker)
    if not starts_now:
        logger.info(
            f"Request #{request_id} queued: all {PIPELINE_POOL.max_workers} pipeline workers are busy."
        )
        try:
            from app.db.scripts.download_district_tiles import append_request_log
            _db = SessionLocal()
            try:
                append_request_log(
                    _db, request_id,
                    f"Queued: waiting for a free pipeline worker ({PIPELINE_POOL.max_workers} concurrent max)."
                )
            finally:
                _db.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# Estimation
# ─────────────────────────────────────────────────────────────────────────────

def estimate_request_storage(req: RequestCreate, db: Session = None) -> dict:
    """
    Dynamic storage estimation grounded in PostgreSQL tile mappings (SRS 8.3 & 11.1).
    Returns a dict with all estimate components for the confirmation step.
    """
    days = max(1, (req.end_date - req.start_date).days)
    months = days / 30.0

    # Default tile counts (fallback when DB unavailable)
    tile_count = 32 if (req.state and not req.district) else 3

    if db:
        try:
            # SAVEPOINT so a failed lookup cannot abort the caller's surrounding transaction
            with db.begin_nested():
                if req.district:
                    res = db.execute(
                        text("SELECT COUNT(DISTINCT tile_id) FROM district_tiles_mapping WHERE LOWER(district_name) = LOWER(:d)"),
                        {"d": req.district}
                    ).fetchone()
                    if res and res[0] > 0:
                        tile_count = res[0]
                elif req.state:
                    res = db.execute(
                        text("""
                            SELECT COUNT(DISTINCT dtm.tile_id)
                            FROM district_tiles_mapping dtm
                            JOIN district_boundaries db_b ON dtm.district_id = db_b.id
                            WHERE LOWER(db_b.state_name) = LOWER(:s)
                        """),
                        {"s": req.state}
                    ).fetchone()
                    if res and res[0] > 0:
                        tile_count = res[0]
        except Exception:
            pass

    is_s1 = "Sentinel-1" in req.satellite
    is_s2 = "Sentinel-2" in req.satellite or not is_s1

    if is_s1 and is_s2:
        s1_acq = 2.5
        s1_size = 0.615
        s2_acq = 6.0
        s2_size = 0.270
        total_gb = (tile_count * s1_acq * months * s1_size) + (tile_count * s2_acq * months * s2_size)
        scene_count = int(tile_count * (s1_acq + s2_acq) * months)
        acquisitions_per_month = s1_acq + s2_acq
        scene_size_gb = round((s1_size + s2_size) / 2, 3)
    elif is_s1:
        acquisitions_per_month = 2.5
        scene_size_gb = 0.615
        total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
        scene_count = int(tile_count * acquisitions_per_month * months)
    else:
        acquisitions_per_month = 6.0
        scene_size_gb = 0.270
        total_gb = tile_count * acquisitions_per_month * months * scene_size_gb
        scene_count = int(tile_count * acquisitions_per_month * months)

    total_gb = round(total_gb, 2)

    will_require_approval = total_gb > APPROVAL_THRESHOLD_GB
    will_be_rejected = total_gb > MAX_TOTAL_STORAGE_GB

    if will_be_rejected:
        status_hint = "REJECTED"
    elif will_require_approval:
        status_hint = "HOLD_FOR_APPROVAL"
    else:
        status_hint = "ACCEPTED"

    # Calculate realistic pipeline execution duration in minutes
    step1_mins = max(2, round(1.5 + (tile_count * 0.3) + (months * 0.4)))
    if is_s1 and is_s2:
        step2_mins = max(5, round((scene_count * 0.4 * 4.0) + (scene_count * 0.6 * 1.8)))
    elif is_s1:
        step2_mins = max(5, round(scene_count * 4.0))
    else:
        step2_mins = max(5, round(scene_count * 1.8))

    num_indices = len(getattr(req, "indices", []) or []) or 2
    if is_s1 and not is_s2:
        step3_mins = round(scene_count * 4.8)
    elif is_s1 and is_s2:
        step3_mins = round((scene_count * 0.4 * 4.8) + (scene_count * 0.6 * 0.85 * (num_indices / 2.0)))
    else:
        step3_mins = round(scene_count * 0.85 * (num_indices / 2.0))

    comp_interval = (getattr(req, "composite_interval", "monthly") or "monthly").lower()
    if comp_interval == "weekly":
        comp_windows = max(1, math.ceil(days / 7))
    elif comp_interval == "fortnightly":
        comp_windows = max(1, math.ceil(days / 15))
    elif comp_interval == "monthly":
        comp_windows = max(1, math.ceil(days / 30))
    else:
        comp_windows = 0
    step4_mins = round(comp_windows * max(1, num_indices) * 3.2) if comp_windows else 0

    total_duration_mins = step1_mins + step2_mins + step3_mins + step4_mins
    if total_duration_mins < 60:
        duration_text = f"~{total_duration_mins} mins"
    else:
        hrs = total_duration_mins // 60
        rem = total_duration_mins % 60
        if rem == 0:
            duration_text = f"~{hrs} hrs ({total_duration_mins} mins)"
        else:
            duration_text = f"~{hrs} hrs {rem} mins ({total_duration_mins} mins)"

    return {
        "tile_count": tile_count,
        "acquisitions_per_month": acquisitions_per_month,
        "scene_size_gb": scene_size_gb,
        "date_span_days": days,
        "estimated_total_gb": total_gb,
        "estimated_scene_count": scene_count,
        "estimated_duration_mins": total_duration_mins,
        "estimated_duration_text": duration_text,
        "will_require_approval": will_require_approval,
        "will_be_rejected": will_be_rejected,
        "approval_threshold_gb": APPROVAL_THRESHOLD_GB,
        "rejection_threshold_gb": MAX_TOTAL_STORAGE_GB,
        "status_hint": status_hint,
    }


def run_pipeline_background(request_id: int):
    """Executes the pipeline on a worker thread so the API returns immediately."""
    db = SessionLocal()
    try:
        req = db.query(RequestModel).filter(RequestModel.id == request_id).first()
        if not req or req.status == "STOPPED":
            return
        req.status = "PROCESSING"
        db.commit()

        district_name = req.district or req.state
        if not district_name:
            raise ValueError(f"Request #{request_id} does not specify a valid district or state.")
        start_str = req.start_date.strftime("%Y-%m-%d")
        end_str = req.end_date.strftime("%Y-%m-%d")
        indices = req.indices if isinstance(req.indices, list) else ["NDVI", "LSWI"]

        max_cloud_cover = float(getattr(req, "max_cloud_cover", 100.0) or 100.0)
        req_level = (getattr(req, "level", "max") or "max").lower().strip()

        from app.db.scripts.download_district_tiles import run_district_acquisition_pipeline
        ok = run_district_acquisition_pipeline(
            district_name=district_name,
            start_date=start_str,
            end_date=end_str,
            satellite=req.satellite,
            indices=indices,
            request_id=req.id,
            max_cloud_cover=max_cloud_cover,
            composite_interval=req.composite_interval or "none",
            level=req_level
        )
        db.refresh(req)
        # Only overwrite status if user didn't stop it during execution
        if req.status != "STOPPED":
            req.status = "COMPLETED" if ok else "FAILED"
            db.commit()
    except Exception as e:
        logger.error(f"Error running pipeline for request {request_id}: {e}", exc_info=True)
        try:
            db.close()
        except Exception:
            pass
        fail_db = None
        try:
            fail_db = SessionLocal()
            from app.db.scripts.download_district_tiles import append_request_log
            append_request_log(fail_db, request_id, f"\n[ERROR] Pipeline crashed unexpectedly: {e}", level="ERROR")
            f_req = fail_db.query(RequestModel).filter(RequestModel.id == request_id).first()
            if f_req and f_req.status != "STOPPED":
                f_req.status = "FAILED"
                fail_db.commit()
        except Exception as ex2:
            logger.error(f"Could not record pipeline failure state for request #{request_id}: {ex2}")
        finally:
            if fail_db is not None:
                try:
                    fail_db.close()
                except Exception:
                    pass
    finally:
        try:
            db.close()
        except Exception:
            pass
        # New deliverables may exist now; drop cached NAS listings for this request
        invalidate_request_disk_cache(request_id)


def build_request_response(
    req: RequestModel,
    include_logs: bool = True,
    stack_info: Optional[Dict[str, Any]] = None,
    db: Optional[Session] = None
) -> RequestResponse:
    """Helper to attach user metadata and multi-band layer stacking details to request response."""
    from app.services.stacker_service import get_layer_stacks_for_request

    if stack_info is None:
        try:
            stack_info = get_layer_stacks_for_request(req, db=db)
        except Exception:
            stack_info = {"count": 0, "status": "NOT_STARTED", "files": []}

    stk_cnt = stack_info.get("count", 0)
    stk_status = stack_info.get("status", "NOT_STARTED")
    stk_files = stack_info.get("files", [])

    exec_logs = None
    if include_logs:
        exec_logs = req.execution_logs[-LOG_RESPONSE_CAP:] if req.execution_logs else None

    return RequestResponse(
        id=req.id,
        user_id=req.user_id,
        user_email=req.user.email if req.user else None,
        user_full_name=req.user.full_name if req.user else None,
        request_title=req.request_title,
        area_type=req.area_type,
        state=req.state,
        district=req.district,
        season=req.season,
        start_date=req.start_date,
        end_date=req.end_date,
        satellite=req.satellite,
        bands=req.bands,
        indices=req.indices,
        composite_interval=req.composite_interval,
        max_cloud_cover=getattr(req, "max_cloud_cover", 20) or 20,
        level=getattr(req, "level", "max") or "max",
        status=req.status,
        storage_estimated_gb=req.storage_estimated_gb,
        execution_logs=exec_logs,
        created_at=req.created_at,
        stacking_count=stk_cnt,
        stacking_status=stk_status,
        stacked_files=stk_files
    )


def _count_requests_today(db: Session, user_id: int) -> int:
    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return db.query(func.count(RequestModel.id)).filter(
        RequestModel.user_id == user_id,
        RequestModel.created_at >= today_start
    ).scalar() or 0


def _lock_user_quota(db: Session, user_id: int) -> None:
    """Serialize quota check + insert per user for the rest of the current transaction."""
    try:
        dialect = db.get_bind().dialect.name
    except Exception:
        dialect = ""
    if dialect == "postgresql":
        db.execute(
            text("SELECT pg_advisory_xact_lock(:ns, :uid)"),
            {"ns": _QUOTA_LOCK_NAMESPACE, "uid": int(user_id)}
        )
    else:
        db.query(UserModel.id).filter(UserModel.id == user_id).with_for_update().first()


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/estimate", response_model=RequestEstimateResponse, summary="Estimate storage & scenes before submitting (SRS 8.3)")
def estimate_request(
    state: Optional[str] = Query(None),
    district: Optional[str] = Query(None),
    satellite: str = Query("Sentinel-2"),
    start_date: str = Query(..., description="YYYY-MM-DD"),
    end_date: str = Query(..., description="YYYY-MM-DD"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns a storage and scene estimate WITHOUT creating any record.
    This powers the pre-submit confirmation modal (SRS 8.3: show estimate always).
    """
    try:
        start_dt = datetime.strptime(start_date, "%Y-%m-%d")
        end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="Dates must be in YYYY-MM-DD format.")

    if end_dt < start_dt:
        raise HTTPException(status_code=422, detail="end_date must be >= start_date.")

    parts = [p.strip() for p in satellite.replace("+", ",").replace("&", ",").split(",") if p.strip()]
    if not parts or not all(p in {"Sentinel-1", "Sentinel-2"} for p in parts):
        raise HTTPException(status_code=422, detail="satellite must be 'Sentinel-1', 'Sentinel-2', or both.")
    clean_sat = ", ".join(sorted(list(set(parts))))

    class _Req:
        pass
    r = _Req()
    r.state = state
    r.district = district
    r.satellite = clean_sat
    r.start_date = start_dt
    r.end_date = end_dt

    est = estimate_request_storage(r, db)

    return RequestEstimateResponse(
        state=state,
        district=district,
        satellite=clean_sat,
        start_date=start_dt,
        end_date=end_dt,
        **est
    )


@router.get("/daily-quota", summary="Get remaining request quota for the current user today")
def get_daily_quota(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns today's request usage and remaining quota for the logged-in user (limit: 3 requests/day).
    """
    count = _count_requests_today(db, current_user.id)
    is_admin = _is_admin(current_user)
    remaining = max(0, MAX_DAILY_REQUESTS - count) if not is_admin else ADMIN_DAILY_LIMIT_DISPLAY
    return {
        "user_id": current_user.id,
        "is_admin": is_admin,
        "daily_limit": MAX_DAILY_REQUESTS if not is_admin else ADMIN_DAILY_LIMIT_DISPLAY,
        "used_today": count,
        "remaining_today": remaining,
        "limit_reached": (count >= MAX_DAILY_REQUESTS and not is_admin)
    }


@router.post("/", response_model=RequestResponse, status_code=status.HTTP_201_CREATED, summary="Submit Satellite Processing Request (M1)")
def create_request(
    req_in: RequestCreate,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Submit a satellite acquisition request (SRS M1).
    Associates the request with the logged-in user, estimates storage dynamically,
    applies SRS 8.3 acceptance rules, and triggers pipeline execution for ACCEPTED jobs.
    """
    # ── Daily Request Rate Limit: Max 3 requests per user per calendar day ──
    # The per-user transaction lock is held until the commit below (or rollback on error),
    # so concurrent submits from the same user cannot both pass the count check.
    if not _is_admin(current_user):
        _lock_user_quota(db, current_user.id)
        user_daily_requests_count = _count_requests_today(db, current_user.id)
        if user_daily_requests_count >= MAX_DAILY_REQUESTS:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=(
                    f"Daily request limit reached: A user can submit a maximum of {MAX_DAILY_REQUESTS} requests per day. "
                    f"You have already submitted {user_daily_requests_count} request(s) today. Please try again tomorrow."
                )
            )

    est = estimate_request_storage(req_in, db)

    if est["will_be_rejected"]:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                f"Request rejected: estimated storage ({est['estimated_total_gb']} GB) exceeds "
                f"the platform's total usable storage ({MAX_TOTAL_STORAGE_GB:,.0f} GB). "
                "Please reduce the date range or area."
            )
        )

    req_status = est["status_hint"]

    comp_interval = (req_in.composite_interval or "none").lower().strip()
    is_pure_s1 = "Sentinel-1" in req_in.satellite and "Sentinel-2" not in req_in.satellite
    if is_pure_s1 and comp_interval in ("weekly", "monthly"):
        comp_interval = "fortnightly"

    db_req = RequestModel(
        user_id=current_user.id,
        request_title=req_in.request_title,
        area_type=req_in.area_type,
        state=req_in.state,
        district=req_in.district,
        season=req_in.season,
        start_date=req_in.start_date,
        end_date=req_in.end_date,
        satellite=req_in.satellite,
        bands=req_in.bands,
        indices=req_in.indices,
        composite_interval=comp_interval,
        max_cloud_cover=getattr(req_in, "max_cloud_cover", 100.0) or 100.0,
        level=(getattr(req_in, "level", "max") or "max").lower().strip(),
        status=req_status,
        storage_estimated_gb=est["estimated_total_gb"]
    )

    db.add(db_req)
    db.flush()  # assigns db_req.id inside the same (locked) transaction

    db.add(ProcessJobModel(
        request_id=db_req.id,
        stage="GAP_CHECK",
        status="QUEUED"
    ))
    db.commit()  # releases the quota lock
    db.refresh(db_req)

    if db_req.status == "ACCEPTED":
        trigger_pipeline_in_thread(db_req.id)

    return build_request_response(db_req, db=db)


@router.get("/", response_model=List[RequestResponse], summary="List Requests (Scoped by User Role)")
def list_requests(
    skip: int = 0,
    limit: int = 100,
    scope: Optional[str] = Query(None, description="'mine' to return only current user's requests"),
    user_id: Optional[int] = Query(None, description="Filter requests by user ID (Admin only)"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Retrieve satellite acquisition requests.
    - Standard USER: always sees ONLY their own submitted requests.
    - ADMIN:
      - if scope == 'mine': sees only their own requests.
      - if user_id is provided: sees only that user's requests.
      - otherwise: sees all requests.
    """
    query = db.query(RequestModel).options(
        joinedload(RequestModel.user),
        defer(RequestModel.execution_logs)
    )
    is_admin = _is_admin(current_user)
    if not is_admin or scope == "mine":
        query = query.filter(RequestModel.user_id == current_user.id)
    elif user_id is not None:
        query = query.filter(RequestModel.user_id == user_id)

    requests_list = query.order_by(RequestModel.id.desc()).offset(skip).limit(limit).all()
    from app.services.stacker_service import get_layer_stacks_for_requests_bulk
    bulk_stack_info = get_layer_stacks_for_requests_bulk(requests_list, db=db)
    return [build_request_response(r, include_logs=False, stack_info=bulk_stack_info.get(r.id), db=db) for r in requests_list]


@router.get("/by-district/{district_name}", summary="Get requests for a specific district")
def get_requests_by_district(
    district_name: str,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns requests matching a district name so both Admin and standard Users
    can discover acquisition jobs for layer stacking and data retrieval.
    """
    from app.services.stacker_service import get_layer_stacks_for_requests_bulk
    reqs = db.query(RequestModel).options(
        joinedload(RequestModel.user),          # avoid per-row lazy user loads
        defer(RequestModel.execution_logs)      # logs are never returned here
    ).filter(
        func.lower(RequestModel.district) == district_name.strip().lower()
    ).order_by(RequestModel.id.desc()).all()
    bulk_stack_info = get_layer_stacks_for_requests_bulk(reqs, db=db)
    return [build_request_response(r, include_logs=False, stack_info=bulk_stack_info.get(r.id), db=db) for r in reqs]


@router.get("/{request_id}", response_model=RequestResponse, summary="Get Request by ID")
def get_request(
    request_id: int,
    include_logs: bool = Query(True, description="Set false to omit execution_logs (use /{request_id}/logs for incremental tailing)"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """Retrieve details (and, by default, the last 200,000 chars of execution logs) for a request."""
    req = get_owned_request_or_403(db, request_id, current_user, include_logs=include_logs)
    return build_request_response(req, include_logs=include_logs, db=db)


@router.get("/{request_id}/logs", summary="Incrementally tail a request's execution logs")
def get_request_logs(
    request_id: int,
    offset: int = Query(0, ge=0, description="Number of log characters the client already has"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Cheap log polling. Only `status`, `user_id` and `length(execution_logs)` are read first;
    the log text itself is fetched with SQL substr() only when there is something new.

    Response: {status, length, offset, start, chunk, reset}
      - length: total characters in execution_logs now
      - offset: echo of the requested offset
      - start:  absolute position of chunk[0] in the full log
      - chunk:  execution_logs[start:length]   ("" when offset == length)
      - reset:  true when the client buffer must be REPLACED by chunk instead of appended to
                (offset > length, i.e. log shrank/was rewritten, or the backlog exceeded the
                200,000-char window and only the tail is sent).
    Client: buffer = reset ? chunk : buffer + chunk; next offset = length.
    """
    row = db.query(
        RequestModel.user_id,
        RequestModel.status,
        func.coalesce(func.length(RequestModel.execution_logs), 0),
    ).filter(RequestModel.id == request_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    owner_id, req_status, total_len = row
    _assert_owner_or_admin(owner_id, current_user)
    total_len = int(total_len or 0)

    start = 0 if offset > total_len else offset
    if total_len - start > LOG_RESPONSE_CAP:
        start = total_len - LOG_RESPONSE_CAP  # same tail window as the legacy execution_logs field
    reset = start != offset

    chunk = ""
    if start < total_len:
        # Bounded to the measured length so concurrent appends are picked up next poll, not duplicated
        chunk = db.query(
            func.substr(RequestModel.execution_logs, start + 1, total_len - start)
        ).filter(RequestModel.id == request_id).scalar() or ""

    return {
        "status": req_status,
        "length": total_len,
        "offset": offset,
        "start": start,
        "chunk": chunk,
        "reset": reset,
    }


@router.patch("/{request_id}/status", response_model=RequestResponse, summary="Approve / Update Request Status (Admin Only)")
def update_request_status(
    request_id: int,
    status_value: str,
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint to approve requests (e.g., from HOLD_FOR_APPROVAL → ACCEPTED).
    If approved to ACCEPTED, automatically triggers the background pipeline.
    """
    new_status = (status_value or "").strip().upper()
    if new_status not in ALLOWED_REQUEST_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid status '{status_value}'. Allowed: {', '.join(sorted(ALLOWED_REQUEST_STATUSES))}."
        )

    db_req = db.query(RequestModel).options(joinedload(RequestModel.user)).filter(RequestModel.id == request_id).first()
    if not db_req:
        raise HTTPException(status_code=404, detail="Request not found.")

    db_req.status = new_status
    db.commit()
    db.refresh(db_req)

    if new_status == "ACCEPTED":
        trigger_pipeline_in_thread(db_req.id)

    return build_request_response(db_req, db=db)


@router.post("/{request_id}/stop", summary="Stop / Cancel Running Request Pipeline")
def stop_request_pipeline(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Stops a running or accepted request pipeline immediately.
    Sets request status to 'STOPPED', marks active jobs as 'STOPPED',
    and signals the background worker to halt execution.
    """
    req = get_owned_request_or_403(db, request_id, current_user, action="stop", include_logs=False)

    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    stop_entry = f"[{timestamp}] WARNING:sdap.universal_pipeline:--- PIPELINE EXECUTION STOPPED BY USER ---\n"
    _append_log_and_set_status(db, request_id, stop_entry, "STOPPED")

    now = datetime.utcnow()
    db.query(ProcessJobModel).filter(
        ProcessJobModel.request_id == request_id,
        ProcessJobModel.status.in_(["RUNNING", "QUEUED"])
    ).update(
        {
            ProcessJobModel.status: "STOPPED",
            ProcessJobModel.error_log: "Execution stopped by user",
            ProcessJobModel.updated_at: now,
        },
        synchronize_session=False,
    )

    db.commit()
    db.refresh(req)
    return build_request_response(req, db=db)


@router.post("/{request_id}/rerun", summary="Rerun / Retry Satellite Acquisition Request")
def rerun_request_pipeline(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Reruns/retries an existing satellite acquisition request.
    Appends retry initiation log and triggers background pipeline.
    Non-admins cannot rerun requests that are on HOLD_FOR_APPROVAL or REJECTED.
    """
    req = get_owned_request_or_403(db, request_id, current_user, action="rerun", include_logs=False)
    _assert_pipeline_start_allowed(req, current_user)

    timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    retry_log = f"[{timestamp}] INFO:sdap.pipeline:--- USER TRIGGERED RE-RUN / RETRY FOR REQUEST #{req.id} ---\n"
    _append_log_and_set_status(db, request_id, retry_log, "PROCESSING")
    db.commit()

    invalidate_request_disk_cache(request_id)
    trigger_pipeline_in_thread(request_id)
    return build_request_response(req, db=db)


@router.post("/{request_id}/process", summary="Manual pipeline trigger (for testing)")
def process_request_pipeline(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Manually triggers the end-to-end SDAP pipeline for a specific request.
    Non-admins cannot trigger requests that are on HOLD_FOR_APPROVAL or REJECTED.
    """
    req = get_owned_request_or_403(db, request_id, current_user, action="process", include_logs=False)
    _assert_pipeline_start_allowed(req, current_user)

    req.status = "PROCESSING"
    db.commit()

    invalidate_request_disk_cache(request_id)
    trigger_pipeline_in_thread(request_id)
    return {"request_id": req.id, "status": req.status, "message": f"Pipeline triggered for request #{req.id}."}


@router.get("/{request_id}/tifs", summary="Retrieve all downloaded GeoTIFF file paths for a request")
def get_request_tifs(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns all verified GeoTIFF raster file paths (.tif / .tiff) downloaded for a specific request.

    Intentionally readable by any authenticated user (like /by-district and /tifs/retrieve, which
    already expose the same region rasters): the Layer Stacking studio discovers other users'
    requests per district and loads their rasters through this endpoint.
    Results are cached for a few seconds per request to avoid repeated NAS walks while polling.
    """
    row = db.query(RequestModel.status).filter(RequestModel.id == request_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found.")

    cached = _cache_get(_tifs_cache, request_id)
    if cached is not None:
        return cached

    from app.services.downloader_service import get_downloaded_tifs_for_request
    result = get_downloaded_tifs_for_request(db, request_id)
    finished = str(row[0] or "").upper() in _TERMINAL_STATUSES
    _cache_put(_tifs_cache, request_id, result, _FINISHED_CACHE_TTL_SEC if finished else _DISK_CACHE_TTL_SEC)
    return result


def _request_composite_params(db: Session, request_id: int) -> Tuple[str, str, str]:
    """(district_name, interval, year_str) for a request, selecting only the needed columns."""
    row = db.query(
        RequestModel.district, RequestModel.state, RequestModel.composite_interval, RequestModel.start_date
    ).filter(RequestModel.id == request_id).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Request not found.")
    district, state_name, interval, start_date = row
    district_name = district or state_name or "Region"
    interval = interval or "none"
    year_str = start_date.strftime("%Y") if start_date else "2026"
    return district_name, interval, year_str


def _classify_composite_index(f: str) -> str:
    f_u = f.upper()
    if "VV_VH" in f_u:
        return "VV_VH"
    if "_VV_" in f_u or f_u.startswith("COMPOSITE_VV_"):
        return "VV"
    if "_VH_" in f_u or f_u.startswith("COMPOSITE_VH_"):
        return "VH"
    if "LSWI" in f_u:
        return "LSWI"
    if "NDVI" in f_u:
        return "NDVI"
    return "INDEX"


def _scan_request_composites(request_id: int, district_name: str, interval: str, year_str: str) -> List[Dict[str, Any]]:
    search_dirs = [
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, year_str, interval.lower()),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, interval.lower()),
        os.path.join(settings.DELIVERY_DIR, f"request_{request_id}")
    ]

    composites: List[Dict[str, Any]] = []
    seen = set()

    def _add_comp_file(f: str, full_p: str):
        if full_p in seen:
            return
        seen.add(full_p)
        try:
            size_mb = os.path.getsize(full_p) / (1024 * 1024)
        except Exception:
            size_mb = 0.0
        f_l = f.lower()
        if interval != "none":
            inferred_interval = interval
        elif "weekly" in f_l:
            inferred_interval = "weekly"
        elif "fortnightly" in f_l:
            inferred_interval = "fortnightly"
        elif "monthly" in f_l:
            inferred_interval = "monthly"
        else:
            inferred_interval = "none"
        composites.append({
            "filename": f,
            "path": full_p,
            "size_mb": round(size_mb, 2),
            "composite_interval": inferred_interval,
            "district": district_name,
            "index": _classify_composite_index(f),
            "download_url": f"/api/v1/requests/{request_id}/composites/download?filename={f}"
        })

    for s_dir in search_dirs:
        if os.path.isdir(s_dir):
            try:
                for entry in os.scandir(s_dir):
                    if entry.is_file() and entry.name.lower().endswith((".tif", ".tiff")):
                        _add_comp_file(entry.name, entry.path)
            except Exception:
                pass

    if not composites:
        parent_dir = os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name)
        if os.path.isdir(parent_dir):
            try:
                for root, dirs, files in os.walk(parent_dir):
                    if "stack" in root.lower():
                        continue
                    for f in files:
                        if f.lower().endswith((".tif", ".tiff")):
                            _add_comp_file(f, os.path.join(root, f))
            except Exception:
                pass

    return composites


@router.get("/{request_id}/composites", summary="List all generated composite GeoTIFFs for a request")
def get_request_composites(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Returns all temporal composite GeoTIFF deliverables (weekly, fortnightly, monthly)
    generated for a specific request.

    Readable by any authenticated user (see /{request_id}/tifs). Cached briefly per request.
    """
    district_name, interval, year_str = _request_composite_params(db, request_id)

    cached = _cache_get(_composites_cache, request_id)
    if cached is not None:
        return cached

    composites = _scan_request_composites(request_id, district_name, interval, year_str)
    result = {
        "request_id": request_id,
        "district": district_name,
        "composite_interval": interval,
        "total_composites": len(composites),
        "composites": composites
    }
    _cache_put(_composites_cache, request_id, result)
    return result


@router.get("/{request_id}/stack-logs", summary="Get layer stacking execution jobs and logs for a request")
def get_request_stack_logs(
    request_id: int,
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Retrieves all layer stacking jobs, live statuses, progress percentages,
    and execution logs for a specific user request (owner or ADMIN only).
    """
    from app.services.stacker_service import STACK_JOBS, STACK_JOBS_LOCK
    from app.db.models import LayerStackJobModel

    _assert_owner_by_id(db, request_id, current_user)

    jobs = db.query(LayerStackJobModel).filter(
        LayerStackJobModel.request_id == request_id
    ).order_by(LayerStackJobModel.id.desc()).all()

    # Snapshot live in-memory state once instead of taking the lock per job
    task_ids = {j.task_id for j in jobs}
    with STACK_JOBS_LOCK:
        live_jobs = {tid: STACK_JOBS.get(tid) for tid in task_ids}

    results = []
    for j in jobs:
        live_job = live_jobs.get(j.task_id)

        job_status = live_job["status"] if live_job else j.status
        progress = live_job["progress"] if live_job else j.progress
        step = live_job["step"] if live_job else j.step
        logs = live_job["logs"] if live_job and live_job.get("logs") else (j.logs_json or [])
        exec_logs = (live_job.get("execution_logs") if live_job else None) or j.execution_logs or ""

        results.append({
            "task_id": j.task_id,
            "request_id": j.request_id,
            "status": job_status,
            "progress": progress,
            "step": step,
            "district": j.district,
            "state": j.state,
            "season": j.season,
            "layers": j.layers or [],
            "filename": j.filename,
            "output_path": j.output_path,
            "file_size_mb": j.file_size_mb,
            "total_bands": j.total_bands,
            "created_at": j.created_at.isoformat() if j.created_at else None,
            "updated_at": j.updated_at.isoformat() if j.updated_at else None,
            "error": live_job.get("error") if live_job else j.error,
            "logs": logs,
            "execution_logs": exec_logs
        })

    return {
        "request_id": request_id,
        "total_jobs": len(results),
        "jobs": results
    }


def _real(p: str) -> str:
    return os.path.normcase(os.path.realpath(p))


def _is_within(path: str, root: str) -> bool:
    """True if normalized real `path` is `root` or inside it (both already passed through _real)."""
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives / mix of absolute & relative
        return False


@router.get("/{request_id}/composites/download", summary="Download a single composite GeoTIFF file directly")
def download_request_composite(
    request_id: int,
    filename: Optional[str] = Query(None, description="Filename of specific composite to download"),
    token: Optional[str] = Query(None, description="Optional JWT authentication token"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Downloads a single composite GeoTIFF raster directly (e.g. Composite_NDVI_weekly_Ganjam_20260901_20260905.tif).

    `filename` is reduced to its basename and the resolved real path must stay inside one of this
    request's composite directories (which themselves must sit under RAW_ARCHIVE_DIR/Composites or
    DELIVERY_DIR); otherwise 403/404.
    """
    district_name, interval, year_str = _request_composite_params(db, request_id)

    allowed_roots = [
        _real(os.path.join(settings.RAW_ARCHIVE_DIR, "Composites")),
        _real(settings.DELIVERY_DIR),
    ]
    candidate_dirs = [
        os.path.join(settings.DELIVERY_DIR, f"request_{request_id}"),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, year_str, interval.lower()),
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name),
        # Also listed by /composites; previously its files could not be downloaded by name
        os.path.join(settings.RAW_ARCHIVE_DIR, "Composites", district_name, interval.lower()),
    ]
    search_dirs = []
    for d in candidate_dirs:
        rd = _real(d)
        if rd not in search_dirs and any(_is_within(rd, root) for root in allowed_roots) and os.path.isdir(rd):
            search_dirs.append(rd)

    not_found = HTTPException(status_code=404, detail=f"Composite raster file not found for request #{request_id}.")
    target_file = None
    forbidden = False

    if filename:
        safe_name = os.path.basename(filename.replace("\\", "/")).strip()
        if not safe_name or safe_name in (".", "..") or not safe_name.lower().endswith((".tif", ".tiff")):
            raise not_found
        for s_dir in search_dirs:
            cand = _real(os.path.join(s_dir, safe_name))
            if not _is_within(cand, s_dir):
                forbidden = True  # e.g. symlink pointing outside the composite directory
                continue
            if os.path.isfile(cand):
                target_file = cand
                break
    else:
        for s_dir in search_dirs:
            try:
                names = os.listdir(s_dir)
            except OSError:
                continue
            for f in names:
                if f.endswith(".tif") or f.endswith(".tiff"):
                    cand = _real(os.path.join(s_dir, f))
                    if _is_within(cand, s_dir) and os.path.isfile(cand):
                        target_file = cand
                        break
            if target_file:
                break

    if not target_file:
        if forbidden:
            raise HTTPException(status_code=403, detail="Access to the requested file is not allowed.")
        raise not_found

    return FileResponse(
        path=target_file,
        filename=os.path.basename(target_file),
        media_type="image/tiff"
    )


@router.get("/admin/daily-storage", summary="Admin Daily Storage Overview")
def get_admin_daily_storage(
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    db: Session = Depends(get_db),
    admin: UserModel = Depends(get_current_admin)
):
    """
    Admin-only endpoint returning daily storage occupancy and request volume metrics.
    """
    from app.services.analytics_service import get_daily_storage_analytics
    return get_daily_storage_analytics(db=db, start_date=start_date, end_date=end_date)


# Incorporates rasters endpoints (/tifs/...) and layer stacking endpoints (/layer-stack/...)
# directly under the /requests router namespace to preserve 100% backward compatibility.
router.include_router(rasters_router)
router.include_router(layer_stack_router)
