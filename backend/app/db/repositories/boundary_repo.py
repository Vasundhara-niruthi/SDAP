"""
=============================================================================
SDAP Boundary Repository (Reusable Database Queries)
=============================================================================
Location: backend/app/db/repositories/boundary_repo.py

Description:
    Reusable database queries for querying State and District boundaries,
    spatial geometries, and administrative lookup without duplicated SQL.
=============================================================================
"""

import json
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from sqlalchemy import text


class BoundaryRepository:
    """Repository for querying administrative boundary records and geometries."""

    @staticmethod
    def get_all_states(db: Session) -> List[Dict[str, str]]:
        """Fetch all unique states/UTs from state_boundaries or district_boundaries."""
        results = db.execute(
            text("SELECT DISTINCT state_name FROM state_boundaries WHERE state_name IS NOT NULL ORDER BY state_name;")
        ).fetchall()

        if not results:
            results = db.execute(
                text("SELECT DISTINCT state_name FROM district_boundaries WHERE state_name IS NOT NULL ORDER BY state_name;")
            ).fetchall()

        return [{"state_name": row[0]} for row in results]

    @staticmethod
    def get_districts(db: Session, state_name: Optional[str] = None) -> List[Dict[str, str]]:
        """Fetch unique districts, optionally filtered by state."""
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

        return [{"district_name": row[0], "state_name": row[1]} for row in results]

    @staticmethod
    def get_district_geojson(db: Session, district_name: str, state_name: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Fetch GeoJSON geometry for a given district."""
        if state_name:
            query = text("""
                SELECT ST_AsGeoJSON(geometry) 
                FROM district_boundaries 
                WHERE LOWER(district_name) = LOWER(:district_name) 
                  AND LOWER(state_name) = LOWER(:state_name) 
                LIMIT 1;
            """)
            params = {"district_name": district_name, "state_name": state_name}
        else:
            query = text("""
                SELECT ST_AsGeoJSON(geometry) 
                FROM district_boundaries 
                WHERE LOWER(district_name) = LOWER(:district_name) 
                LIMIT 1;
            """)
            params = {"district_name": district_name}

        result = db.execute(query, params).fetchone()
        if result and result[0]:
            return json.loads(result[0])
        return None

