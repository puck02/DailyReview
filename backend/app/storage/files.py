from pathlib import Path
from uuid import uuid4

from fastapi import UploadFile

from app.config import settings


class UploadValidationError(ValueError):
    pass


class UploadTooLargeError(UploadValidationError):
    pass


IMAGE_TYPES = (
    (b"\x89PNG\r\n\x1a\n", "image/png", ".png"),
    (b"\xff\xd8\xff", "image/jpeg", ".jpg"),
    (b"GIF87a", "image/gif", ".gif"),
    (b"GIF89a", "image/gif", ".gif"),
)


def detect_image_type(data: bytes) -> tuple[str, str] | None:
    for signature, mime_type, suffix in IMAGE_TYPES:
        if data.startswith(signature):
            return mime_type, suffix
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    return None


def upload_root() -> Path:
    path = Path(settings.upload_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def report_root() -> Path:
    path = Path(settings.report_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_upload(file: UploadFile, user_id: int) -> tuple[Path, int, str]:
    directory = upload_root() / f"user-{user_id}"
    directory.mkdir(parents=True, exist_ok=True)
    token = uuid4().hex
    temp_path = directory / f"{token}.uploading"

    head = file.file.read(512)
    if not head:
        raise UploadValidationError("图片为空，请重新粘贴或选择图片")
    detected = detect_image_type(head)
    if detected is None:
        raise UploadValidationError("只支持 PNG、JPEG、WebP 或 GIF 图片")

    mime_type, suffix = detected
    path = directory / f"{token}{suffix}"
    size = 0
    try:
        with temp_path.open("wb") as output:
            size += len(head)
            if size > settings.max_upload_bytes:
                raise UploadTooLargeError(f"图片不能超过 {settings.max_upload_bytes // 1024 // 1024}MB")
            output.write(head)
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise UploadTooLargeError(f"图片不能超过 {settings.max_upload_bytes // 1024 // 1024}MB")
                output.write(chunk)
        temp_path.replace(path)
    except UploadValidationError:
        temp_path.unlink(missing_ok=True)
        raise

    return path, size, mime_type
