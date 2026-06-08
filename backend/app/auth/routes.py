from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import InviteCode, User
from app.security import create_access_token, get_current_user, hash_password, verify_password


router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1)


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8)
    invite_code: str = Field(min_length=1)


class UserResponse(BaseModel):
    id: int
    email: str
    role: str


def user_response(user: User) -> UserResponse:
    return UserResponse(id=user.id, email=user.email, role=user.role)


@router.post("/login", response_model=UserResponse)
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> UserResponse:
    user = db.scalar(select(User).where(User.email == payload.email.lower()))
    if user is None or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="邮箱或密码错误")
    response.set_cookie(
        "session",
        create_access_token(user.id),
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 60 * 60,
    )
    return user_response(user)


@router.post("/register", response_model=UserResponse)
def register(payload: RegisterRequest, response: Response, db: Session = Depends(get_db)) -> UserResponse:
    email = payload.email.lower()
    existing = db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="邮箱已注册")

    invite = db.scalar(select(InviteCode).where(InviteCode.code == payload.invite_code))
    now = datetime.utcnow()
    if invite is None or invite.is_used or (invite.expires_at is not None and invite.expires_at < now):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="邀请码无效")

    user = User(email=email, password_hash=hash_password(payload.password), role="user")
    db.add(user)
    db.flush()
    invite.is_used = True
    invite.used_by_id = user.id
    db.commit()
    db.refresh(user)

    response.set_cookie(
        "session",
        create_access_token(user.id),
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 60 * 60,
    )
    return user_response(user)


@router.post("/logout")
def logout(response: Response) -> dict[str, str]:
    response.delete_cookie("session")
    return {"status": "ok"}


@router.get("/me", response_model=UserResponse)
def me(user: User = Depends(get_current_user)) -> UserResponse:
    return user_response(user)
