"""
=============================================================================
SDAP Request Repository (Reusable Database Queries)
=============================================================================
Location: backend/app/db/repositories/request_repo.py

Description:
    Reusable database queries for managing and fetching satellite acquisition
    requests, status queries, pagination, and user filtering.
=============================================================================
"""

from typing import List, Optional
from sqlalchemy.orm import Session
from sqlalchemy import desc

from app.db.models.sdap_models import RequestModel


class RequestRepository:
    """Repository encapsulating queries for the 'requests' table."""

    @staticmethod
    def get_by_id(db: Session, request_id: int) -> Optional[RequestModel]:
        """Retrieve a single request by its primary key ID."""
        return db.query(RequestModel).filter(RequestModel.id == request_id).first()

    @staticmethod
    def list_requests(
        db: Session,
        skip: int = 0,
        limit: int = 100,
        user_id: Optional[int] = None,
        status: Optional[str] = None
    ) -> List[RequestModel]:
        """Fetch a paginated list of requests, optionally filtered by user and status."""
        query = db.query(RequestModel)
        if user_id is not None:
            query = query.filter(RequestModel.user_id == user_id)
        if status:
            query = query.filter(RequestModel.status == status)
        return query.order_by(desc(RequestModel.created_at)).offset(skip).limit(limit).all()

    @staticmethod
    def count_requests(db: Session, user_id: Optional[int] = None, status: Optional[str] = None) -> int:
        """Count total matching requests."""
        query = db.query(RequestModel)
        if user_id is not None:
            query = query.filter(RequestModel.user_id == user_id)
        if status:
            query = query.filter(RequestModel.status == status)
        return query.count()

    @staticmethod
    def get_by_district(db: Session, district_name: str) -> List[RequestModel]:
        """Retrieve all requests for a given district name."""
        return db.query(RequestModel).filter(
            RequestModel.district.ilike(district_name)
        ).order_by(desc(RequestModel.created_at)).all()

