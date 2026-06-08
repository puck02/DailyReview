from datetime import date, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings, settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app
from app.models import ChatSession, Message, Report, User
from app.reports.service import generate_daily_report, search_markdown_blocks


def make_client(tmp_path: Path) -> tuple[TestClient, object]:
    settings.report_dir = str(tmp_path / "reports")
    settings.upload_dir = str(tmp_path / "uploads")
    db_path = tmp_path / "reports.db"
    app_settings = Settings(
        database_url=f"sqlite:///{db_path}",
        secret_key="test-secret",
        admin_email="owner@example.com",
        admin_initial_password="admin-password",
    )
    session_factory = create_session_factory(app_settings.database_url)
    initialize_database(app_settings, session_factory)

    def override_get_db():
        db = session_factory()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app), session_factory


def login_admin(client: TestClient) -> None:
    response = client.post(
        "/api/auth/login",
        json={"email": "owner@example.com", "password": "admin-password"},
    )
    assert response.status_code == 200


def test_generate_daily_report_skips_empty_day(tmp_path: Path):
    _client, session_factory = make_client(tmp_path)
    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        report = generate_daily_report(db, user.id, date(2026, 6, 8))

    assert report is None
    app.dependency_overrides.clear()


def test_generate_daily_report_writes_markdown_and_index(tmp_path: Path):
    _client, session_factory = make_client(tmp_path)
    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        chat = ChatSession(user_id=user.id, title="数学", default_model="gpt-5.4-mini")
        db.add(chat)
        db.flush()
        db.add(Message(session_id=chat.id, role="user", content="今天学习了导数和链式法则", created_at=datetime(2026, 6, 8, 10, 0, 0)))
        db.add(Message(session_id=chat.id, role="assistant", content="链式法则用于复合函数求导", created_at=datetime(2026, 6, 8, 10, 1, 0)))
        db.commit()

        report = generate_daily_report(db, user.id, date(2026, 6, 8))

    assert report is not None
    path = Path(report.markdown_path)
    assert path.exists()
    assert "2026-06-08 学习日报" in path.read_text(encoding="utf-8")
    assert "下一步建议" in path.read_text(encoding="utf-8")
    app.dependency_overrides.clear()


def test_search_markdown_blocks_returns_matching_paragraphs(tmp_path: Path):
    path = tmp_path / "2026-06-07.md"
    path.write_text("# 昨日报告\n\n导数表示瞬时变化率。\n\n概率论讨论随机变量。", encoding="utf-8")

    blocks = search_markdown_blocks([path], ["导数"])

    assert blocks == ["导数表示瞬时变化率。"]


def test_reports_api_lists_only_current_user_month_reports(tmp_path: Path):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        other = User(email="other@example.com", password_hash="x", role="user")
        db.add(other)
        db.flush()
        report_path = tmp_path / "reports" / "user-1" / "daily" / "2026" / "06" / "2026-06-08.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text("# report", encoding="utf-8")
        db.add(Report(user_id=user.id, report_type="daily", period="2026-06-08", markdown_path=str(report_path), stats_json='{"message_count": 2}'))
        db.add(Report(user_id=other.id, report_type="daily", period="2026-06-08", markdown_path=str(report_path), stats_json="{}"))
        db.commit()

    response = client.get("/api/reports", params={"report_type": "daily", "month": "2026-06"})

    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["period"] == "2026-06-08"
    app.dependency_overrides.clear()
