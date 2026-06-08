from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app


def make_client(tmp_path: Path) -> TestClient:
    db_path = tmp_path / "auth.db"
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


def admin_login(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "admin-password"},
    )
    assert response.status_code == 200


def test_login_and_me(tmp_path: Path):
    client = make_client(tmp_path)

    admin_login(client)
    response = client.get("/api/auth/me")

    assert response.status_code == 200
    assert response.json()["email"] == "owner@example.com"
    assert response.json()["role"] == "admin"
    app.dependency_overrides.clear()


def test_login_rejects_wrong_password(tmp_path: Path):
    client = make_client(tmp_path)

    response = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "wrong"},
    )

    assert response.status_code == 401
    app.dependency_overrides.clear()


def test_admin_can_create_and_list_invites(tmp_path: Path):
    client = make_client(tmp_path)
    admin_login(client)

    create_response = client.post("/api/invites", json={"expires_days": 7})
    list_response = client.get("/api/invites")

    assert create_response.status_code == 200
    assert len(create_response.json()["code"]) >= 16
    assert list_response.status_code == 200
    assert list_response.json()[0]["code"] == create_response.json()["code"]
    assert list_response.json()[0]["is_used"] is False
    app.dependency_overrides.clear()


def test_register_requires_unused_invite_and_consumes_it(tmp_path: Path):
    client = make_client(tmp_path)
    admin_login(client)
    invite_code = client.post("/api/invites", json={"expires_days": 7}).json()["code"]
    client.post("/api/auth/logout")

    register_response = client.post(
        "/api/auth/register",
        json={
            "email": "student@example.com",
            "password": "student-password",
            "invite_code": invite_code,
        },
    )
    second_response = client.post(
        "/api/auth/register",
        json={
            "email": "second@example.com",
            "password": "student-password",
            "invite_code": invite_code,
        },
    )

    assert register_response.status_code == 200
    assert register_response.json()["email"] == "student@example.com"
    assert second_response.status_code == 400
    app.dependency_overrides.clear()


def test_non_admin_cannot_create_invites(tmp_path: Path):
    client = make_client(tmp_path)
    admin_login(client)
    invite_code = client.post("/api/invites", json={"expires_days": 7}).json()["code"]
    client.post("/api/auth/logout")
    client.post(
        "/api/auth/register",
        json={
            "email": "student@example.com",
            "password": "student-password",
            "invite_code": invite_code,
        },
    )

    response = client.post("/api/invites", json={"expires_days": 7})

    assert response.status_code == 403
    app.dependency_overrides.clear()
