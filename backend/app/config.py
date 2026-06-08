import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def _load_env_files() -> None:
    cwd = Path.cwd()
    for path in (cwd / ".env", cwd.parent / ".env"):
        if path.exists():
            load_dotenv(path, override=False)


_load_env_files()


@dataclass
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "sqlite:///../data/app.db")
    upload_dir: str = os.getenv("UPLOAD_DIR", "../data/uploads")
    report_dir: str = os.getenv("REPORT_DIR", "../data/reports")
    secret_key: str = os.getenv("SECRET_KEY", "dev-secret")
    admin_email: str = os.getenv("ADMIN_EMAIL", "")
    admin_initial_password: str = os.getenv("ADMIN_INITIAL_PASSWORD", "")
    app_timezone: str = os.getenv("APP_TIMEZONE", "Asia/Shanghai")
    ai_base_url: str = os.getenv("AI_BASE_URL", "")
    ai_api_key: str = os.getenv("AI_API_KEY", "")
    ai_default_model: str = os.getenv("AI_DEFAULT_MODEL", "gpt-5.4-mini")
    ai_complex_model: str = os.getenv("AI_COMPLEX_MODEL", "5.5")
    app_port: int = int(os.getenv("APP_PORT", "8082"))


settings = Settings()
