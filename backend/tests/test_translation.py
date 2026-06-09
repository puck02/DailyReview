from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings, settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app
from app.models import Message, TranslationEntry, User
from app.reports.service import generate_daily_report
from app.translation import routes as translation_routes


def make_client(tmp_path: Path) -> tuple[TestClient, object]:
    settings.report_dir = str(tmp_path / "reports")
    settings.upload_dir = str(tmp_path / "uploads")
    db_path = tmp_path / "translation.db"
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


def test_translation_uses_prompt_and_keeps_records_out_of_daily_report(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    captured: dict[str, str] = {}

    async def fake_complete_chat(messages, model, fallback, ai_config):
        captured["system"] = messages[0]["content"]
        captured["user"] = messages[1]["content"]
        captured["model"] = model
        return "音标：/həˈləʊ/\n\n### 翻译\nHello.\n\n### 重点\n- hello 用于问候。"

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)

    response = client.post("/api/translation", json={"text": "你好"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_text"] == "你好"
    assert payload["source_kind"] == "chinese"
    assert payload["phonetic"] == "/həˈləʊ/"
    assert "Hello" in payload["result_markdown"]
    assert "考研英语一" in captured["system"]
    assert "输入类型：中文" in captured["user"]
    assert captured["model"] == "gpt-5.4-mini"

    with session_factory() as db:
        user = db.scalar(select(User).where(User.email == "owner@example.com"))
        entries = db.scalars(select(TranslationEntry).where(TranslationEntry.user_id == user.id)).all()
        messages = db.scalars(select(Message)).all()
        report = generate_daily_report(db, user.id, date.today())

    assert len(entries) == 1
    assert entries[0].source_text == "你好"
    assert messages == []
    assert report is None
    app.dependency_overrides.clear()


def test_english_translation_enqueues_word_details_silently(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    queued_entry_ids: list[int] = []

    async def fake_complete_chat(messages, model, fallback, ai_config):
        return "音标：/dɪˈrɪvətɪv/\n\n### 译文\n这个导数问题需要仔细处理极限。"

    def fake_enqueue_word_detail_job(entry_id, session_factory, ai_config):
        queued_entry_ids.append(entry_id)

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)
    monkeypatch.setattr(translation_routes, "enqueue_word_detail_job", fake_enqueue_word_detail_job, raising=False)

    response = client.post("/api/translation", json={"text": "The derivative problem requires careful limits"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_kind"] == "english"
    assert payload["phonetic"] == "/dɪˈrɪvətɪv/"
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry).where(TranslationEntry.user_id == 1)).all()
    original = next(entry for entry in entries if entry.source_kind == "english")
    derivative = next(entry for entry in entries if entry.source_kind == "word" and entry.source_text == "derivative")
    assert original.is_auto_detail is False
    assert derivative.is_auto_detail is True
    assert derivative.detail_status == "queued"
    assert derivative.result_markdown == ""
    assert derivative.id in queued_entry_ids
    app.dependency_overrides.clear()


def test_translation_prompt_can_be_customized_per_user(tmp_path: Path, monkeypatch):
    client, _session_factory = make_client(tmp_path)
    login_admin(client)
    captured: dict[str, str] = {}
    custom_prompt = "请用极简方式解释考研英语一词汇。"

    async def fake_complete_chat(messages, model, fallback, ai_config):
        captured["system"] = messages[0]["content"]
        return "### 译文\n学习"

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)

    before = client.get("/api/translation/prompt")
    saved = client.put("/api/translation/prompt", json={"system_prompt": custom_prompt})
    translated = client.post("/api/translation", json={"text": "study"})
    after = client.get("/api/translation/prompt")

    assert before.status_code == 200
    assert "词根词缀" in before.json()["system_prompt"]
    assert saved.status_code == 200
    assert saved.json()["system_prompt"] == custom_prompt
    assert translated.status_code == 200
    assert captured["system"] == custom_prompt
    assert after.json()["system_prompt"] == custom_prompt
    app.dependency_overrides.clear()


def test_translation_falls_back_when_ai_service_fails(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)

    async def fake_complete_chat(messages, model, fallback, ai_config):
        raise RuntimeError("upstream failed")

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)

    response = client.post("/api/translation", json={"text": "abandon"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_kind"] == "word"
    assert "AI 配置不可用" in payload["result_markdown"]
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert len(entries) == 1
    assert entries[0].source_text == "abandon"
    app.dependency_overrides.clear()


def test_translation_rejects_over_limit_text_before_ai_call(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    called = False

    async def fake_complete_chat(messages, model, fallback, ai_config):
        nonlocal called
        called = True
        return "should not be called"

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)

    response = client.post("/api/translation", json={"text": "a" * 2001})

    assert response.status_code == 400
    assert response.json()["detail"] == "输入超过 2000 字，已超限，不予翻译。"
    assert called is False
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert entries == []
    app.dependency_overrides.clear()
