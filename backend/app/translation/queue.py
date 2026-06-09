import asyncio

from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.admin.ai_config import AiConfig, get_ai_config
from app.ai_client import complete_chat
from app.config import settings
from app.models import TranslationEntry
from app.translation.service import (
    build_word_detail_user_prompt,
    extract_phonetic_and_markdown,
    fallback_translation,
    find_existing_ready_word_detail,
    get_translation_prompt,
    is_thin_dictionary_markdown,
    save_cached_word_detail,
)
from app.translation.vocabulary import find_netem_word


word_detail_queue: asyncio.Queue[tuple[int, AiConfig | None]] | None = None
word_detail_worker_task: asyncio.Task | None = None
word_detail_session_factory: sessionmaker[Session] | None = None
queued_word_detail_ids: set[int] = set()


def _ensure_worker(session_factory: sessionmaker[Session]) -> asyncio.Queue[tuple[int, AiConfig | None]] | None:
    global word_detail_queue, word_detail_worker_task, word_detail_session_factory
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return None
    word_detail_session_factory = session_factory
    if word_detail_queue is None:
        word_detail_queue = asyncio.Queue()
    if word_detail_worker_task is None or word_detail_worker_task.done():
        word_detail_worker_task = asyncio.create_task(_word_detail_worker())
    return word_detail_queue


def enqueue_word_detail_job(
    entry_id: int,
    session_factory: sessionmaker[Session],
    ai_config: AiConfig | None = None,
) -> None:
    queue = _ensure_worker(session_factory)
    if queue is None or entry_id in queued_word_detail_ids:
        return
    queued_word_detail_ids.add(entry_id)
    queue.put_nowait((entry_id, ai_config))


def enqueue_pending_word_detail_jobs(session_factory: sessionmaker[Session]) -> None:
    with session_factory() as db:
        thin_entries = db.scalars(
            select(TranslationEntry).where(
                TranslationEntry.source_kind == "word",
                TranslationEntry.detail_status == "ready",
            )
        ).all()
        thin_entry_ids: list[int] = []
        for entry in thin_entries:
            if not is_thin_dictionary_markdown(entry.result_markdown):
                continue
            entry.result_markdown = ""
            entry.detail_status = "queued"
            entry.is_auto_detail = True
            thin_entry_ids.append(entry.id)
        if thin_entry_ids:
            db.commit()
        entry_ids = db.scalars(
            select(TranslationEntry.id).where(
                TranslationEntry.is_auto_detail.is_(True),
                TranslationEntry.detail_status.in_(["queued", "processing"]),
            )
        ).all()
    for entry_id in dict.fromkeys([*entry_ids, *thin_entry_ids]):
        enqueue_word_detail_job(entry_id, session_factory)


async def _word_detail_worker() -> None:
    assert word_detail_queue is not None
    while True:
        entry_id, ai_config = await word_detail_queue.get()
        queued_word_detail_ids.discard(entry_id)
        try:
            if word_detail_session_factory is not None:
                await generate_word_detail(entry_id, word_detail_session_factory, ai_config)
        finally:
            word_detail_queue.task_done()


async def generate_word_detail(
    entry_id: int,
    session_factory: sessionmaker[Session],
    ai_config: AiConfig | None = None,
) -> None:
    with session_factory() as db:
        entry = db.get(TranslationEntry, entry_id)
        if entry is None or not entry.is_auto_detail:
            return
        if entry.detail_status == "ready" and entry.result_markdown.strip():
            return
        entry.detail_status = "processing"
        db.commit()
        word = entry.source_text
        cached = find_existing_ready_word_detail(db, word)
        if cached is not None:
            entry.phonetic = cached.phonetic or entry.phonetic
            entry.result_markdown = cached.result_markdown
            entry.detail_status = "ready"
            db.commit()
            return
        dictionary_entry = find_netem_word(word)
        if dictionary_entry is not None:
            entry.phonetic = dictionary_entry.phonetic or None
            db.commit()
        user_id = entry.user_id
        system_prompt = get_translation_prompt(db, user_id)
        config = ai_config or get_ai_config(db)

    fallback = fallback_translation(word, "word")
    try:
        result = await complete_chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": build_word_detail_user_prompt(word)},
            ],
            model=settings.ai_default_model,
            fallback=fallback,
            ai_config=config,
        )
        phonetic, markdown = extract_phonetic_and_markdown(result)
        with session_factory() as db:
            entry = db.get(TranslationEntry, entry_id)
            if entry is None:
                return
            entry.phonetic = phonetic or entry.phonetic
            entry.result_markdown = markdown
            entry.detail_status = "ready"
            db.commit()
            save_cached_word_detail(db, entry.source_text, entry.phonetic, entry.result_markdown)
    except Exception:
        with session_factory() as db:
            entry = db.get(TranslationEntry, entry_id)
            if entry is None:
                return
            entry.detail_status = "failed"
            if not entry.result_markdown.strip():
                entry.result_markdown = fallback
            db.commit()
