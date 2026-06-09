import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import AppSetting


DAILY_REPORT_TIME_KEY = "report_daily_time"
WEEKLY_REPORT_TIME_KEY = "report_weekly_time"
WEEKLY_REPORT_DAY_KEY = "report_weekly_day"
WORD_CLOUD_ENABLED_KEY = "word_cloud_enabled"
DEFAULT_REPORT_TIME = "23:00"
DEFAULT_WEEKLY_REPORT_DAY = "sun"
TIME_PATTERN = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
WEEKLY_DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
WEEKLY_DAY_INDEX = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


@dataclass(frozen=True)
class ApplicationSettings:
    daily_report_time: str = DEFAULT_REPORT_TIME
    weekly_report_time: str = DEFAULT_REPORT_TIME
    weekly_report_day: str = DEFAULT_WEEKLY_REPORT_DAY
    word_cloud_enabled: bool = True


def validate_report_time(value: str) -> str:
    normalized = value.strip()
    if not TIME_PATTERN.fullmatch(normalized):
        raise ValueError("时间格式必须为 HH:MM")
    return normalized


def validate_weekly_report_day(value: str) -> str:
    normalized = value.strip().lower()
    if normalized not in WEEKLY_DAYS:
        raise ValueError("周报生成日无效")
    return normalized


def weekly_report_day_index(value: str) -> int:
    return WEEKLY_DAY_INDEX[validate_weekly_report_day(value)]


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
    weekly_day = _get_setting(db, WEEKLY_REPORT_DAY_KEY) or DEFAULT_WEEKLY_REPORT_DAY
    return ApplicationSettings(
        daily_report_time=validate_report_time(daily_time),
        weekly_report_time=validate_report_time(weekly_time),
        weekly_report_day=validate_weekly_report_day(weekly_day),
        word_cloud_enabled=_setting_bool(_get_setting(db, WORD_CLOUD_ENABLED_KEY), True),
    )


def update_app_settings(
    db: Session,
    daily_report_time: str,
    weekly_report_time: str,
    weekly_report_day: str,
    word_cloud_enabled: bool,
) -> ApplicationSettings:
    _set_setting(db, DAILY_REPORT_TIME_KEY, validate_report_time(daily_report_time))
    _set_setting(db, WEEKLY_REPORT_TIME_KEY, validate_report_time(weekly_report_time))
    _set_setting(db, WEEKLY_REPORT_DAY_KEY, validate_weekly_report_day(weekly_report_day))
    _set_setting(db, WORD_CLOUD_ENABLED_KEY, "true" if word_cloud_enabled else "false")
    db.commit()
    return get_app_settings(db)
