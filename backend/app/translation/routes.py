from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.admin.ai_config import get_ai_config
from app.ai_client import complete_chat
from app.config import settings
from app.db import get_db
from app.models import TranslationEntry, User
from app.security import get_current_user
from app.translation.service import (
    build_translation_user_prompt,
    detect_source_kind,
    fallback_translation,
    get_translation_prompt,
    update_translation_prompt,
)


router = APIRouter(prefix="/api/translation", tags=["translation"])


class TranslationPromptRequest(BaseModel):
    system_prompt: str = Field(max_length=5000)


class TranslationPromptResponse(BaseModel):
    system_prompt: str


class TranslationRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class TranslationResponse(BaseModel):
    id: int
    source_text: str
    source_kind: str
    result_markdown: str
    created_at: datetime


def translation_response(entry: TranslationEntry) -> TranslationResponse:
    return TranslationResponse(
        id=entry.id,
        source_text=entry.source_text,
        source_kind=entry.source_kind,
        result_markdown=entry.result_markdown,
        created_at=entry.created_at,
    )


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


@router.post("", response_model=TranslationResponse)
async def translate_text(
    payload: TranslationRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TranslationResponse:
    text = payload.text.strip()
    source_kind = detect_source_kind(text)
    fallback = fallback_translation(text, source_kind)
    try:
        result = await complete_chat(
            [
                {"role": "system", "content": get_translation_prompt(db, user.id)},
                {"role": "user", "content": build_translation_user_prompt(text, source_kind)},
            ],
            model=settings.ai_default_model,
            fallback=fallback,
            ai_config=get_ai_config(db),
        )
    except Exception:
        result = fallback
    entry = TranslationEntry(
        user_id=user.id,
        source_text=text,
        source_kind=source_kind,
        result_markdown=result,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return translation_response(entry)
