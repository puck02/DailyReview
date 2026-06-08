from datetime import datetime, timedelta
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app
from app.models import Attachment, ChatSession, Message, User


def make_client(tmp_path: Path) -> tuple[TestClient, object]:
    db_path = tmp_path / "chat.db"
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
    return TestClient(app), session_factory


def create_invite(client: TestClient) -> str:
    login = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "admin-password"},
    )
    assert login.status_code == 200
    invite = client.post("/api/invites", json={"expires_days": 7})
    assert invite.status_code == 200
    client.post("/api/auth/logout")
    return invite.json()["code"]


def register_user(client: TestClient, email: str) -> None:
    invite_code = create_invite(client)
    response = client.post(
        "/api/auth/register",
        json={"email": email, "password": "student-password", "invite_code": invite_code},
    )
    assert response.status_code == 200


def test_sessions_list_only_current_user_recent_sessions(tmp_path: Path):
    client, session_factory = make_client(tmp_path)
    register_user(client, "student@example.com")
    created = client.post("/api/sessions", json={"title": "线性代数", "model": "gpt-5.4-mini"})
    assert created.status_code == 200

    other_client = TestClient(app)
    register_user(other_client, "other@example.com")
    other_client.post("/api/sessions", json={"title": "不应出现", "model": "gpt-5.4-mini"})

    with session_factory() as session:
        student = session.scalar(select(User).where(User.email == "student@example.com"))
        old = ChatSession(
            user_id=student.id,
            title="过期会话",
            default_model="gpt-5.4-mini",
            created_at=datetime.utcnow() - timedelta(days=8),
            updated_at=datetime.utcnow() - timedelta(days=8),
        )
        session.add(old)
        session.commit()

    response = client.get("/api/sessions")

    assert response.status_code == 200
    assert [item["title"] for item in response.json()] == ["线性代数"]
    app.dependency_overrides.clear()


def test_image_upload_creates_expiring_attachment(tmp_path: Path):
    client, session_factory = make_client(tmp_path)
    register_user(client, "student@example.com")

    response = client.post(
        "/api/attachments",
        files={"file": ("note.png", b"fake image", "image/png")},
    )

    assert response.status_code == 200
    payload = response.json()
    with session_factory() as session:
        attachment = session.get(Attachment, payload["id"])

    assert attachment is not None
    assert attachment.mime_type == "image/png"
    assert attachment.expires_at > datetime.utcnow() + timedelta(days=6)
    assert Path(attachment.file_path).exists()
    app.dependency_overrides.clear()


def test_stream_chat_persists_user_and_assistant_messages(tmp_path: Path):
    client, session_factory = make_client(tmp_path)
    register_user(client, "student@example.com")
    session_response = client.post("/api/sessions", json={"title": "微积分", "model": "gpt-5.4-mini"})
    session_id = session_response.json()["id"]

    with client.stream(
        "POST",
        "/api/chat/stream",
        json={"session_id": session_id, "content": "解释导数", "model": "gpt-5.4-mini", "attachment_ids": []},
    ) as response:
        body = "".join(response.iter_text())

    assert response.status_code == 200
    assert "data:" in body
    with session_factory() as db:
        messages = db.scalars(select(Message).order_by(Message.id)).all()

    assert [message.role for message in messages] == ["user", "assistant"]
    assert messages[0].content == "解释导数"
    assert messages[1].content
    app.dependency_overrides.clear()


def test_get_session_messages_is_scoped_to_current_user(tmp_path: Path):
    client, session_factory = make_client(tmp_path)
    register_user(client, "student@example.com")
    session_response = client.post("/api/sessions", json={"title": "物理", "model": "gpt-5.4-mini"})
    session_id = session_response.json()["id"]
    with session_factory() as db:
        db.add(Message(session_id=session_id, role="user", content="牛顿第二定律"))
        db.commit()

    response = client.get(f"/api/sessions/{session_id}/messages")

    assert response.status_code == 200
    assert response.json()[0]["content"] == "牛顿第二定律"
    app.dependency_overrides.clear()
