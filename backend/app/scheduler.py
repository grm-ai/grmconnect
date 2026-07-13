from __future__ import annotations

import logging

from apscheduler.executors.asyncio import AsyncIOExecutor
from apscheduler.jobstores.redis import RedisJobStore
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import settings
from app.logger import scheduler_logger

_scheduler: AsyncIOScheduler | None = None


def _build_scheduler() -> AsyncIOScheduler:
    executors = {"default": AsyncIOExecutor()}
    job_defaults = {"coalesce": True, "max_instances": 1, "misfire_grace_time": 60}

    # Probe Redis before trying to connect — fall back to in-memory if unreachable
    jobstores: dict = {}
    _redis_ok = False
    try:
        import socket
        import urllib.parse
        parsed = urllib.parse.urlparse(settings.redis_url)
        redis_host = parsed.hostname or "localhost"
        redis_port = parsed.port or 6379
        sock = socket.create_connection((redis_host, redis_port), timeout=1)
        sock.close()
        _redis_ok = True
    except Exception:
        pass

    if _redis_ok:
        try:
            from apscheduler.jobstores.redis import RedisJobStore
            import urllib.parse
            parsed = urllib.parse.urlparse(settings.redis_url)
            redis_host = parsed.hostname or "localhost"
            redis_port = parsed.port or 6379
            redis_db = int(parsed.path.lstrip("/") or 0)
            jobstores["default"] = RedisJobStore(host=redis_host, port=redis_port, db=redis_db)
        except Exception:
            _redis_ok = False

    if not _redis_ok:
        from apscheduler.jobstores.memory import MemoryJobStore
        scheduler_logger.warning("Redis unavailable — using in-memory job store (jobs reset on restart)")
        jobstores["default"] = MemoryJobStore()

    scheduler = AsyncIOScheduler(
        jobstores=jobstores,
        executors=executors,
        job_defaults=job_defaults,
        timezone="UTC",
    )
    return scheduler


def get_scheduler() -> AsyncIOScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = _build_scheduler()
    return _scheduler


async def _trigger_process_pending() -> None:
    """Wrapper called by APScheduler.

    Production: delegates to Celery task.
    Dev mode (run_dev.py): Celery not available — run_dev.py background_loop() handles
    scheduling directly, so this is a safe no-op.
    """
    try:
        from app.tasks import process_pending_actions
        scheduler_logger.info("APScheduler: dispatching process_pending_actions to Celery")
        process_pending_actions.delay()
    except ImportError:
        scheduler_logger.debug("Celery not installed (dev mode) — pending actions handled by run_dev.py background loop")


async def _trigger_poll_inbox() -> None:
    """Poll LinkedIn inbox. Production: Celery. Dev: no-op (run_dev.py handles it)."""
    try:
        from app.tasks import poll_linkedin_inbox
        scheduler_logger.info("APScheduler: dispatching poll_linkedin_inbox to Celery")
        poll_linkedin_inbox.delay()
    except ImportError:
        scheduler_logger.debug("Celery not installed (dev mode) — inbox polling handled by run_dev.py")


def start_scheduler() -> None:
    scheduler = get_scheduler()
    if scheduler.running:
        return

    scheduler.add_job(
        _trigger_process_pending,
        trigger="interval",
        seconds=300,
        id="process_pending_actions",
        name="Process pending actions every 5 minutes",
        replace_existing=True,
    )
    scheduler.add_job(
        _trigger_poll_inbox,
        trigger="interval",
        seconds=900,   # every 15 minutes
        id="poll_linkedin_inbox",
        name="Poll LinkedIn inbox every 15 minutes",
        replace_existing=True,
    )
    scheduler.start()
    scheduler_logger.info("APScheduler started")


def stop_scheduler() -> None:
    scheduler = get_scheduler()
    if scheduler.running:
        scheduler.shutdown(wait=False)
        scheduler_logger.info("APScheduler stopped")
