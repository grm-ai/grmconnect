from __future__ import annotations

from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

import redis.asyncio as aioredis

from app.config import settings

_pool: aioredis.ConnectionPool | None = None


def _get_pool() -> aioredis.ConnectionPool:
    global _pool
    if _pool is None:
        _pool = aioredis.ConnectionPool.from_url(
            settings.redis_url,
            decode_responses=True,
            max_connections=20,
        )
    return _pool


@asynccontextmanager
async def get_redis() -> AsyncGenerator[aioredis.Redis, None]:
    client = aioredis.Redis(connection_pool=_get_pool())
    try:
        yield client
    finally:
        await client.aclose()


async def redis_ping() -> bool:
    try:
        async with get_redis() as r:
            return await r.ping()
    except Exception:
        return False
