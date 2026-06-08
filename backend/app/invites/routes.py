import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import InviteCode, User
from app.security import require_admin


router = APIRouter(prefix="/api/invites", tags=["invites"])


class CreateInviteRequest(BaseModel):
    expires_days: int = Field(default=7, ge=1, le=365)


class InviteResponse(BaseModel):
    code: str
    is_used: bool
    expires_at: datetime | None
    created_at: datetime


def invite_response(invite: InviteCode) -> InviteResponse:
    return InviteResponse(
        code=invite.code,
        is_used=invite.is_used,
        expires_at=invite.expires_at,
        created_at=invite.created_at,
    )


@router.post("", response_model=InviteResponse)
def create_invite(
    payload: CreateInviteRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> InviteResponse:
    invite = InviteCode(
        code=secrets.token_urlsafe(18),
        created_by_id=admin.id,
        expires_at=datetime.utcnow() + timedelta(days=payload.expires_days),
    )
    db.add(invite)
    db.commit()
    db.refresh(invite)
    return invite_response(invite)


@router.get("", response_model=list[InviteResponse])
def list_invites(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> list[InviteResponse]:
    invites = db.scalars(select(InviteCode).order_by(InviteCode.created_at.desc())).all()
    return [invite_response(invite) for invite in invites]
