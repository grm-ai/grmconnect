from __future__ import annotations

"""Celery worker entry point.

Run with:
    celery -A app.workers.celery_worker worker --loglevel=info --concurrency=4
"""

from app.celery_app import celery_app  # noqa: F401 – side-effect import registers tasks
import app.tasks  # noqa: F401 – ensure tasks are registered

__all__ = ["celery_app"]
