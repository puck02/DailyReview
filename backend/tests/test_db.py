from pathlib import Path

from sqlalchemy import select

from app.config import Settings
from app.db import create_session_factory, initialize_database
from app.models import User
from app.security import verify_password


def test_initialize_database_bootstraps_one_admin(tmp_path: Path):
    db_path = tmp_path / "app.db"
    settings = Settings(
        database_url=f"sqlite:///{db_path}",
        secret_key="test-secret",
        admin_email="owner@example.com",
        admin_initial_password="admin-password",
    )
    session_factory = create_session_factory(settings.database_url)

    initialize_database(settings, session_factory)
    initialize_database(settings, session_factory)

    with session_factory() as session:
        users = session.scalars(select(User)).all()

    assert len(users) == 1
    assert users[0].email == "owner@example.com"
    assert users[0].role == "admin"
    assert users[0].password_hash != "admin-password"
    assert verify_password("admin-password", users[0].password_hash)
