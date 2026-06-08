import base64
from datetime import datetime, timedelta
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.ai_client import stream_chat_completion
from app.config import settings
from app.db import get_db
from app.models import Attachment, ChatSession, Message, User
from app.security import get_current_user
from app.storage.files import save_upload


router = APIRouter(tags=["chat"])


class SessionCreateRequest(BaseModel):
    title: str = Field(default="新会话", max_length=255)
    model: str = Field(default_factory=lambda: settings.ai_default_model)


class SessionResponse(BaseModel):
    id: int
    title: str
    default_model: str
    created_at: datetime
    updated_at: datetime


class AttachmentResponse(BaseModel):
    id: int
    mime_type: str
    size: int
    expires_at: datetime


class MessageResponse(BaseModel):
    id: int
    role: str
    content: str
    model: str | None
    created_at: datetime


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
        created_at=session.created_at,
        updated_at=session.updated_at,
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
        .where(ChatSession.user_id == user.id, ChatSession.updated_at >= cutoff)
        .order_by(ChatSession.updated_at.desc())
    ).all()
    return [session_response(item) for item in sessions]


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
    return [
        MessageResponse(
            id=message.id,
            role=message.role,
            content=message.content,
            model=message.model,
            created_at=message.created_at,
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
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="只支持图片上传")
    path, size = save_upload(file, user.id)
    attachment = Attachment(
        user_id=user.id,
        file_path=str(path),
        mime_type=file.content_type,
        size=size,
        expires_at=datetime.utcnow() + timedelta(days=7),
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)
    return AttachmentResponse(
        id=attachment.id,
        mime_type=attachment.mime_type,
        size=attachment.size,
        expires_at=attachment.expires_at,
    )


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
    bind = db.get_bind()
    stream_session_factory = sessionmaker(bind=bind, autoflush=False, autocommit=False)

    async def event_stream():
        assistant_parts: list[str] = []
        async for token in stream_chat_completion(history, payload.model):
            assistant_parts.append(token)
            yield f"data: {token}\n\n"
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
