from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.admin.ai_config import get_ai_config
from app.ai_client import complete_chat
from app.config import settings
from app.db import get_db
from app.models import TranslationEntry, User
from app.security import get_current_user
from app.translation.service import (
    build_translation_user_prompt,
    detect_source_kind,
    extract_phonetic_and_markdown,
    fallback_translation,
    get_translation_prompt,
    labels_for_auto_word_details,
    update_translation_prompt,
)
from app.translation.queue import enqueue_word_detail_job
from app.translation.vocabulary import find_netem_word, render_netem_markdown


router = APIRouter(prefix="/api/translation", tags=["translation"])
TRANSLATION_INPUT_LIMIT = 2000
TRANSLATION_LIMIT_MESSAGE = "输入超过 2000 字，已超限，不予翻译。"


class TranslationPromptRequest(BaseModel):
    system_prompt: str = Field(max_length=5000)


class TranslationPromptResponse(BaseModel):
    system_prompt: str


class TranslationRequest(BaseModel):
    text: str = Field(min_length=1)


class TranslationResponse(BaseModel):
    id: int
    source_text: str
    source_kind: str
    phonetic: str | None
    result_markdown: str
    detail_status: str
    is_auto_detail: bool
    created_at: datetime


def translation_response(entry: TranslationEntry) -> TranslationResponse:
    return TranslationResponse(
        id=entry.id,
        source_text=entry.source_text,
        source_kind=entry.source_kind,
        phonetic=entry.phonetic,
        result_markdown=entry.result_markdown,
        detail_status=entry.detail_status,
        is_auto_detail=entry.is_auto_detail,
        created_at=entry.created_at,
    )


def _session_factory_for(db: Session) -> sessionmaker[Session]:
    return sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False)


def _save_dictionary_entry(db: Session, user_id: int, text: str, is_auto_detail: bool) -> TranslationEntry | None:
    dictionary_entry = find_netem_word(text)
    if dictionary_entry is None:
        return None
    source_text = dictionary_entry.word
    entry = db.scalar(
        select(TranslationEntry).where(
            TranslationEntry.user_id == user_id,
            TranslationEntry.source_kind == "word",
            TranslationEntry.source_text == source_text,
        )
    )
    is_new_entry = entry is None
    if entry is None:
        entry = TranslationEntry(user_id=user_id, source_text=source_text, source_kind="word")
        db.add(entry)
    entry.phonetic = dictionary_entry.phonetic or None
    entry.result_markdown = render_netem_markdown(dictionary_entry)
    entry.detail_status = "ready"
    if is_new_entry or not is_auto_detail:
        entry.is_auto_detail = is_auto_detail
    db.commit()
    db.refresh(entry)
    return entry


@router.get("/prompt", response_model=TranslationPromptResponse)
def read_translation_prompt(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TranslationPromptResponse:
    return TranslationPromptResponse(system_prompt=get_translation_prompt(db, user.id))


@router.put("/prompt", response_model=TranslationPromptResponse)
def save_translation_prompt(
    payload: TranslationPromptRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TranslationPromptResponse:
    return TranslationPromptResponse(system_prompt=update_translation_prompt(db, user.id, payload.system_prompt))


@router.get("/entries", response_model=list[TranslationResponse])
def list_translation_entries(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TranslationResponse]:
    entries = db.scalars(
        select(TranslationEntry)
        .where(TranslationEntry.user_id == user.id)
        .order_by(TranslationEntry.created_at.desc(), TranslationEntry.id.desc())
        .limit(30)
    ).all()
    return [translation_response(entry) for entry in entries]


@router.post("/dictionary-entry", response_model=TranslationResponse)
def get_dictionary_entry(
    payload: TranslationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TranslationResponse:
    entry = _save_dictionary_entry(db, user.id, payload.text.strip(), is_auto_detail=True)
    if entry is None:
        raise HTTPException(status_code=404, detail="未在考研英语一词典中命中")
    return translation_response(entry)


@router.post("", response_model=TranslationResponse)
async def translate_text(
    payload: TranslationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TranslationResponse:
    if len(payload.text) > TRANSLATION_INPUT_LIMIT:
        raise HTTPException(status_code=400, detail=TRANSLATION_LIMIT_MESSAGE)
    text = payload.text.strip()
    source_kind = detect_source_kind(text)
    if source_kind == "word":
        entry = _save_dictionary_entry(db, user.id, text, is_auto_detail=False)
        if entry is not None:
            return translation_response(entry)

    fallback = fallback_translation(text, source_kind)
    ai_config = get_ai_config(db)
    try:
        result = await complete_chat(
            [
                {"role": "system", "content": get_translation_prompt(db, user.id)},
                {"role": "user", "content": build_translation_user_prompt(text, source_kind)},
            ],
            model=settings.ai_default_model,
            fallback=fallback,
            ai_config=ai_config,
        )
    except Exception:
        result = fallback
    phonetic, markdown = extract_phonetic_and_markdown(result)
    entry = TranslationEntry(
        user_id=user.id,
        source_text=text,
        source_kind=source_kind,
        phonetic=phonetic,
        result_markdown=markdown,
        detail_status="ready",
        is_auto_detail=False,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    queued_entries: list[TranslationEntry] = []
    if source_kind == "english":
        existing_words = {
            item.source_text.lower()
            for item in db.scalars(
                select(TranslationEntry).where(
                    TranslationEntry.user_id == user.id,
                    TranslationEntry.source_kind == "word",
                )
            ).all()
        }
        for label in labels_for_auto_word_details(text):
            if label in existing_words:
                continue
            detail_entry = _save_dictionary_entry(db, user.id, label, is_auto_detail=True)
            if detail_entry is not None:
                existing_words.add(label)
                continue
            detail_entry = TranslationEntry(
                user_id=user.id,
                source_text=label,
                source_kind="word",
                result_markdown="",
                detail_status="queued",
                is_auto_detail=True,
            )
            db.add(detail_entry)
            queued_entries.append(detail_entry)
            existing_words.add(label)
        db.commit()
        for detail_entry in queued_entries:
            db.refresh(detail_entry)
            enqueue_word_detail_job(detail_entry.id, _session_factory_for(db), ai_config)
    return translation_response(entry)
