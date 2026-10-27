# 🗄️ SDAP Database Layer (`app/db/`)

Comprehensive, modular database architecture for the Satellite Data Acquisition & Processing (SDAP) platform.

---

## 📂 Architecture Overview

```
backend/app/db/
├── __init__.py           # Unified exports (engine, SessionLocal, Base, get_db, check_database_connection)
├── connection.py         # PostgreSQL engine configuration, pooling, and SessionLocal factory
├── dependencies.py       # FastAPI get_db() session dependency with lifecycle management
│
├── models/               # SQLAlchemy ORM Models & PostGIS Geometries
│   ├── __init__.py       # Model package exports & backward-compatibility aliases
│   ├── sdap_models.py    # Primary entities: Users, Requests, Scenes, BandFiles, ProcessJobs
│   └── boundaries.py     # PostGIS tables: StateBoundaryModel, DistrictBoundaryModel
│
├── repositories/         # Centralized, Reusable Database Query Handlers
│   ├── __init__.py       # Package exports
│   ├── boundary_repo.py  # Boundary and GeoJSON lookup queries
│   ├── request_repo.py   # Request CRUD, pagination, and status filters
│   ├── sentinel_repo.py  # Sentinel-1 & Sentinel-2 scene and tile metadata queries
│   └── user_repo.py      # User account queries and role checks
│
├── seeds/                # Seed Data Modules
│   ├── __init__.py       # Seed manager exports
│   └── user_seeds.py     # Default admin, analyst, and standard user provisioning
│
└── scripts/              # Operational Spatial Ingestion & Processing Scripts
    ├── __init__.py
    ├── README.md         # Detailed execution guide and script catalog
    ├── ingest_gadm_boundaries.py
    ├── process_768_shapefile.py
    ├── process_and_upload_shapefile.py
    ├── map_districts_to_tiles.py
    ├── enrich_district_names.py
    ├── download_district_tiles.py
    ├── retrieve_downloaded_data.py
    └── cloud_removal_and_indices.py
```

---

## 🚀 Quick Usage Examples

### 1. In FastAPI Endpoints:
```python
from fastapi import Depends
from sqlalchemy.orm import Session
from app.db import get_db
from app.db.repositories import RequestRepository

@router.get("/requests/{id}")
def fetch_request(id: int, db: Session = Depends(get_db)):
    return RequestRepository.get_by_id(db, id)
```

### 2. In Background Tasks / Standalone Scripts:
```python
from app.db import SessionLocal
from app.db.models import UserModel

db = SessionLocal()
try:
    admin = db.query(UserModel).filter(UserModel.role == "ADMIN").first()
finally:
    db.close()
```

