from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app


def make_client(tmp_path: Path) -> TestClient:
    db_path = tmp_path / "admin-ai-config.db"
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


def test_admin_can_update_ai_config_without_key_echo(tmp_path: Path):
    client = make_client(tmp_path)
    login_admin(client)

    update = client.put(
        "/api/admin/ai-config",
        json={"base_url": "https://example.test/v1", "api_key": "secret-key"},
    )
    read = client.get("/api/admin/ai-config")

    assert update.status_code == 200
    assert update.json() == {"base_url": "https://example.test/v1", "has_api_key": True}
    assert read.status_code == 200
    assert read.json() == {"base_url": "https://example.test/v1", "has_api_key": True}
    assert "secret-key" not in read.text
    app.dependency_overrides.clear()


def test_admin_can_change_base_url_without_replacing_existing_key(tmp_path: Path):
    client = make_client(tmp_path)
    login_admin(client)
    client.put("/api/admin/ai-config", json={"base_url": "https://first.test/v1", "api_key": "secret-key"})

    update = client.put("/api/admin/ai-config", json={"base_url": "https://second.test/v1", "api_key": ""})

    assert update.status_code == 200
    assert update.json() == {"base_url": "https://second.test/v1", "has_api_key": True}
    app.dependency_overrides.clear()


def test_saved_ai_config_is_used_by_chat_stream(tmp_path: Path, monkeypatch):
    client = make_client(tmp_path)
    login_admin(client)
    client.put(
        "/api/admin/ai-config",
        json={"base_url": "https://example.test/v1", "api_key": "secret-key"},
    )
    session_id = client.post("/api/sessions", json={"title": "配置测试", "model": "gpt-5.4-mini"}).json()["id"]
    captured: dict[str, str] = {}

    async def fake_stream(_history, _model, ai_config):
        captured["base_url"] = ai_config.base_url
        captured["api_key"] = ai_config.api_key
        yield "ok"

    monkeypatch.setattr("app.chat.routes.stream_chat_completion", fake_stream)

    with client.stream(
        "POST",
        "/api/chat/stream",
        json={"session_id": session_id, "content": "测试", "model": "gpt-5.4-mini", "attachment_ids": []},
    ) as response:
        body = "".join(response.iter_text())

    assert response.status_code == 200
    assert "ok" in body
    assert captured == {"base_url": "https://example.test/v1", "api_key": "secret-key"}
    app.dependency_overrides.clear()


def test_non_admin_cannot_manage_ai_config(tmp_path: Path):
    client = make_client(tmp_path)
    register_user(client)

    read = client.get("/api/admin/ai-config")
    update = client.put(
        "/api/admin/ai-config",
        json={"base_url": "https://example.test/v1", "api_key": "secret-key"},
    )

    assert read.status_code == 403
    assert update.status_code == 403
    app.dependency_overrides.clear()
