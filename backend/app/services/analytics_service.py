import logging
from typing import Dict, Any, Optional, List
from datetime import datetime, date
from sqlalchemy.orm import Session
from sqlalchemy import func

from app.models.sdap_models import RequestModel, BandFileModel, UserModel

logger = logging.getLogger("sdap.analytics")


def get_daily_storage_analytics(
    db: Session,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
) -> Dict[str, Any]:
    """
    Computes comprehensive daily storage metrics across all satellite acquisition requests
    and actual downloaded rasters. Restricted to Administrator access.
    
    Returns:
      - summary: Aggregate KPIs (total requests, total GB, peak day, daily average).
      - status_breakdown: Storage occupied by each request status.
      - satellite_breakdown: Storage occupied by Sentinel-2 vs Sentinel-1.
      - timeline: Day-by-day chronological breakdown of storage, requests, and files.
    """
    # 1. Base query for requests with optional date filters
    req_query = db.query(
        func.date(RequestModel.created_at).label("day"),
        RequestModel.id,
        RequestModel.request_title,
        RequestModel.user_id,
        RequestModel.district,
        RequestModel.state,
        RequestModel.satellite,
        RequestModel.status,
        RequestModel.storage_estimated_gb,
        RequestModel.created_at,
        UserModel.email,
        UserModel.full_name
    ).outerjoin(UserModel, RequestModel.user_id == UserModel.id)

    if start_date:
        req_query = req_query.filter(func.date(RequestModel.created_at) >= start_date)
    if end_date:
        req_query = req_query.filter(func.date(RequestModel.created_at) <= end_date)

    req_rows = req_query.order_by(RequestModel.created_at.desc()).all()

    # 2. Query actual downloaded band files grouped by download date
    bf_query = db.query(
        func.date(BandFileModel.downloaded_at).label("day"),
        func.count(BandFileModel.id).label("file_count"),
        func.sum(BandFileModel.size_bytes).label("tot_bytes")
    )

    if start_date:
        bf_query = bf_query.filter(func.date(BandFileModel.downloaded_at) >= start_date)
    if end_date:
        bf_query = bf_query.filter(func.date(BandFileModel.downloaded_at) <= end_date)

    bf_rows = bf_query.group_by(func.date(BandFileModel.downloaded_at)).all()

    bf_dict = {
        str(r.day): {
            "count": int(r.file_count or 0),
            "gb": round(float(r.tot_bytes or 0) / (1024 ** 3), 2),
            "mb": round(float(r.tot_bytes or 0) / (1024 ** 2), 2)
        }
        for r in bf_rows if r.day
    }

    # 3. Assemble daily timeline
    timeline: Dict[str, Dict[str, Any]] = {}

    status_totals: Dict[str, float] = {}
    satellite_totals: Dict[str, float] = {}
    total_req_storage = 0.0

    for r in req_rows:
        d_str = str(r.day)
        if d_str not in timeline:
            timeline[d_str] = {
                "date": d_str,
                "request_count": 0,
                "request_storage_gb": 0.0,
                "physical_storage_gb": bf_dict.get(d_str, {}).get("gb", 0.0),
                "physical_files_count": bf_dict.get(d_str, {}).get("count", 0),
                "satellites": set(),
                "districts": set(),
                "requests": []
            }

        entry = timeline[d_str]
        entry["request_count"] += 1
        est_gb = float(r.storage_estimated_gb or 0.0)
        entry["request_storage_gb"] = round(entry["request_storage_gb"] + est_gb, 2)
        total_req_storage += est_gb

        sat = r.satellite or "Unknown"
        entry["satellites"].add(sat)
        satellite_totals[sat] = round(satellite_totals.get(sat, 0.0) + est_gb, 2)

        st_val = r.status or "SUBMITTED"
        status_totals[st_val] = round(status_totals.get(st_val, 0.0) + est_gb, 2)

        if r.district:
            entry["districts"].add(r.district)

        entry["requests"].append({
            "id": r.id,
            "title": r.request_title,
            "user_email": r.email,
            "user_name": r.full_name or r.email,
            "district": r.district,
            "state": r.state,
            "satellite": r.satellite,
            "status": r.status,
            "storage_gb": round(est_gb, 2),
            "created_at": r.created_at.strftime("%Y-%m-%d %H:%M") if r.created_at else ""
        })

    # Include days with band files even if no new request was submitted on that date
    for d_str, bf_data in bf_dict.items():
        if d_str not in timeline:
            timeline[d_str] = {
                "date": d_str,
                "request_count": 0,
                "request_storage_gb": 0.0,
                "physical_storage_gb": bf_data["gb"],
                "physical_files_count": bf_data["count"],
                "satellites": set(),
                "districts": set(),
                "requests": []
            }

    # Sort timeline chronologically descending (newest first)
    sorted_days = sorted(timeline.values(), key=lambda x: x["date"], reverse=True)

    # Compute running cumulative storage (ascending then reverse back)
    chronological = sorted(sorted_days, key=lambda x: x["date"])
    cum_req = 0.0
    cum_phys = 0.0
    for day in chronological:
        cum_req = round(cum_req + day["request_storage_gb"], 2)
        cum_phys = round(cum_phys + day["physical_storage_gb"], 2)
        day["cumulative_request_gb"] = cum_req
        day["cumulative_physical_gb"] = cum_phys
        day["satellites"] = sorted(list(day["satellites"]))
        day["districts"] = sorted(list(day["districts"]))

    # Summary KPIs
    total_physical_gb = sum(b["gb"] for b in bf_dict.values())
    total_files = sum(b["count"] for b in bf_dict.values())
    active_days_count = len(sorted_days)

    peak_day = None
    if sorted_days:
        peak_entry = max(sorted_days, key=lambda x: x["request_storage_gb"])
        peak_day = {
            "date": peak_entry["date"],
            "storage_gb": peak_entry["request_storage_gb"],
            "request_count": peak_entry["request_count"]
        }

    return {
        "summary": {
            "total_request_storage_gb": round(total_req_storage, 2),
            "total_physical_storage_gb": round(total_physical_gb, 2),
            "total_requests": len(req_rows),
            "total_files": total_files,
            "active_days_count": active_days_count,
            "avg_daily_storage_gb": round(total_req_storage / active_days_count, 2) if active_days_count > 0 else 0.0,
            "peak_day": peak_day
        },
        "status_breakdown": status_totals,
        "satellite_breakdown": satellite_totals,
        "daily_timeline": sorted_days
    }
