from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from app.app_settings import (
    ApplicationSettings,
    get_app_settings,
    update_app_settings,
    validate_report_time,
    validate_weekly_report_day,
)
from app.db import get_db
from app.models import User
from app.scheduler.jobs import reschedule_report_jobs
from app.security import get_current_user, require_admin


router = APIRouter(prefix="/api/settings", tags=["settings"])


class AppSettingsRequest(BaseModel):
    daily_report_time: str
    weekly_report_time: str
    weekly_report_day: str
    word_cloud_enabled: bool

    @field_validator("daily_report_time", "weekly_report_time")
    @classmethod
    def validate_time(cls, value: str) -> str:
        return validate_report_time(value)

    @field_validator("weekly_report_day")
    @classmethod
    def validate_day(cls, value: str) -> str:
        return validate_weekly_report_day(value)


class AppSettingsResponse(BaseModel):
    daily_report_time: str
    weekly_report_time: str
    weekly_report_day: str
    word_cloud_enabled: bool


def settings_response(settings: ApplicationSettings) -> AppSettingsResponse:
    return AppSettingsResponse(
        daily_report_time=settings.daily_report_time,
        weekly_report_time=settings.weekly_report_time,
        weekly_report_day=settings.weekly_report_day,
        word_cloud_enabled=settings.word_cloud_enabled,
    )


@router.get("", response_model=AppSettingsResponse)
def read_settings(
    _user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> AppSettingsResponse:
    return settings_response(get_app_settings(db))


@router.put("", response_model=AppSettingsResponse)
def save_settings(
    payload: AppSettingsRequest,
    request: Request,
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AppSettingsResponse:
    app_settings = update_app_settings(
        db,
        payload.daily_report_time,
        payload.weekly_report_time,
        payload.weekly_report_day,
        payload.word_cloud_enabled,
    )
    scheduler = getattr(request.app.state, "scheduler", None)
    if scheduler is not None:
        reschedule_report_jobs(scheduler, app_settings)
    return settings_response(app_settings)
