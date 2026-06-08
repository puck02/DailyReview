from fastapi import FastAPI


app = FastAPI(title="DailyReview")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
