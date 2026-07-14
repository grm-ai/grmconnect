from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── Database ──────────────────────────────────────────────────────────────
    database_url: str = (
        "postgresql+asyncpg://postgres:password@localhost:5432/linkedin_automation"
    )
    sync_database_url: str = (
        "postgresql+psycopg2://postgres:password@localhost:5432/linkedin_automation"
    )

    # ── Redis ─────────────────────────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"

    # ── Auth ──────────────────────────────────────────────────────────────────
    api_key: str = "change-me-in-production"

    # ── Logging ───────────────────────────────────────────────────────────────
    log_level: str = "INFO"
    log_dir: str = "/app/logs"

    # ── Sessions ──────────────────────────────────────────────────────────────
    session_dir: str = "/app/sessions"

    # ── AI ────────────────────────────────────────────────────────────────────
    anthropic_api_key: str = ""
    gemini_api_key: str = ""
    # Overridable via env GEMINI_MODEL so a deprecated model can be swapped without a code change.
    gemini_model: str = "gemini-2.5-flash"

    # ── CORS ──────────────────────────────────────────────────────────────────
    allowed_origins: str = "http://localhost:3000"

    # ── Rate limits ───────────────────────────────────────────────────────────
    # LinkedIn safe defaults. Raise carefully:
    #   Free accounts: max ~20 connects/day
    #   Premium / Sales Nav: max ~100 connects/day
    daily_connect_limit: int = 20
    daily_message_limit: int = 50

    # ── App ───────────────────────────────────────────────────────────────────
    app_name: str = "Automation Platform"
    app_version: str = "1.0.0"
    debug: bool = False


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
