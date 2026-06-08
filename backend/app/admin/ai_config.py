from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.config import settings
from app.models import AppSetting


AI_BASE_URL_KEY = "ai_base_url"
AI_API_KEY_KEY = "ai_api_key"


@dataclass(frozen=True)
class AiConfig:
    base_url: str
    api_key: str


def _get_setting(db: Session, key: str) -> str:
    setting = db.get(AppSetting, key)
    return setting.value if setting is not None else ""


def _set_setting(db: Session, key: str, value: str) -> None:
    setting = db.get(AppSetting, key)
    if setting is None:
        setting = AppSetting(key=key, value=value)
        db.add(setting)
    else:
        setting.value = value


def get_ai_config(db: Session | None = None) -> AiConfig:
    if db is None:
        return AiConfig(base_url=settings.ai_base_url, api_key=settings.ai_api_key)
    return AiConfig(
        base_url=_get_setting(db, AI_BASE_URL_KEY) or settings.ai_base_url,
        api_key=_get_setting(db, AI_API_KEY_KEY) or settings.ai_api_key,
    )


def update_ai_config(db: Session, base_url: str, api_key: str | None) -> AiConfig:
    _set_setting(db, AI_BASE_URL_KEY, base_url.strip())
    if api_key:
        _set_setting(db, AI_API_KEY_KEY, api_key.strip())
    db.commit()
    return get_ai_config(db)
