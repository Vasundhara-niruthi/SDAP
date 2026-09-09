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
├── app/
│   ├── main.py                # FastAPI entry point & CORS configuration
│   ├── core/
│   │   ├── config.py          # Application settings & environment loader
│   │   └── database.py        # SQLAlchemy engine, session maker & health check
│   ├── models/
│   │   └── sdap_models.py     # Database models (Requests, Scenes, SceneFiles, ProcessJobs)
│   ├── schemas/
│   │   ├── health_schema.py   # Health check response schema
│   │   └── request_schema.py  # Validation schemas for satellite acquisition requests
│   └── api/
│       └── v1/
│           ├── api.py         # Main router aggregator
│           └── endpoints/
│               ├── health.py  # /api/v1/health endpoint
│               └── requests.py# /api/v1/requests endpoints
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

