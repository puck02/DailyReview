from fastapi import FastAPI

from app.auth.routes import router as auth_router
from app.chat.routes import router as chat_router
from app.db import initialize_database
from app.invites.routes import router as invites_router
from app.reports.routes import router as reports_router
from app.scheduler.jobs import start_scheduler


app = FastAPI(title="DailyReview")
app.include_router(auth_router)
app.include_router(invites_router)
app.include_router(chat_router)
app.include_router(reports_router)


@app.on_event("startup")
def startup() -> None:
    initialize_database()
    if not getattr(app.state, "scheduler_started", False):
        app.state.scheduler = start_scheduler()
        app.state.scheduler_started = True


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
