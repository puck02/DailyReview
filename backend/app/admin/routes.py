from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.admin.ai_config import get_ai_config, update_ai_config
from app.db import get_db
from app.models import User
from app.security import require_admin


router = APIRouter(prefix="/api/admin", tags=["admin"])


class AiConfigRequest(BaseModel):
    base_url: str = Field(min_length=1, max_length=2048)
    api_key: str | None = Field(default=None, max_length=4096)


class AiConfigResponse(BaseModel):
    base_url: str
    has_api_key: bool


def ai_config_response(base_url: str, api_key: str) -> AiConfigResponse:
    return AiConfigResponse(base_url=base_url, has_api_key=bool(api_key))


@router.get("/ai-config", response_model=AiConfigResponse)
def read_ai_config(
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AiConfigResponse:
    config = get_ai_config(db)
    return ai_config_response(config.base_url, config.api_key)


@router.put("/ai-config", response_model=AiConfigResponse)
def save_ai_config(
    payload: AiConfigRequest,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AiConfigResponse:
    config = update_ai_config(db, payload.base_url, payload.api_key)
    return ai_config_response(config.base_url, config.api_key)
