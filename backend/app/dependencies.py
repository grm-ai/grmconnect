from __future__ import annotations

from collections.abc import AsyncGenerator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import verify_api_key
from app.database import get_async_session
from app.redis_client import get_redis

# Re-export for convenience so routes only import from dependencies
__all__ = ["get_db", "get_redis_conn", "require_auth"]


async def get_db(
    session: AsyncSession = Depends(get_async_session),
) -> AsyncGenerator[AsyncSession, None]:
    yield session


async def get_redis_conn():
    async with get_redis() as r:
        yield r


# Applies API-key guard; attach as a dependency to any router or route
require_auth = Depends(verify_api_key)
