import asyncio
from datetime import date, datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, sessionmaker

from app.app_settings import ApplicationSettings, get_app_settings, split_report_time
from app.config import settings
from app.db import SessionLocal
from app.models import Attachment, ChatSession, Message
from app.reports.service import all_users, generate_daily_report_async, generate_monthly_report, generate_weekly_report


def cleanup_expired_data(session_factory: sessionmaker[Session] = SessionLocal, now: datetime | None = None) -> None:
    current = now or datetime.utcnow()
    cutoff = current - timedelta(days=7)
    with session_factory() as db:
        archived_message_ids = select(Message.id).join(ChatSession, Message.session_id == ChatSession.id).where(
            ChatSession.is_archived.is_(True)
        )
        attachments = db.scalars(
            select(Attachment).where(
                Attachment.expires_at < current,
                or_(Attachment.message_id.is_(None), Attachment.message_id.not_in(archived_message_ids)),
            )
        ).all()
        for attachment in attachments:
            path = Path(attachment.file_path)
            if path.exists():
                path.unlink()
            db.delete(attachment)

        old_sessions = db.scalars(
            select(ChatSession).where(ChatSession.updated_at < cutoff, ChatSession.is_archived.is_(False))
        ).all()
        for session in old_sessions:
            messages = db.scalars(select(Message).where(Message.session_id == session.id)).all()
            for message in messages:
                db.delete(message)
            db.delete(session)
        db.commit()


async def run_report_jobs_for_day(day: date, session_factory: sessionmaker[Session] = SessionLocal) -> None:
    await run_daily_report_job(day, session_factory)
    await run_weekly_report_job(day, session_factory)
    await run_monthly_report_job(day, session_factory)
    cleanup_expired_data(session_factory=session_factory)


async def run_daily_report_job(day: date, session_factory: sessionmaker[Session] = SessionLocal) -> None:
    with session_factory() as db:
        users = all_users(db)
        for user in users:
            await generate_daily_report_async(db, user.id, day)


async def run_weekly_report_job(day: date, session_factory: sessionmaker[Session] = SessionLocal) -> None:
    if day.weekday() != 6:
        return
    with session_factory() as db:
        users = all_users(db)
        for user in users:
            generate_weekly_report(db, user.id, day)


async def run_monthly_report_job(day: date, session_factory: sessionmaker[Session] = SessionLocal) -> None:
    tomorrow = day + timedelta(days=1)
    if tomorrow.month == day.month:
        return
    with session_factory() as db:
        users = all_users(db)
        for user in users:
            generate_monthly_report(db, user.id, day)


def _run_daily_job() -> None:
    asyncio.run(run_daily_report_job(date.today()))
    cleanup_expired_data()


def _run_weekly_job() -> None:
    asyncio.run(run_weekly_report_job(date.today()))


def _run_monthly_job() -> None:
    asyncio.run(run_monthly_report_job(date.today()))


def reschedule_report_jobs(scheduler: BackgroundScheduler, app_settings: ApplicationSettings | None = None) -> None:
    if app_settings is None:
        with SessionLocal() as db:
            app_settings = get_app_settings(db)
    daily_hour, daily_minute = split_report_time(app_settings.daily_report_time)
    weekly_hour, weekly_minute = split_report_time(app_settings.weekly_report_time)
    monthly_hour, monthly_minute = split_report_time(app_settings.monthly_report_time)

    scheduler.add_job(
        _run_daily_job,
        "cron",
        id="daily_report",
        replace_existing=True,
        hour=daily_hour,
        minute=daily_minute,
    )
    scheduler.add_job(
        _run_weekly_job,
        "cron",
        id="weekly_report",
        replace_existing=True,
        day_of_week="sun",
        hour=weekly_hour,
        minute=weekly_minute,
    )
    scheduler.add_job(
        _run_monthly_job,
        "cron",
        id="monthly_report",
        replace_existing=True,
        hour=monthly_hour,
        minute=monthly_minute,
    )


def start_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone=settings.app_timezone)
    reschedule_report_jobs(scheduler)
    scheduler.start()
    return scheduler
