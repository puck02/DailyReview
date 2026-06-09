from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.config import Settings, settings
from app.db import create_session_factory, get_db, initialize_database
from app.main import app
from app.models import Message, TranslationEntry, User
from app.reports.service import generate_daily_report
from app.translation import queue as translation_queue
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
    translated = client.post("/api/translation", json={"text": "zzzzword"})
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

    response = client.post("/api/translation", json={"text": "zzzzword"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_kind"] == "word"
    assert "AI 配置不可用" in payload["result_markdown"]
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert len(entries) == 1
    assert entries[0].source_text == "zzzzword"
    app.dependency_overrides.clear()


def test_netem_dictionary_word_uses_ai_prompt_instead_of_thin_dictionary_markdown(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    captured: dict[str, str] = {}

    async def fake_complete_chat(messages, model, fallback, ai_config):
        captured["user"] = messages[1]["content"]
        return "音标：/əˈbændən/\n\n### 释义\n- **abandon**：放弃；抛弃。\n\n### 用法\n- abandon a plan：放弃计划。"

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)

    response = client.post("/api/translation", json={"text": "abandon"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_kind"] == "word"
    assert payload["source_text"] == "abandon"
    assert payload["phonetic"] == "/əˈbændən/"
    assert "输入内容：\nabandon" in captured["user"]
    assert "考纲释义" not in payload["result_markdown"]
    assert "词频" not in payload["result_markdown"]
    assert "abandon a plan" in payload["result_markdown"]
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert len(entries) == 1
    assert entries[0].detail_status == "ready"
    app.dependency_overrides.clear()


def test_inflected_dictionary_word_is_stored_as_lemma(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    captured: dict[str, str] = {}

    async def fake_complete_chat(messages, model, fallback, ai_config):
        captured["user"] = messages[1]["content"]
        return "音标：/rɪˈkwaɪər/\n\n### 释义\n- **require**：需要；要求。"

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)

    response = client.post("/api/translation", json={"text": "requires"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_text"] == "require"
    assert "输入内容：\nrequire" in captured["user"]
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert len(entries) == 1
    assert entries[0].source_text == "require"
    app.dependency_overrides.clear()


def test_english_sentence_normalizes_auto_word_details_and_queues_ai_generation(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    queued_entry_ids: list[int] = []

    async def fake_complete_chat(messages, model, fallback, ai_config):
        return "音标：/ˈrɛspɑːns/\n\n### 译文\n责任需要行动。"

    def fake_enqueue_word_detail_job(entry_id, session_factory, ai_config):
        queued_entry_ids.append(entry_id)

    monkeypatch.setattr(translation_routes, "complete_chat", fake_complete_chat)
    monkeypatch.setattr(translation_routes, "enqueue_word_detail_job", fake_enqueue_word_detail_job, raising=False)

    response = client.post("/api/translation", json={"text": "Teams required studies and response"})

    assert response.status_code == 200
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry).where(TranslationEntry.user_id == 1)).all()
    words = {entry.source_text: entry for entry in entries if entry.source_kind == "word"}
    assert "team" in words
    assert "require" in words
    assert "study" in words
    assert "teams" not in words
    assert "required" not in words
    assert "studies" not in words
    assert words["require"].is_auto_detail is True
    assert words["require"].detail_status == "queued"
    assert words["require"].result_markdown == ""
    assert words["require"].id in queued_entry_ids
    app.dependency_overrides.clear()


def test_dictionary_entry_api_creates_ai_detail_job_for_dictionary_word(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    queued_entry_ids: list[int] = []

    def fake_enqueue_word_detail_job(entry_id, session_factory, ai_config):
        queued_entry_ids.append(entry_id)

    monkeypatch.setattr(translation_routes, "enqueue_word_detail_job", fake_enqueue_word_detail_job, raising=False)

    response = client.post("/api/translation/dictionary-entry", json={"text": "responsibilities"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_kind"] == "word"
    assert payload["source_text"] == "responsibility"
    assert payload["detail_status"] == "queued"
    assert payload["phonetic"] == "/ɹiˌspɑnsəˈbɪɫəti/"
    assert payload["result_markdown"] == ""
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert len(entries) == 1
    assert entries[0].source_text == "responsibility"
    assert entries[0].id in queued_entry_ids
    app.dependency_overrides.clear()


def test_dictionary_entry_api_creates_ai_detail_job_for_word_outside_dictionary(tmp_path: Path, monkeypatch):
    client, session_factory = make_client(tmp_path)
    login_admin(client)
    queued_entry_ids: list[int] = []

    def fake_enqueue_word_detail_job(entry_id, session_factory, ai_config):
        queued_entry_ids.append(entry_id)

    monkeypatch.setattr(translation_routes, "enqueue_word_detail_job", fake_enqueue_word_detail_job, raising=False)

    response = client.post("/api/translation/dictionary-entry", json={"text": "zzzzwords"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["source_text"] == "zzzzword"
    assert payload["detail_status"] == "queued"
    assert payload["result_markdown"] == ""
    with session_factory() as db:
        entries = db.scalars(select(TranslationEntry)).all()
    assert len(entries) == 1
    assert entries[0].id in queued_entry_ids
    app.dependency_overrides.clear()


def test_word_detail_worker_uses_ai_even_when_dictionary_matches(tmp_path: Path, monkeypatch):
    _client, session_factory = make_client(tmp_path)
    captured: dict[str, str] = {}
    with session_factory() as db:
        db.add(
            TranslationEntry(
                user_id=1,
                source_text="abandon",
                source_kind="word",
                result_markdown="",
                detail_status="queued",
                is_auto_detail=True,
            )
        )
        db.commit()
        entry_id = db.scalar(select(TranslationEntry.id))

    async def fake_complete_chat(messages, model, fallback, ai_config):
        captured["user"] = messages[1]["content"]
        return "音标：/əˈbændən/\n\n### 释义\n- **abandon**：放弃；抛弃。\n\n### 例句\n- Never abandon your plan too early."

    monkeypatch.setattr(translation_queue, "complete_chat", fake_complete_chat)

    import anyio

    anyio.run(translation_queue.generate_word_detail, entry_id, session_factory)

    with session_factory() as db:
        entry = db.get(TranslationEntry, entry_id)
    assert "输入内容：\nabandon" in captured["user"]
    assert entry.detail_status == "ready"
    assert entry.phonetic == "/əˈbændən/"
    assert "Never abandon your plan" in entry.result_markdown
    assert "考纲释义" not in entry.result_markdown
    app.dependency_overrides.clear()


def test_startup_requeues_old_thin_dictionary_markdown(tmp_path: Path, monkeypatch):
    _client, session_factory = make_client(tmp_path)
    queued_entry_ids: list[int] = []
    with session_factory() as db:
        db.add(
            TranslationEntry(
                user_id=1,
                source_text="abandon",
                source_kind="word",
                result_markdown="### 考纲释义\n- **abandon**：抛弃\n\n### 记忆信息\n- 词频：1",
                detail_status="ready",
                is_auto_detail=False,
            )
        )
        db.commit()
        entry_id = db.scalar(select(TranslationEntry.id))

    def fake_enqueue_word_detail_job(entry_id, session_factory, ai_config=None):
        queued_entry_ids.append(entry_id)

    monkeypatch.setattr(translation_queue, "enqueue_word_detail_job", fake_enqueue_word_detail_job)

    translation_queue.enqueue_pending_word_detail_jobs(session_factory)

    with session_factory() as db:
        entry = db.get(TranslationEntry, entry_id)
    assert entry.detail_status == "queued"
    assert entry.result_markdown == ""
    assert entry.is_auto_detail is True
    assert queued_entry_ids == [entry_id]
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
