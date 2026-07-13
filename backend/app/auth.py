from __future__ import annotations

import secrets

from fastapi import Security
from fastapi.security import APIKeyHeader

from app.config import settings
from app.exceptions import UnauthorizedError

_API_KEY_HEADER = APIKeyHeader(name="X-API-Key", auto_error=False)


async def verify_api_key(api_key: str | None = Security(_API_KEY_HEADER)) -> str:
    if api_key is None:
        raise UnauthorizedError("X-API-Key header is missing.")
    if not secrets.compare_digest(api_key, settings.api_key):
        raise UnauthorizedError("Invalid API key.")
    return api_key
