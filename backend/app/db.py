from pathlib import Path

from sqlalchemy import create_engine, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import Settings, settings
from app.models import Base, User


def _sqlite_path(database_url: str) -> Path | None:
    if not database_url.startswith("sqlite:///"):
        return None
    return Path(database_url.replace("sqlite:///", "", 1))


def create_engine_for_url(database_url: str) -> Engine:
    db_path = _sqlite_path(database_url)
    if db_path is not None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        return create_engine(database_url, connect_args={"check_same_thread": False})
    return create_engine(database_url)


def create_session_factory(database_url: str) -> sessionmaker[Session]:
    engine = create_engine_for_url(database_url)
    return sessionmaker(bind=engine, autoflush=False, autocommit=False)


SessionLocal = create_session_factory(settings.database_url)


def initialize_database(app_settings: Settings = settings, session_factory: sessionmaker[Session] = SessionLocal) -> None:
    engine = session_factory.kw["bind"]
    Base.metadata.create_all(bind=engine)
    if not app_settings.admin_email or not app_settings.admin_initial_password:
        return

    from app.security import hash_password

    with session_factory() as session:
        existing_admin = session.scalar(select(User).where(User.role == "admin"))
        if existing_admin is not None:
            return
        admin = User(
            email=app_settings.admin_email.lower(),
            password_hash=hash_password(app_settings.admin_initial_password),
            role="admin",
        )
        session.add(admin)
        session.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
