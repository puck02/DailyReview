from fastapi import FastAPI

from app.auth.routes import router as auth_router
from app.chat.routes import router as chat_router
from app.db import initialize_database
from app.invites.routes import router as invites_router


app = FastAPI(title="DailyReview")
app.include_router(auth_router)
app.include_router(invites_router)
app.include_router(chat_router)


@app.on_event("startup")
def startup() -> None:
    initialize_database()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
