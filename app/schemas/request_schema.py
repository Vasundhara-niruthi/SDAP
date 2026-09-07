from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
from datetime import datetime


class RequestCreate(BaseModel):
    request_title: str = Field(..., min_length=3, max_length=200, example="Odisha Kharif Paddy Monitoring 2026")
    area_type: str = Field(..., example="Administrative Unit") # Administrative Unit, Uploaded Boundary, BBox
    state: Optional[str] = Field(None, example="Odisha")
    district: Optional[str] = Field(None, example="Cuttack")
    season: Optional[str] = Field(None, example="Kharif") # Kharif, Rabi, Zaid, Annual
    start_date: datetime = Field(..., example="2026-06-01T00:00:00Z")
    end_date: datetime = Field(..., example="2026-10-31T00:00:00Z")
    satellite: str = Field(..., example="Sentinel-2") # Sentinel-1, Sentinel-2
    bands: List[str] = Field(default=["B04", "B08", "B08A", "B11", "SCL"], example=["B04", "B08", "B08A", "B11", "SCL"])
    indices: List[str] = Field(default=["NDVI", "LSWI"], example=["NDVI", "LSWI"])
    composite_interval: Optional[str] = Field("none", example="fortnightly") # none, weekly, fortnightly, monthly
    priority: Optional[str] = Field("normal", example="high") # high, normal, low

    @field_validator("end_date")
    @classmethod
    def validate_date_span(cls, end_date: datetime, info):
        start_date = info.data.get("start_date")
        if start_date:
            if end_date < start_date:
                raise ValueError("End date must be equal to or after start date")
            delta_days = (end_date - start_date).days
            if delta_days > 365:
                raise ValueError(f"Date span ({delta_days} days) exceeds maximum allowed limit of 365 days")
        return end_date


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
    created_at: datetime

    class Config:
        from_attributes = True
