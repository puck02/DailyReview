import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import AppSetting


DAILY_REPORT_TIME_KEY = "report_daily_time"
WEEKLY_REPORT_TIME_KEY = "report_weekly_time"
MONTHLY_REPORT_TIME_KEY = "report_monthly_time"
WORD_CLOUD_ENABLED_KEY = "word_cloud_enabled"
DEFAULT_REPORT_TIME = "23:00"
TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")


@dataclass(frozen=True)
class ApplicationSettings:
    daily_report_time: str = DEFAULT_REPORT_TIME
    weekly_report_time: str = DEFAULT_REPORT_TIME
    monthly_report_time: str = DEFAULT_REPORT_TIME
    word_cloud_enabled: bool = True


def validate_report_time(value: str) -> str:
    normalized = value.strip()
    if not TIME_PATTERN.fullmatch(normalized):
        raise ValueError("时间格式必须为 HH:MM")
    return normalized


def split_report_time(value: str) -> tuple[int, int]:
    normalized = validate_report_time(value)
    hour, minute = normalized.split(":", 1)
    return int(hour), int(minute)


def _get_setting(db: Session, key: str) -> str:
    setting = db.get(AppSetting, key)
    return setting.value if setting is not None else ""


def _set_setting(db: Session, key: str, value: str) -> None:
    setting = db.get(AppSetting, key)
    if setting is None:
        db.add(AppSetting(key=key, value=value))
    else:
        setting.value = value


def _setting_bool(value: str, default: bool) -> bool:
    if value == "":
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def get_app_settings(db: Session) -> ApplicationSettings:
    daily_time = _get_setting(db, DAILY_REPORT_TIME_KEY) or DEFAULT_REPORT_TIME
    weekly_time = _get_setting(db, WEEKLY_REPORT_TIME_KEY) or DEFAULT_REPORT_TIME
    monthly_time = _get_setting(db, MONTHLY_REPORT_TIME_KEY) or DEFAULT_REPORT_TIME
    return ApplicationSettings(
        daily_report_time=validate_report_time(daily_time),
        weekly_report_time=validate_report_time(weekly_time),
        monthly_report_time=validate_report_time(monthly_time),
        word_cloud_enabled=_setting_bool(_get_setting(db, WORD_CLOUD_ENABLED_KEY), True),
    )


def update_app_settings(
    db: Session,
    daily_report_time: str,
    weekly_report_time: str,
    monthly_report_time: str,
    word_cloud_enabled: bool,
) -> ApplicationSettings:
    _set_setting(db, DAILY_REPORT_TIME_KEY, validate_report_time(daily_report_time))
    _set_setting(db, WEEKLY_REPORT_TIME_KEY, validate_report_time(weekly_report_time))
    _set_setting(db, MONTHLY_REPORT_TIME_KEY, validate_report_time(monthly_report_time))
    _set_setting(db, WORD_CLOUD_ENABLED_KEY, "true" if word_cloud_enabled else "false")
    db.commit()
    return get_app_settings(db)
