from pathlib import Path

from fastapi.testclient import TestClient

from app.app_settings import ApplicationSettings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app
from app.config import Settings
from app.scheduler.jobs import reschedule_report_jobs


def make_client(tmp_path: Path) -> TestClient:
    db_path = tmp_path / "app-settings.db"
    settings = Settings(
        database_url=f"sqlite:///{db_path}",
        secret_key="test-secret",
        admin_email="owner@example.com",
        admin_initial_password="admin-password",
    )
    session_factory = create_session_factory(settings.database_url)
    initialize_database(settings, session_factory)

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app)


def login_admin(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "admin-password"},
    )
    assert response.status_code == 200


def register_user(client: TestClient) -> None:
    login_admin(client)
    invite_code = client.post("/api/invites", json={"expires_days": 7}).json()["code"]
    client.post("/api/auth/logout")
    response = client.post(
        "/api/auth/register",
        json={"email": "student@example.com", "password": "student-password", "invite_code": invite_code},
    )
    assert response.status_code == 200


def test_settings_api_returns_defaults(tmp_path: Path):
    client = make_client(tmp_path)
    login_admin(client)

    response = client.get("/api/settings")

    assert response.status_code == 200
    assert response.json() == {
        "daily_report_time": "23:00",
        "weekly_report_time": "23:00",
        "monthly_report_time": "23:00",
        "word_cloud_enabled": True,
    }
    app.dependency_overrides.clear()


def test_admin_can_update_app_settings(tmp_path: Path):
    client = make_client(tmp_path)
    login_admin(client)

    response = client.put(
        "/api/settings",
        json={
            "daily_report_time": "22:15",
            "weekly_report_time": "21:30",
            "monthly_report_time": "20:45",
            "word_cloud_enabled": False,
        },
    )
    read = client.get("/api/settings")

    assert response.status_code == 200
    assert response.json() == {
        "daily_report_time": "22:15",
        "weekly_report_time": "21:30",
        "monthly_report_time": "20:45",
        "word_cloud_enabled": False,
    }
    assert read.json()["word_cloud_enabled"] is False
    app.dependency_overrides.clear()


def test_settings_api_rejects_invalid_time(tmp_path: Path):
    client = make_client(tmp_path)
    login_admin(client)

    response = client.put(
        "/api/settings",
        json={
            "daily_report_time": "25:99",
            "weekly_report_time": "23:00",
            "monthly_report_time": "23:00",
            "word_cloud_enabled": True,
        },
    )

    assert response.status_code == 422
    app.dependency_overrides.clear()


def test_non_admin_cannot_update_app_settings(tmp_path: Path):
    client = make_client(tmp_path)
    register_user(client)

    read = client.get("/api/settings")
    update = client.put(
        "/api/settings",
        json={
            "daily_report_time": "22:15",
            "weekly_report_time": "21:30",
            "monthly_report_time": "20:45",
            "word_cloud_enabled": False,
        },
    )

    assert read.status_code == 200
    assert update.status_code == 403
    app.dependency_overrides.clear()


def test_report_scheduler_uses_configured_times():
    calls: list[dict] = []

    class FakeScheduler:
        def add_job(self, func, trigger, **kwargs):
            calls.append({"func": func, "trigger": trigger, **kwargs})

    reschedule_report_jobs(
        FakeScheduler(),
        ApplicationSettings(
            daily_report_time="22:15",
            weekly_report_time="21:30",
            monthly_report_time="20:45",
            word_cloud_enabled=True,
        ),
    )

    jobs = {call["id"]: call for call in calls}
    assert jobs["daily_report"]["hour"] == 22
    assert jobs["daily_report"]["minute"] == 15
    assert jobs["weekly_report"]["day_of_week"] == "sun"
    assert jobs["weekly_report"]["hour"] == 21
    assert jobs["weekly_report"]["minute"] == 30
    assert jobs["monthly_report"]["hour"] == 20
    assert jobs["monthly_report"]["minute"] == 45
