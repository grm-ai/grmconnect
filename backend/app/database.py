from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy import create_engine, event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


# ── SQLite-aware engine kwargs ────────────────────────────────────────────────
#
# SQLite allows only ONE writer at a time. /due can hold its write transaction open for well
# over a minute (it claims rows, then does live AI generation per due item, then commits at the
# end) — any other write that lands during that window (an overlapping auto-run tick, a
# reconcile-status call recording an acceptance) used to hit Python's sqlite3 default 5s lock
# wait and raise "database is locked" outright. `timeout=30` makes a writer wait up to 30s for
# the lock instead of failing near-instantly; WAL mode (set below) additionally lets READS proceed
# without waiting on a writer at all, which is most of what overlaps here.

def _async_engine_kwargs() -> dict:
    kwargs: dict = {"echo": settings.debug}
    if "sqlite" in settings.database_url:
        # SQLite doesn't support pool_size / max_overflow; needs check_same_thread=False
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_size"] = 10
        kwargs["max_overflow"] = 20
    return kwargs


def _sync_engine_kwargs() -> dict:
    kwargs: dict = {"echo": settings.debug}
    if "sqlite" in settings.sync_database_url:
        kwargs["connect_args"] = {"check_same_thread": False, "timeout": 30}
    else:
        kwargs["pool_pre_ping"] = True
        kwargs["pool_size"] = 5
        kwargs["max_overflow"] = 10
    return kwargs


def _set_sqlite_pragmas(dbapi_conn, _record) -> None:
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


# ── Async engine (FastAPI) ────────────────────────────────────────────────────

async_engine = create_async_engine(settings.database_url, **_async_engine_kwargs())
if "sqlite" in settings.database_url:
    event.listens_for(async_engine.sync_engine, "connect")(_set_sqlite_pragmas)

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
if "sqlite" in settings.sync_database_url:
    event.listens_for(sync_engine, "connect")(_set_sqlite_pragmas)

SyncSessionLocal = sessionmaker(
    bind=sync_engine,
    autocommit=False,
    autoflush=False,
)


def get_sync_session() -> Session:
    return SyncSessionLocal()
