from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

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

frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.exists():
    assets_dir = frontend_dist / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")


@app.on_event("startup")
def startup() -> None:
    initialize_database()
    if not getattr(app.state, "scheduler_started", False):
        app.state.scheduler = start_scheduler()
        app.state.scheduler_started = True


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/{full_path:path}")
def serve_frontend(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(status_code=404, detail="Not found")
    index = frontend_dist / "index.html"
    if not index.exists():
        raise HTTPException(status_code=404, detail="Frontend not built")
    return FileResponse(index)
