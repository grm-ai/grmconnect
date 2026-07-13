"""
Auth security helpers — password hashing + JWT + the current-user dependency.

Multi-user model: each request is authenticated by a JWT bearer token that identifies the user.
For backward compatibility, the legacy X-API-Key still works and maps to the FIRST/owner user
(so the Chrome extension keeps working until it's updated to send a per-user token).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Depends, Header
from jose import JWTError, jwt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_db
from app.exceptions import UnauthorizedError

_ALGO = "HS256"


def _jwt_secret() -> str:
    # Reuse the app secret as the JWT signing key (fine for a self-hosted single/small deployment).
    return settings.api_key or "change-me-in-production"


def hash_password(plain: str) -> str:
    # bcrypt has a hard 72-byte limit on the input; truncate defensively.
    return bcrypt.hashpw(plain.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8")[:72], hashed.encode("utf-8"))
    except Exception:
        return False


def create_access_token(user_id: int, expires_days: int = 30) -> str:
    payload = {
        "sub": str(user_id),
        "exp": datetime.now(timezone.utc) + timedelta(days=expires_days),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _jwt_secret(), algorithm=_ALGO)


def decode_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, _jwt_secret(), algorithms=[_ALGO])
        return int(payload["sub"])
    except (JWTError, KeyError, ValueError, TypeError):
        return None


async def get_current_user(
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
    db: AsyncSession = Depends(get_db),
):
    """Resolve the authenticated user from a JWT bearer token, or (legacy) the API key → owner."""
    from app.models import User

    # 1) JWT bearer token (the normal path for logged-in users)
    if authorization and authorization.lower().startswith("bearer "):
        uid = decode_token(authorization.split(" ", 1)[1].strip())
        if uid is not None:
            user = await db.get(User, uid)
            if user:
                return user

    # 2) Legacy X-API-Key → the owner (first) user, so the extension keeps working for now.
    if x_api_key and secrets.compare_digest(x_api_key, settings.api_key):
        user = (await db.execute(select(User).order_by(User.id).limit(1))).scalar_one_or_none()
        if user:
            return user

    raise UnauthorizedError("Not authenticated — please log in.")
