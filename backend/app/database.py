from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


# ── SQLite-aware engine kwargs ────────────────────────────────────────────────

def _async_engine_kwargs() -> dict:
    kwargs: dict = {"echo": settings.debug}
    if "sqlite" in settings.database_url:
        # SQLite doesn't support pool_size / max_overflow; needs check_same_thread=False
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_size"] = 10
        kwargs["max_overflow"] = 20
    return kwargs


def _sync_engine_kwargs() -> dict:
    kwargs: dict = {"echo": settings.debug}
    if "sqlite" in settings.sync_database_url:
        kwargs["connect_args"] = {"check_same_thread": False}
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_size"] = 5
        kwargs["max_overflow"] = 10
    return kwargs


# ── Async engine (FastAPI) ────────────────────────────────────────────────────

async_engine = create_async_engine(settings.database_url, **_async_engine_kwargs())

AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# ── Sync engine (Celery workers / dev runner) ─────────────────────────────────

sync_engine = create_engine(settings.sync_database_url, **_sync_engine_kwargs())

SyncSessionLocal = sessionmaker(
    bind=sync_engine,
    autocommit=False,
    autoflush=False,
)


def get_sync_session() -> Session:
    return SyncSessionLocal()
