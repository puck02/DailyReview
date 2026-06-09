import base64
import json
import logging
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.admin.ai_config import get_ai_config
from app.ai_client import stream_chat_completion
from app.config import settings
from app.db import get_db
from app.models import Attachment, ChatSession, Message, User
from app.security import get_current_user
from app.storage.files import UploadTooLargeError, UploadValidationError, save_upload


router = APIRouter(tags=["chat"])
logger = logging.getLogger(__name__)


class SessionCreateRequest(BaseModel):
    title: str = Field(default="新会话", max_length=255)
    model: str = Field(default_factory=lambda: settings.ai_default_model)


class SessionArchiveRequest(BaseModel):
    archived: bool


class SessionResponse(BaseModel):
    id: int
    title: str
    default_model: str
    is_archived: bool
    created_at: datetime
    updated_at: datetime


class AttachmentResponse(BaseModel):
    id: int
    mime_type: str
    size: int
    expires_at: datetime
    url: str


class MessageResponse(BaseModel):
    id: int
    role: str
    content: str
    model: str | None
    created_at: datetime
    attachments: list[AttachmentResponse] = Field(default_factory=list)


class ChatStreamRequest(BaseModel):
    session_id: int
    content: str = Field(min_length=1)
    model: str = Field(default_factory=lambda: settings.ai_default_model)
    attachment_ids: list[int] = Field(default_factory=list)


def session_response(session: ChatSession) -> SessionResponse:
    return SessionResponse(
        id=session.id,
        title=session.title,
        default_model=session.default_model,
        is_archived=session.is_archived,
        created_at=session.created_at,
        updated_at=session.updated_at,
    )


def attachment_response(attachment: Attachment) -> AttachmentResponse:
    return AttachmentResponse(
        id=attachment.id,
        mime_type=attachment.mime_type,
        size=attachment.size,
        expires_at=attachment.expires_at,
        url=f"/api/attachments/{attachment.id}/content",
    )


@router.post("/api/sessions", response_model=SessionResponse)
def create_session(
    payload: SessionCreateRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SessionResponse:
    session = ChatSession(user_id=user.id, title=payload.title or "新会话", default_model=payload.model)
    db.add(session)
    db.commit()
    db.refresh(session)
    return session_response(session)


@router.get("/api/sessions", response_model=list[SessionResponse])
def list_sessions(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[SessionResponse]:
    cutoff = datetime.utcnow() - timedelta(days=7)
    sessions = db.scalars(
        select(ChatSession)
        .where(
            ChatSession.user_id == user.id,
            or_(ChatSession.updated_at >= cutoff, ChatSession.is_archived.is_(True)),
        )
        .order_by(ChatSession.is_archived.asc(), ChatSession.updated_at.desc())
    ).all()
    return [session_response(item) for item in sessions]


@router.patch("/api/sessions/{session_id}/archive", response_model=SessionResponse)
def archive_session(
    session_id: int,
    payload: SessionArchiveRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> SessionResponse:
    session = db.get(ChatSession, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    session.is_archived = payload.archived
    if not payload.archived:
        session.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(session)
    return session_response(session)


@router.get("/api/sessions/{session_id}/messages", response_model=list[MessageResponse])
def list_messages(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[MessageResponse]:
    session = db.get(ChatSession, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    messages = db.scalars(
        select(Message).where(Message.session_id == session.id).order_by(Message.created_at.asc())
    ).all()
    attachments_by_message: dict[int, list[Attachment]] = {message.id: [] for message in messages}
    if attachments_by_message:
        attachments = db.scalars(
            select(Attachment)
            .where(Attachment.message_id.in_(attachments_by_message.keys()))
            .order_by(Attachment.id.asc())
        ).all()
        for attachment in attachments:
            if attachment.message_id is not None:
                attachments_by_message[attachment.message_id].append(attachment)
    return [
        MessageResponse(
            id=message.id,
            role=message.role,
            content=message.content,
            model=message.model,
            created_at=message.created_at,
            attachments=[attachment_response(attachment) for attachment in attachments_by_message[message.id]],
        )
        for message in messages
    ]


@router.delete("/api/sessions/{session_id}")
def delete_session(
    session_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    session = db.get(ChatSession, session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")
    for message in db.scalars(select(Message).where(Message.session_id == session.id)).all():
        for attachment in db.scalars(select(Attachment).where(Attachment.message_id == message.id)).all():
            attachment.message_id = None
        db.delete(message)
    db.delete(session)
    db.commit()
    return {"status": "ok"}


@router.post("/api/attachments", response_model=AttachmentResponse)
def upload_attachment(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AttachmentResponse:
    try:
        path, size, mime_type = save_upload(file, user.id)
    except UploadTooLargeError as error:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail=str(error)) from error
    except UploadValidationError as error:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(error)) from error
    attachment = Attachment(
        user_id=user.id,
        file_path=str(path),
        mime_type=mime_type,
        size=size,
        expires_at=datetime.utcnow() + timedelta(days=7),
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)
    return attachment_response(attachment)


@router.get("/api/attachments/{attachment_id}/content")
def attachment_content(
    attachment_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    attachment = db.get(Attachment, attachment_id)
    if attachment is None or attachment.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")
    path = Path(attachment.file_path)
    if not path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="附件不存在")
    return FileResponse(path, media_type=attachment.mime_type)


def _history_for_session(db: Session, session_id: int) -> list[dict]:
    messages = db.scalars(
        select(Message).where(Message.session_id == session_id).order_by(Message.created_at.asc())
    ).all()
    return [{"role": message.role, "content": message.content} for message in messages]


def _append_current_images(history: list[dict], attachments: list[Attachment]) -> list[dict]:
    if not attachments or not history:
        return history
    current = history[-1]
    content = [{"type": "text", "text": current["content"]}]
    for attachment in attachments:
        data = base64.b64encode(Path(attachment.file_path).read_bytes()).decode("ascii")
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{attachment.mime_type};base64,{data}"},
            }
        )
    return [*history[:-1], {"role": current["role"], "content": content}]


@router.post("/api/chat/stream")
async def stream_chat(
    payload: ChatStreamRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    session = db.get(ChatSession, payload.session_id)
    if session is None or session.user_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会话不存在")

    user_message = Message(session_id=session.id, role="user", content=payload.content, model=payload.model)
    db.add(user_message)
    session.updated_at = datetime.utcnow()
    if session.title == "新会话":
        session.title = payload.content[:32]
    db.flush()

    current_attachments: list[Attachment] = []
    for attachment_id in payload.attachment_ids:
        attachment = db.get(Attachment, attachment_id)
        if attachment is None or attachment.user_id != user.id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="附件不存在")
        attachment.message_id = user_message.id
        current_attachments.append(attachment)
    db.commit()

    session_id = session.id
    history = _append_current_images(_history_for_session(db, session_id), current_attachments)
    ai_config = get_ai_config(db)
    bind = db.get_bind()
    stream_session_factory = sessionmaker(bind=bind, autoflush=False, autocommit=False)

    async def event_stream():
        assistant_parts: list[str] = []
        try:
            async for token in stream_chat_completion(history, payload.model, ai_config):
                assistant_parts.append(token)
                yield f"data: {json.dumps(token, ensure_ascii=False)}\n\n"
        except Exception as error:
            logger.warning(
                "AI stream failed type=%s status_code=%s host=%s has_base_url=%s has_api_key=%s",
                error.__class__.__name__,
                getattr(getattr(error, "response", None), "status_code", None),
                urlparse(ai_config.base_url).hostname or "",
                bool(ai_config.base_url),
                bool(ai_config.api_key),
            )
            token = "AI 服务连接失败，请稍后重试。"
            assistant_parts.append(token)
            yield f"data: {json.dumps(token, ensure_ascii=False)}\n\n"
        assistant_content = "".join(assistant_parts)
        with stream_session_factory() as stream_db:
            stream_session = stream_db.get(ChatSession, session_id)
            if stream_session is not None:
                assistant_message = Message(
                    session_id=session_id,
                    role="assistant",
                    content=assistant_content,
                    model=payload.model,
                )
                stream_db.add(assistant_message)
                stream_session.updated_at = datetime.utcnow()
                stream_db.commit()
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
