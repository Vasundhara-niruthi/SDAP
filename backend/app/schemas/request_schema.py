from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
from datetime import datetime, timezone

# Earliest date available from AWS Open Data (SRS Section 10)
AWS_ARCHIVE_START = datetime(2018, 12, 1, tzinfo=timezone.utc)
MAX_DATE_SPAN_DAYS = 365

VALID_SATELLITES = {"Sentinel-1", "Sentinel-2"}
VALID_SEASONS = {"Kharif", "Rabi", "Zaid", "Annual", None}
VALID_AREA_TYPES = {"Administrative Unit", "Uploaded Boundary", "BBox"}
VALID_COMPOSITE_INTERVALS = {"none", "weekly", "fortnightly", "monthly", "10-Day"}
VALID_PRIORITIES = {"high", "normal", "low", "High", "Standard", "Low"}


class RequestCreate(BaseModel):
    request_title: str = Field(..., min_length=3, max_length=200, example="Odisha Kharif Paddy Monitoring 2026")
    area_type: str = Field(..., example="Administrative Unit")  # Administrative Unit, Uploaded Boundary, BBox
    state: Optional[str] = Field(None, example="Odisha")
    district: Optional[str] = Field(None, example="Cuttack")
    season: Optional[str] = Field(None, example="Kharif")  # Kharif, Rabi, Zaid, Annual
    start_date: datetime = Field(..., example="2026-06-01T00:00:00Z")
    end_date: datetime = Field(..., example="2026-10-31T00:00:00Z")
    satellite: str = Field(..., example="Sentinel-2")  # Sentinel-1, Sentinel-2
    bands: List[str] = Field(default=["B04", "B08", "B08A", "B11", "SCL"], example=["B04", "B08", "B08A", "B11", "SCL"])
    indices: List[str] = Field(default=["NDVI", "LSWI"], example=["NDVI", "LSWI"])
    composite_interval: Optional[str] = Field("none", example="fortnightly")  # none, weekly, fortnightly, monthly
    priority: Optional[str] = Field("normal", example="high")  # high, normal, low
    delivery_outputs: Optional[List[str]] = Field(default=["clipped_images"], example=["clipped_images"])

    @field_validator("satellite")
    @classmethod
    def validate_satellite(cls, v: str) -> str:
        if v not in VALID_SATELLITES:
            raise ValueError(f"Satellite must be one of: {', '.join(sorted(VALID_SATELLITES))}. Got: '{v}'")
        return v

    @field_validator("start_date")
    @classmethod
    def validate_start_date(cls, v: datetime) -> datetime:
        # Make timezone-aware for comparison
        v_aware = v if v.tzinfo else v.replace(tzinfo=timezone.utc)
        if v_aware < AWS_ARCHIVE_START:
            raise ValueError(
                f"Start date ({v.date()}) is before the AWS Open Data archive depth "
                f"(December 2018). Earliest allowed date: 2018-12-01."
            )
        return v

    @field_validator("end_date")
    @classmethod
    def validate_date_span(cls, end_date: datetime, info) -> datetime:
        start_date = info.data.get("start_date")
        if start_date:
            if end_date < start_date:
                raise ValueError("End date must be equal to or after start date.")
            delta_days = (end_date - start_date).days
            if delta_days > MAX_DATE_SPAN_DAYS:
                raise ValueError(
                    f"Date span ({delta_days} days) exceeds the maximum allowed limit of "
                    f"{MAX_DATE_SPAN_DAYS} days (1 year). Please narrow your date range."
                )
        return end_date

    @field_validator("season")
    @classmethod
    def validate_season(cls, v: Optional[str]) -> Optional[str]:
        if v and v not in {"Kharif", "Rabi", "Zaid", "Annual"}:
            raise ValueError(f"Season must be one of: Kharif, Rabi, Zaid, Annual. Got: '{v}'")
        return v


class RequestEstimateResponse(BaseModel):
    """Returned by GET /requests/estimate — shown to user before they confirm submission."""
    state: Optional[str]
    district: Optional[str]
    satellite: str
    start_date: datetime
    end_date: datetime
    date_span_days: int
    tile_count: int
    acquisitions_per_month: float
    scene_size_gb: float
    estimated_total_gb: float
    estimated_scene_count: int
    will_require_approval: bool  # True if > 20% of max storage
    will_be_rejected: bool       # True if exceeds max storage
    approval_threshold_gb: float
    rejection_threshold_gb: float
    status_hint: str             # ACCEPTED / HOLD_FOR_APPROVAL / REJECTED


class RequestResponse(BaseModel):
    id: int
    user_id: Optional[int]
    user_email: Optional[str] = None
    user_full_name: Optional[str] = None
    request_title: str
    area_type: str
    state: Optional[str]
    district: Optional[str]
    season: Optional[str]
    start_date: datetime
    end_date: datetime
    satellite: str
    bands: Optional[List[str]]
    indices: Optional[List[str]]
    composite_interval: Optional[str]
    priority: Optional[str]
    status: str
    storage_estimated_gb: Optional[float]
    execution_logs: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True
