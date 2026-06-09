from datetime import datetime, timedelta
from pathlib import Path

from sqlalchemy import select

from app.config import Settings
from app.db import create_session_factory, initialize_database
from app.models import Attachment, ChatSession, Message, Report, User
from app.scheduler.jobs import cleanup_expired_data


def test_cleanup_deletes_old_chat_and_uploads_but_keeps_reports(tmp_path: Path):
    db_path = tmp_path / "cleanup.db"
    app_settings = Settings(
        database_url=f"sqlite:///{db_path}",
        secret_key="test-secret",
        admin_email="owner@example.com",
        admin_initial_password="admin-password",
    )
    session_factory = create_session_factory(app_settings.database_url)
    initialize_database(app_settings, session_factory)
    upload_path = tmp_path / "old.png"
    upload_path.write_bytes(b"old")
    archived_upload_path = tmp_path / "archived.png"
    archived_upload_path.write_bytes(b"archived")
    report_path = tmp_path / "report.md"
    report_path.write_text("# report", encoding="utf-8")

    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        chat = ChatSession(
            user_id=user.id,
            title="旧会话",
            default_model="gpt-5.4-mini",
            created_at=datetime.utcnow() - timedelta(days=8),
            updated_at=datetime.utcnow() - timedelta(days=8),
        )
        archived_chat = ChatSession(
            user_id=user.id,
            title="归档旧会话",
            default_model="gpt-5.4-mini",
            is_archived=True,
            created_at=datetime.utcnow() - timedelta(days=30),
            updated_at=datetime.utcnow() - timedelta(days=30),
        )
        db.add_all([chat, archived_chat])
        db.flush()
        message = Message(session_id=chat.id, role="user", content="old", created_at=datetime.utcnow() - timedelta(days=8))
        archived_message = Message(
            session_id=archived_chat.id,
            role="user",
            content="archived",
            created_at=datetime.utcnow() - timedelta(days=30),
        )
        db.add(message)
        db.add(archived_message)
        db.flush()
        db.add(
            Attachment(
                user_id=user.id,
                message_id=message.id,
                file_path=str(upload_path),
                mime_type="image/png",
                size=3,
                expires_at=datetime.utcnow() - timedelta(days=1),
            )
        )
        db.add(
            Attachment(
                user_id=user.id,
                message_id=archived_message.id,
                file_path=str(archived_upload_path),
                mime_type="image/png",
                size=8,
                expires_at=datetime.utcnow() - timedelta(days=1),
            )
        )
        db.add(Report(user_id=user.id, report_type="daily", period="2026-06-01", markdown_path=str(report_path), stats_json="{}"))
        db.commit()

    cleanup_expired_data(session_factory=session_factory, now=datetime.utcnow())

    with session_factory() as db:
        remaining_sessions = db.scalars(select(ChatSession)).all()
        remaining_messages = db.scalars(select(Message)).all()
        remaining_attachments = db.scalars(select(Attachment)).all()
        assert [session.title for session in remaining_sessions] == ["归档旧会话"]
        assert [message.content for message in remaining_messages] == ["archived"]
        assert [attachment.file_path for attachment in remaining_attachments] == [str(archived_upload_path)]
        assert db.scalar(select(Report)) is not None
    assert not upload_path.exists()
    assert archived_upload_path.exists()
    assert report_path.exists()
