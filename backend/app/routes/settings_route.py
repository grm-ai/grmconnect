from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from app.dependencies import require_auth
from app.schemas import ApiResponse

router = APIRouter(prefix="/settings", tags=["Settings"])

# Settings persisted in sessions/app_settings.json (next to LinkedIn session files)
_SETTINGS_FILE = Path(__file__).parent.parent.parent / "sessions" / "app_settings.json"


def _load() -> dict[str, Any]:
    try:
        if _SETTINGS_FILE.exists():
            return json.loads(_SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _persist(data: dict[str, Any]) -> None:
    _SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _SETTINGS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _mask(value: str) -> str:
    """Return bullet-masked version so the UI can show 'configured' without leaking the key."""
    if not value:
        return ""
    visible = min(4, len(value) // 4)
    return value[:visible] + "•" * (len(value) - visible)


class SettingsIn(BaseModel):
    gemini_api_key:      str | None = None
    anthropic_api_key:   str | None = None
    openai_api_key:      str | None = None
    webhook_url:         str | None = None
    webhook_secret:      str | None = None
    slack_webhook_url:   str | None = None
    notification_email:  bool | None = None
    notification_slack:  bool | None = None
    daily_send_limit:    int | None = None
    timezone:            str | None = None
    # Sender profile — filled once, injected into every AI generation so
    # messages use the user's real identity instead of [Your Name] placeholders.
    sender_name:         str | None = None
    sender_role:         str | None = None
    sender_company:      str | None = None
    sender_about:        str | None = None


_SECRET_FIELDS = {"gemini_api_key", "anthropic_api_key", "openai_api_key", "webhook_secret"}


@router.get("", response_model=ApiResponse[dict])
async def get_settings(_: str = require_auth) -> ApiResponse[dict]:
    """
    Return persisted settings.
    Secret fields (API keys) are masked — the UI shows '●●●●' if configured.
    """
    from app.config import settings as app_cfg

    data = _load()

    # Seed from env vars if the file doesn't have them yet (first run)
    if "gemini_api_key" not in data and app_cfg.gemini_api_key:
        data["gemini_api_key"] = app_cfg.gemini_api_key
    if "anthropic_api_key" not in data and app_cfg.anthropic_api_key:
        data["anthropic_api_key"] = app_cfg.anthropic_api_key

    out: dict[str, Any] = {}
    for k, v in data.items():
        if k in _SECRET_FIELDS:
            out[k] = _mask(str(v)) if v else ""
        else:
            out[k] = v

    # Tell the UI which secret keys are actually configured (non-empty in storage)
    out["gemini_configured"]    = bool(data.get("gemini_api_key"))
    out["anthropic_configured"] = bool(data.get("anthropic_api_key"))
    out["openai_configured"]    = bool(data.get("openai_api_key"))

    return ApiResponse(data=out, message="Settings loaded.")


@router.post("", response_model=ApiResponse[dict])
async def save_settings(body: SettingsIn, _: str = require_auth) -> ApiResponse[dict]:
    """
    Persist settings to disk and apply API keys in-memory immediately.
    Empty string means 'leave unchanged'; null means 'clear the value'.
    """
    from app.config import settings as app_cfg

    data = _load()
    updates: list[str] = []

    for field, value in body.model_dump(exclude_none=True).items():
        if isinstance(value, str) and value == "":
            # Empty string → skip (don't overwrite with blank)
            continue
        data[field] = value
        updates.append(field)

        # Apply API keys to the live process immediately
        if field == "gemini_api_key" and value:
            try:
                import google.generativeai as genai
                genai.configure(api_key=value)
            except ImportError:
                pass
            # Patch in-memory config so new AIGenerator instances pick it up
            object.__setattr__(app_cfg, "gemini_api_key", value)

        elif field == "anthropic_api_key" and value:
            object.__setattr__(app_cfg, "anthropic_api_key", value)

    _persist(data)
    return ApiResponse(
        message=f"Saved: {', '.join(updates) or 'nothing changed'}.",
        data={"updated": updates},
    )


def get_sender_profile() -> dict[str, str]:
    """Return the persisted 'About You' sender profile used to personalise AI output."""
    data = _load()
    return {
        "sender_name":    str(data.get("sender_name", "") or ""),
        "sender_role":    str(data.get("sender_role", "") or ""),
        "sender_company": str(data.get("sender_company", "") or ""),
        "sender_about":   str(data.get("sender_about", "") or ""),
    }


def get_runtime_key(key: str) -> str:
    """
    Helpers for other services to read the persisted key at runtime,
    falling back to the environment-variable value.
    """
    from app.config import settings as app_cfg
    stored = _load().get(key, "")
    return stored or getattr(app_cfg, key, "")
