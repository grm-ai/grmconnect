from __future__ import annotations

import secrets

from fastapi import Header, Security
from fastapi.security import APIKeyHeader

from app.config import settings
from app.exceptions import UnauthorizedError

_API_KEY_HEADER = APIKeyHeader(name="X-API-Key", auto_error=False)


async def verify_api_key(
    api_key: str | None = Security(_API_KEY_HEADER),
    authorization: str | None = Header(None),
) -> str:
    """Authenticate a request via a logged-in user's Bearer JWT (preferred) or the legacy X-API-Key.

    The web app sends `Authorization: Bearer <jwt>` (and drops X-API-Key), so any route guarded by
    this dependency must accept the bearer token too — otherwise it fails with 'X-API-Key missing'."""
    # 1) Bearer JWT — the normal path for logged-in users.
    if authorization and authorization.lower().startswith("bearer "):
        from app.security import decode_token  # lazy import avoids a circular import
        if decode_token(authorization.split(" ", 1)[1].strip()) is not None:
            return "bearer"
        raise UnauthorizedError("Invalid or expired token.")

    # 2) Legacy shared X-API-Key.
    if api_key is None:
        raise UnauthorizedError("Authentication required — please log in.")
    if not secrets.compare_digest(api_key, settings.api_key):
        raise UnauthorizedError("Invalid API key.")
    return api_key
