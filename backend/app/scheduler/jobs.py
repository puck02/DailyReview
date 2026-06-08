import asyncio
from datetime import date, datetime, timedelta
from pathlib import Path

from apscheduler.schedulers.background import BackgroundScheduler
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings
from app.db import SessionLocal
from app.models import Attachment, ChatSession, Message
from app.reports.service import all_users, generate_daily_report_async, generate_monthly_report, generate_weekly_report


def cleanup_expired_data(session_factory: sessionmaker[Session] = SessionLocal, now: datetime | None = None) -> None:
    current = now or datetime.utcnow()
    cutoff = current - timedelta(days=7)
    with session_factory() as db:
        attachments = db.scalars(select(Attachment).where(Attachment.expires_at < current)).all()
        for attachment in attachments:
            path = Path(attachment.file_path)
            if path.exists():
                path.unlink()
            db.delete(attachment)

        old_sessions = db.scalars(select(ChatSession).where(ChatSession.updated_at < cutoff)).all()
        for session in old_sessions:
            messages = db.scalars(select(Message).where(Message.session_id == session.id)).all()
            for message in messages:
                db.delete(message)
            db.delete(session)
        db.commit()


async def run_report_jobs_for_day(day: date, session_factory: sessionmaker[Session] = SessionLocal) -> None:
    with session_factory() as db:
        users = all_users(db)
        for user in users:
            await generate_daily_report_async(db, user.id, day)
            if day.weekday() == 6:
                generate_weekly_report(db, user.id, day)
            tomorrow = day + timedelta(days=1)
            if tomorrow.month != day.month:
                generate_monthly_report(db, user.id, day)
    cleanup_expired_data(session_factory=session_factory)


def start_scheduler() -> BackgroundScheduler:
    scheduler = BackgroundScheduler(timezone=settings.app_timezone)
    scheduler.add_job(lambda: asyncio.run(run_report_jobs_for_day(date.today())), "cron", hour=23, minute=0)
    scheduler.start()
    return scheduler
