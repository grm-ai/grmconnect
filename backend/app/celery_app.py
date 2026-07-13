from __future__ import annotations

from celery import Celery

from app.config import settings

celery_app = Celery(
    "linkedin_automation",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.tasks"],
)

celery_app.conf.update(
    # Serialization
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],

    # Timezone
    timezone="UTC",
    enable_utc=True,

    # Result backend behaviour
    result_expires=3600,
    result_extended=True,

    # Retry / ack
    task_acks_late=True,
    task_reject_on_worker_lost=True,
    task_track_started=True,

    # Worker concurrency limits (override via CLI flags)
    worker_prefetch_multiplier=1,

    # Beat schedule (used by scheduler container)
    beat_schedule={
        "process-pending-actions-every-5-minutes": {
            "task": "app.tasks.process_pending_actions",
            "schedule": 300,  # seconds
        },
    },
)
