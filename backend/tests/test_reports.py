from datetime import date, datetime
from io import BytesIO
from pathlib import Path

from fastapi.testclient import TestClient
from pypdf import PdfReader
from sqlalchemy import select

from app.config import Settings, settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app
from app.models import ChatSession, Message, Report, User
from app.reports import service as report_service
from app.reports.service import generate_daily_report, generate_daily_report_async, search_markdown_blocks


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


def test_ai_daily_report_prompt_limits_pdf_to_four_pages(tmp_path: Path, monkeypatch):
    _client, session_factory = make_client(tmp_path)
    captured: dict[str, str] = {}

    async def fake_complete_chat(messages, model, fallback, ai_config):
        captured["prompt"] = messages[0]["content"]
        return fallback

    monkeypatch.setattr(report_service, "complete_chat", fake_complete_chat)

    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        chat = ChatSession(user_id=user.id, title="数学", default_model="gpt-5.4-mini")
        db.add(chat)
        db.flush()
        db.add(Message(session_id=chat.id, role="user", content="今天学习了导数、链式法则和泰勒展开", created_at=datetime(2026, 6, 8, 10, 0, 0)))
        db.add(Message(session_id=chat.id, role="assistant", content="重点是复合函数求导和常见等价无穷小。", created_at=datetime(2026, 6, 8, 10, 1, 0)))
        db.commit()

        report = generate_daily_report_async(db, user.id, date(2026, 6, 8))

    import asyncio

    assert asyncio.run(report) is not None
    assert "A4 PDF 4 页以内" in captured["prompt"]
    assert "内容过多时只保留最重要的结论、错因和下一步建议" in captured["prompt"]
    assert "不要堆砌完整聊天流水" in captured["prompt"]
    app.dependency_overrides.clear()


def test_ai_daily_report_compacts_overlong_model_output(tmp_path: Path, monkeypatch):
    _client, session_factory = make_client(tmp_path)
    overlong_section = "\n".join(f"- 第 {index} 条完整聊天流水，包含大量细节。" for index in range(40))
    overlong_report = f"""# 2026-06-08 学习日报

## 1. 今日学习概览
{overlong_section}

## 2. 核心知识点
{overlong_section}

## 3. 典型问题与解法
{overlong_section}

## 4. 易错点 / 未解决问题
{overlong_section}

## 5. 与历史内容的关联
{overlong_section}

## 6. 下一步建议
{overlong_section}

## 7. 简短复盘
{overlong_section}
"""

    async def fake_complete_chat(messages, model, fallback, ai_config):
        return overlong_report

    monkeypatch.setattr(report_service, "complete_chat", fake_complete_chat)

    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        chat = ChatSession(user_id=user.id, title="数学", default_model="gpt-5.4-mini")
        db.add(chat)
        db.flush()
        db.add(Message(session_id=chat.id, role="user", content="今天学习了很多内容", created_at=datetime(2026, 6, 8, 10, 0, 0)))
        db.commit()

        report = generate_daily_report_async(db, user.id, date(2026, 6, 8))

    import asyncio

    written_report = asyncio.run(report)

    assert written_report is not None
    markdown = Path(written_report.markdown_path).read_text(encoding="utf-8")
    assert len(markdown) <= 1800
    assert markdown.count("完整聊天流水") <= 28
    assert "内容已按 PDF 篇幅要求压缩" in markdown
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


def test_report_pdf_api_returns_searchable_text_pdf(tmp_path: Path):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        report_path = tmp_path / "reports" / "user-1" / "daily" / "2026" / "06" / "2026-06-09.md"
        report_path.parent.mkdir(parents=True)
        report_path.write_text(
            "\n".join(
                [
                    "# 2026-06-09 学习日报",
                    "",
                    "## 今日重点",
                    "",
                    "- 导数与极限：复盘连续、可导和极限存在的关系。",
                    "- 泰勒展开：整理常见二阶展开式。",
                    "",
                    "| 模块 | 下一步 |",
                    "| --- | --- |",
                    "| 高数 | 回看错题并默写公式 |",
                    "",
                    "```text",
                    "先判断目标极限的阶数，再比较主导项。",
                    "```",
                ]
            ),
            encoding="utf-8",
        )
        report = Report(
            user_id=user.id,
            report_type="daily",
            period="2026-06-09",
            markdown_path=str(report_path),
            stats_json='{"message_count": 6}',
        )
        db.add(report)
        db.commit()
        report_id = report.id

    response = client.get(f"/api/reports/{report_id}/pdf")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert "attachment" in response.headers["content-disposition"]
    assert response.content.startswith(b"%PDF")
    assert b"/Subtype /Image" not in response.content
    reader = PdfReader(BytesIO(response.content))
    extracted_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert "2026-06-09" in extracted_text
    assert "学习日报" in extracted_text
    assert "导数与极限" in extracted_text
    assert "泰勒展开" in extracted_text
    app.dependency_overrides.clear()
