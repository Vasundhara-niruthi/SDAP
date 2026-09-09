"""
=============================================================================
SDAP Administrative Boundaries API Endpoints
=============================================================================
Location: backend/app/api/v1/endpoints/boundaries.py

Description:
    Exposes endpoints to query official State and District boundaries directly
    from PostgreSQL tables ('state_boundaries' and 'district_boundaries').
=============================================================================
"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import List, Optional, Dict, Any

from app.core.database import get_db
from app.core.security import get_current_user
from app.models.sdap_models import UserModel

router = APIRouter()


@router.get("/states", response_model=List[Dict[str, Any]])
def get_all_states(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Fetch all unique states/UTs from PostgreSQL 'state_boundaries' or 'district_boundaries'.
    """
    results = db.execute(
        text("SELECT DISTINCT state_name FROM state_boundaries WHERE state_name IS NOT NULL ORDER BY state_name;")
    ).fetchall()
    
    if not results:
        results = db.execute(
            text("SELECT DISTINCT state_name FROM district_boundaries WHERE state_name IS NOT NULL ORDER BY state_name;")
        ).fetchall()

    return [{"state_name": row[0]} for row in results]


@router.get("/districts", response_model=List[Dict[str, Any]])
def get_districts(
    state_name: Optional[str] = Query(None, description="Filter districts by state name"),
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Fetch unique district list from PostgreSQL 'district_boundaries'.
    If 'state_name' is provided, filters districts for that state.
    """
    if state_name:
        results = db.execute(
            text("""
                SELECT DISTINCT district_name, state_name 
                FROM district_boundaries 
                WHERE state_name = :state_name AND district_name IS NOT NULL 
                ORDER BY district_name;
            """),
            {"state_name": state_name}
        ).fetchall()
    else:
        results = db.execute(
            text("""
                SELECT DISTINCT district_name, state_name 
                FROM district_boundaries 
                WHERE district_name IS NOT NULL 
                ORDER BY state_name, district_name;
            """)
        ).fetchall()

    return [
        {
            "district_name": row[0],
            "state_name": row[1]
        }
        for row in results
    ]

