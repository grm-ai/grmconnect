from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.config import settings as app_settings
from app.models import User
from app.security import get_current_user
from app.schemas import ApiResponse

router = APIRouter(prefix="/settings", tags=["Settings"])

# Per-user settings (API keys, webhook, etc.) live in one file PER user under the SAME dir as
# LinkedIn sessions — the persistent /data volume on Railway (SESSION_DIR). One file per user so
# one account's API key is never visible to (or usable by) another account.
_SETTINGS_DIR = Path(app_settings.session_dir) / "user_settings"
# Legacy single-file store (pre multi-user). Read-only fallback so an existing global key still
# works for the very first/owner account until they re-save it.
_LEGACY_FILE = Path(app_settings.session_dir) / "app_settings.json"


def _user_file(user_id: int) -> Path:
    return _SETTINGS_DIR / f"{user_id}.json"


def _load(user_id: int) -> dict[str, Any]:
    try:
        p = _user_file(user_id)
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def _persist(user_id: int, data: dict[str, Any]) -> None:
    _SETTINGS_DIR.mkdir(parents=True, exist_ok=True)
    _user_file(user_id).write_text(json.dumps(data, indent=2), encoding="utf-8")


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
async def get_settings(user: User = Depends(get_current_user)) -> ApiResponse[dict]:
    """
    Return persisted settings.
    Secret fields (API keys) are masked — the UI shows '●●●●' if configured.
    """
    data = _load(user.id)

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
async def save_settings(body: SettingsIn, user: User = Depends(get_current_user)) -> ApiResponse[dict]:
    """
    Persist settings to disk and apply API keys in-memory immediately.
    Empty string means 'leave unchanged'; null means 'clear the value'.
    """
    data = _load(user.id)
    updates: list[str] = []

    for field, value in body.model_dump(exclude_none=True).items():
        if isinstance(value, str) and value == "":
            # Empty string → skip (don't overwrite with blank)
            continue
        data[field] = value
        updates.append(field)

    _persist(user.id, data)
    return ApiResponse(
        message=f"Saved: {', '.join(updates) or 'nothing changed'}.",
        data={"updated": updates},
    )


def get_user_keys(user_id: int) -> dict[str, str]:
    """Return a specific user's own AI API keys (never another account's)."""
    d = _load(user_id)
    return {
        "gemini_api_key":    str(d.get("gemini_api_key", "") or ""),
        "anthropic_api_key": str(d.get("anthropic_api_key", "") or ""),
        "openai_api_key":    str(d.get("openai_api_key", "") or ""),
    }


def get_sender_profile(user_id: int | None = None) -> dict[str, str]:
    """Return a user's persisted 'About You' sender profile (empty for background jobs w/o a user)."""
    data = _load(user_id) if user_id is not None else {}
    return {
        "sender_name":    str(data.get("sender_name", "") or ""),
        "sender_role":    str(data.get("sender_role", "") or ""),
        "sender_company": str(data.get("sender_company", "") or ""),
        "sender_about":   str(data.get("sender_about", "") or ""),
        "sender_talking_points": str(data.get("sender_talking_points", "") or ""),
    }


def get_runtime_key(key: str, user_id: int | None = None) -> str:
    """Read a user's persisted key at runtime, falling back to the environment-variable value."""
    from app.config import settings as app_cfg
    stored = _load(user_id).get(key, "") if user_id is not None else ""
    return stored or getattr(app_cfg, key, "")
