"""
Rate limiter for LinkedIn automation actions.

Works without Redis by counting executed actions directly from the database.
Redis is used as a fast cache when available, with DB as the source of truth.

LinkedIn safe limits (as of 2025):
  • Free accounts   : ~20 connection requests / day
  • Premium / Sales Nav: ~100 / day
  • Messages to connections: ~150 / day

We enforce limits at two levels:
  1. Global limit  — total CONNECT actions across ALL campaigns today
  2. Campaign limit — per-campaign daily_limit from the campaigns table
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import TYPE_CHECKING

from app.config import settings
from app.logger import app_logger

if TYPE_CHECKING:
    from sqlalchemy.orm import Session
    from sqlalchemy.ext.asyncio import AsyncSession


def _today_window() -> tuple[datetime, datetime]:
    """Return UTC start/end of today."""
    today = date.today()
    start = datetime(today.year, today.month, today.day, 0, 0, 0, tzinfo=timezone.utc)
    end   = datetime(today.year, today.month, today.day, 23, 59, 59, tzinfo=timezone.utc)
    return start, end


# ── Async (FastAPI routes) ─────────────────────────────────────────────────────

class RateLimiter:
    """Async rate limiter — counts from DB, uses Redis cache when available."""

    async def _try_redis(self, key: str) -> int | None:
        try:
            import redis.asyncio as aioredis
            r = aioredis.from_url(settings.redis_url, decode_responses=True, socket_connect_timeout=1)
            val = await r.get(key)
            await r.aclose()
            return int(val) if val is not None else None
        except Exception:
            return None

    async def _count_from_db(self, db: "AsyncSession", campaign_id: int | None, action_type: str) -> int:
        from sqlalchemy import select, func
        from app.models import Action, ActionStatus, ActionType

        start, end = _today_window()
        q = (
            select(func.count())
            .select_from(Action)
            .where(
                Action.action_type == action_type,
                Action.status == ActionStatus.SUCCESS,
                Action.executed_at >= start,
                Action.executed_at <= end,
            )
        )
        if campaign_id:
            q = q.where(Action.campaign_id == campaign_id)
        result = await db.execute(q)
        return result.scalar_one() or 0

    async def check_global_connect_limit(self, db: "AsyncSession") -> tuple[bool, int, int]:
        """Returns (allowed, used_today, limit)."""
        limit = settings.daily_connect_limit
        used = await self._count_from_db(db, None, "CONNECT")
        app_logger.debug("Global CONNECT today: %d / %d", used, limit)
        return used < limit, used, limit

    async def check_campaign_limit(self, db: "AsyncSession", campaign_id: int, action_type: str = "CONNECT") -> tuple[bool, int, int]:
        """Returns (allowed, used_today, campaign_daily_limit)."""
        from sqlalchemy import select
        from app.models import Campaign

        res = await db.execute(select(Campaign).where(Campaign.id == campaign_id))
        campaign = res.scalar_one_or_none()
        if not campaign:
            return False, 0, 0

        limit = campaign.daily_limit
        used  = await self._count_from_db(db, campaign_id, action_type)
        app_logger.debug("Campaign %d %s today: %d / %d", campaign_id, action_type, used, limit)
        return used < limit, used, limit

    async def get_today_stats(self, db: "AsyncSession") -> dict:
        """Return full today's usage stats."""
        from sqlalchemy import select, func
        from app.models import Action, ActionStatus, ActionType

        start, _ = _today_window()
        result = await db.execute(
            select(Action.action_type, func.count())
            .where(Action.status == ActionStatus.SUCCESS, Action.executed_at >= start)
            .group_by(Action.action_type)
        )
        rows = result.all()
        counts = {row[0].value if hasattr(row[0], 'value') else row[0]: row[1] for row in rows}
        return {
            "connect_sent":   counts.get("CONNECT", 0),
            "messages_sent":  counts.get("MESSAGE", 0) + counts.get("FOLLOWUP", 0),
            "connect_limit":  settings.daily_connect_limit,
            "message_limit":  settings.daily_message_limit,
            "connect_remaining": max(0, settings.daily_connect_limit - counts.get("CONNECT", 0)),
            "message_remaining": max(0, settings.daily_message_limit - (counts.get("MESSAGE", 0) + counts.get("FOLLOWUP", 0))),
            "date": date.today().isoformat(),
        }


# ── Sync (dev runner background tasks) ────────────────────────────────────────

class RateLimiterSync:
    """Synchronous rate limiter for use in dev runner background tasks."""

    def _count_from_db(self, db: "Session", campaign_id: int | None, action_type: str) -> int:
        from sqlalchemy import select, func
        from app.models import Action, ActionStatus

        start, end = _today_window()
        q = (
            select(func.count())
            .select_from(Action)
            .where(
                Action.action_type == action_type,
                Action.status == ActionStatus.SUCCESS,
                Action.executed_at >= start,
                Action.executed_at <= end,
            )
        )
        if campaign_id:
            q = q.where(Action.campaign_id == campaign_id)
        return db.execute(q).scalar_one() or 0

    def check_campaign_limit(self, campaign_id: int, db: "Session | None" = None) -> bool:
        from app.database import get_sync_session
        from app.models import Campaign

        own_db = db is None
        if own_db:
            db = get_sync_session()
        try:
            campaign = db.get(Campaign, campaign_id)
            if not campaign:
                return False
            used = self._count_from_db(db, campaign_id, "CONNECT")
            # Also check global limit
            global_used = self._count_from_db(db, None, "CONNECT")
            if global_used >= settings.daily_connect_limit:
                app_logger.info(
                    "Global CONNECT limit reached (%d/%d) — blocking campaign %d",
                    global_used, settings.daily_connect_limit, campaign_id
                )
                return False
            return used < campaign.daily_limit
        finally:
            if own_db:
                db.close()

    def increment_campaign(self, campaign_id: int) -> int:
        # No-op — we count directly from DB, no cache to update
        return 0
