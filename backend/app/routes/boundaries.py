"""
=============================================================================
SDAP Administrative Boundaries API Routes
=============================================================================
Location: backend/app/routes/boundaries.py

Description:
    Exposes endpoints to query official State and District boundaries directly
    from PostgreSQL tables ('state_boundaries' and 'district_boundaries') using
    the centralized BoundaryRepository.
=============================================================================
"""

from typing import List, Optional, Dict, Any
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.db import get_db
from app.db.repositories import BoundaryRepository
from app.core.security import get_current_user
from app.db.models import UserModel

router = APIRouter()


@router.get("/states", response_model=List[Dict[str, Any]])
def get_all_states(
    db: Session = Depends(get_db),
    current_user: UserModel = Depends(get_current_user)
):
    """
    Fetch all unique states/UTs from PostgreSQL 'state_boundaries' or 'district_boundaries'.
    """
    return BoundaryRepository.get_all_states(db)


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
    return BoundaryRepository.get_districts(db, state_name=state_name)
