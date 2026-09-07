"""
Database Initialization & User Seeding Helper Script for SDAP
"""
import sys
import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import engine, Base, SessionLocal
from app.core.security import hash_password
from app.models.sdap_models import UserModel, RequestModel, SceneModel, BandFileModel, ProcessJobModel


def migrate_schema():
    """Ensure database schema is up-to-date with new columns."""
    print("Migrating schema alterations...")
    with engine.connect() as conn:
        res = conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name='requests' AND column_name='user_id';"))
        if not res.fetchone():
            print("  [+] Adding 'user_id' column to 'requests' table...")
            conn.execute(text("ALTER TABLE requests ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;"))
            conn.commit()


def seed_admin_user(db: Session):
    """Seed initial System Administrator account into local PostgreSQL."""
    print("Checking system administrator account...")
    
    admin = db.query(UserModel).filter(UserModel.email == "admin@sdap.niruthi.in").first()
    if not admin:
        admin_user = UserModel(
            email="admin@sdap.niruthi.in",
            full_name="SDAP System Administrator",
            hashed_password=hash_password("Admin@123456"),
            role="ADMIN",
            is_active=True
        )
        db.add(admin_user)
        print("  [+] Seeded Admin User: admin@sdap.niruthi.in")
    else:
        print("  [*] Admin User already exists: admin@sdap.niruthi.in")

    db.commit()


def create_postgres_db():
    print(f"Connecting to PostgreSQL server at {settings.POSTGRES_SERVER}:{settings.POSTGRES_PORT} as user '{settings.POSTGRES_USER}'...")
    try:
        conn = psycopg2.connect(
            dbname='postgres',
            user=settings.POSTGRES_USER,
            password=settings.POSTGRES_PASSWORD,
            host=settings.POSTGRES_SERVER,
            port=settings.POSTGRES_PORT,
            connect_timeout=5
        )
        conn.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cursor = conn.cursor()

        cursor.execute("SELECT 1 FROM pg_catalog.pg_database WHERE datname = %s;", (settings.POSTGRES_DB,))
        exists = cursor.fetchone()
        if not exists:
            print(f"Database '{settings.POSTGRES_DB}' does not exist. Creating now...")
            cursor.execute(f'CREATE DATABASE "{settings.POSTGRES_DB}";')
            print(f"Database '{settings.POSTGRES_DB}' created successfully!")
        else:
            print(f"Database '{settings.POSTGRES_DB}' already exists.")

        cursor.close()
        conn.close()

        # Create tables
        print("Creating table schema using SQLAlchemy...")
        Base.metadata.create_all(bind=engine)
        migrate_schema()
        print("All SDAP tables verified/migrated successfully!")

        # Seed System Administrator only
        db = SessionLocal()
        try:
            seed_admin_user(db)
        finally:
            db.close()

        print("\nDatabase initialization complete!")
        return True

    except psycopg2.OperationalError as oe:
        print("\n[ERROR] Could not connect to PostgreSQL:")
        print(f"  {oe}")
        print("\n[TIP] Please check your PostgreSQL password in .env (POSTGRES_PASSWORD=your_password)")
        return False
    except Exception as e:
        print(f"\n[ERROR] An unexpected error occurred: {e}")
        return False


if __name__ == "__main__":
    success = create_postgres_db()
    sys.exit(0 if success else 1)
