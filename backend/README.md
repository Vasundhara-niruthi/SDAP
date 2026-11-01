# 🚀 SDAP Server (Backend API)

Backend processing server and API service for **SDAP (Satellite Data Acquisition & Index Generation Platform)**, built with **FastAPI 0.141.1**, **SQLAlchemy**, and **PostgreSQL 18**.

---

## 🛠️ Stack & Specifications

- **Backend Framework:** FastAPI (`0.141.1`)
- **Database:** PostgreSQL 18 / PostGIS
- **ORM & Drivers:** SQLAlchemy 2.0+, `psycopg2-binary`, `asyncpg`, `geoalchemy2`
- **Validation:** Pydantic v2 & Pydantic-Settings

---

## 📂 Project Structure

```
SDAP-server/
├── venv/                      # Python virtual environment
├── .env                       # Environment configuration (DB credentials & storage paths)
├── .env.example               # Template environment configuration
├── requirements.txt           # Python dependencies (FastAPI 0.141.1, PostgreSQL drivers, etc.)
├── init_db.py                 # PostgreSQL database & table initialization script
├── alembic/                   # Schema migrations (versions/)
├── app/
│   ├── main.py                # FastAPI entry point, CORS & startup seeding
│   ├── core/
│   │   ├── config.py          # Application settings & environment loader
│   │   └── security.py        # JWT, password hashing & auth dependencies
│   ├── db/                    # Engine/session, ORM models, repositories, seeds, ingestion scripts
│   ├── routes/                # API routers (auth, users, requests, layer_stack, rasters, boundaries, health)
│   ├── schemas/               # Pydantic request/response schemas
│   ├── services/              # Gap check, download, S1/S2 processing, compositing, stacking, delivery
│   └── graphs/                # SNAP processing graphs
└── scripts/                   # Standalone helper scripts
```

---

## ⚙️ Setup & Running

### 1. Update Database Password in `.env`
Open `.env` and set your local PostgreSQL password:
```env
POSTGRES_PASSWORD=your_postgres_password
```

### 2. Initialize Database & Tables
Run the database helper script to create `sdap_db` and all tables:
```bash
.\venv\Scripts\python.exe init_db.py
```

### 3. Run FastAPI Server
Start the server using `uvicorn`:
```bash
.\venv\Scripts\python.exe -m uvicorn app.main:app --reload --port 8000
```

- **Swagger UI Interactive Docs:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **ReDoc API Documentation:** [http://localhost:8000/redoc](http://localhost:8000/redoc)
- **Health Check Endpoint:** `GET http://localhost:8000/api/v1/health`

