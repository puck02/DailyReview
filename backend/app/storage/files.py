from pathlib import Path
from uuid import uuid4

from fastapi import UploadFile

from app.config import settings


def upload_root() -> Path:
    path = Path(settings.upload_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def report_root() -> Path:
    path = Path(settings.report_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_upload(file: UploadFile, user_id: int) -> tuple[Path, int]:
    suffix = Path(file.filename or "").suffix.lower()
    directory = upload_root() / f"user-{user_id}"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{uuid4().hex}{suffix}"
    size = 0
    with path.open("wb") as output:
        while chunk := file.file.read(1024 * 1024):
            size += len(chunk)
            output.write(chunk)
    return path, size
