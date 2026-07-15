"""
LeadPilot AI — Dev Runner (No Docker required)
===============================================
Uses SQLite instead of PostgreSQL. Runs LinkedIn automation tasks
directly in asyncio background workers (no Redis/Celery needed).

Usage:
    cd backend
    python run_dev.py

What this starts:
  • FastAPI on http://localhost:8000
  • SQLite database at ./leadpilot_dev.db
  • Background inbox poller (every 15 min)
  • Background action processor (every 5 min)
  • Auto-creates all tables on first run
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

# ── Env: load .env.dev locally; in production (Docker) use real env vars ─────────
_IS_PROD = os.environ.get("ENV", "").lower() == "production"
_env_dev = Path(__file__).parent / ".env.dev"
if _env_dev.exists() and not _IS_PROD:
    os.environ.setdefault("ENV_FILE", str(_env_dev))
    from dotenv import load_dotenv
    load_dotenv(dotenv_path=_env_dev, override=True)

# ── patch config to pick up the env ──────────────────────────────────────────
import app.config as _cfg_mod
_cfg_mod.get_settings.cache_clear()
settings = _cfg_mod.get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level, logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("run_dev")

# ── patch database module for SQLite ─────────────────────────────────────────
# SQLite doesn't support alembic schema operations well through asyncpg,
# so we use aiosqlite and set up tables via SQLAlchemy directly.

async def create_tables() -> None:
    """Create all tables on first run (skips if they already exist)."""
    from sqlalchemy.ext.asyncio import create_async_engine
    from app.database import Base
    import app.models  # noqa: F401 — registers all models

    # For SQLite, re-export connection args
    engine = create_async_engine(
        settings.database_url,
        echo=False,
        connect_args={"check_same_thread": False} if "sqlite" in settings.database_url else {},
    )
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # create_all never ALTERs existing tables, so add any columns introduced
        # after the DB was first created. Idempotent: checks PRAGMA before adding.
        if "sqlite" in settings.database_url:
            from sqlalchemy import text
            new_cols = {
                "campaigns": [
                    ("goal", "TEXT"),
                    ("autopilot", "BOOLEAN NOT NULL DEFAULT 0"),
                    ("user_id", "BIGINT"),
                ],
                "leads": [
                    ("meeting_status", "VARCHAR(20)"),      # NONE | PENDING | CONFIRMED
                    ("meeting_detail", "TEXT"),             # AI-extracted call summary / time
                    ("meeting_detected_at", "DATETIME"),
                    ("user_id", "BIGINT"),
                ],
                "actions":  [("user_id", "BIGINT")],
                "messages": [("user_id", "BIGINT")],
                "browser_sessions": [("user_id", "BIGINT")],
                "users": [
                    ("sender_name", "VARCHAR(255)"),
                    ("sender_role", "VARCHAR(255)"),
                    ("sender_company", "VARCHAR(255)"),
                    ("sender_about", "TEXT"),
                    ("sender_talking_points", "TEXT"),
                    ("timezone", "VARCHAR(64)"),
                ],
            }
            for table, cols in new_cols.items():
                existing = {
                    r[1] for r in (await conn.exec_driver_sql(f"PRAGMA table_info({table})")).all()
                }
                for name, ddl in cols:
                    if name not in existing:
                        await conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
                        log.info("DB migrate: added %s.%s", table, name)

            # Backfill: assign all pre-existing rows (from before multi-user) to the OWNER
            # (the first/earliest user) so existing data stays with you, not orphaned.
            owner = (await conn.exec_driver_sql("SELECT id FROM users ORDER BY id LIMIT 1")).first()
            if owner:
                oid = owner[0]
                for table in ("leads", "campaigns", "actions", "messages", "browser_sessions"):
                    await conn.exec_driver_sql(
                        f"UPDATE {table} SET user_id = {oid} WHERE user_id IS NULL"
                    )
                log.info("DB migrate: backfilled existing rows to owner user_id=%s", oid)
    await engine.dispose()
    log.info("Database tables ready (SQLite: %s)", settings.database_url)


async def run_pending_actions() -> None:
    """
    PhantomBuster-style background automation.

    run_dev.py runs on the USER'S OWN MACHINE, so every HTTP request goes out
    from the user's home IP — the same IP LinkedIn already trusts for this account.
    This is identical to PhantomBuster's model: extract cookie via browser
    extension, send API calls from the same machine.

    What we avoid (the things that WERE causing logouts):
    - Headless Playwright/Chromium browsers (detectable fingerprint — disabled permanently)
    - Simultaneous use: we only run during a quiet window (10 PM – 7 AM local time
      or when the user has been idle) so we're not competing with the user's
      own LinkedIn tab at the same time.
    - Burst sending: max 3 invites per run with 45–120 s between them.
    """
    import random
    from datetime import datetime, timezone
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from sqlalchemy import select, func
    from app.models import Action, ActionStatus, ActionType, Lead, BrowserSession, ConnectionStatus, Campaign
    from app.services.session_manager import SessionManager
    from app.services.ai_generator import AIGenerator
    from app.routes.leads import _voyager_send_invite

    # ── Business hours window: 8 AM – 7 PM local, Mon–Fri ──────────────────
    # PhantomBuster model: send during business hours so invites look human.
    # Sending at midnight flags the account immediately.
    now_local = datetime.now()
    local_hour = now_local.hour
    local_weekday = now_local.weekday()  # 0=Mon … 6=Sun
    is_business = (8 <= local_hour < 19) and (local_weekday <= 4)
    if not is_business:
        log.debug(
            "run_pending_actions: outside business hours (hour=%d weekday=%d) — skipping",
            local_hour, local_weekday,
        )
        return

    engine = create_async_engine(settings.database_url, connect_args={"check_same_thread": False})
    Session = async_sessionmaker(engine, expire_on_commit=False)

    async with Session() as db:
        now = datetime.now(timezone.utc)

        # Daily cap
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        sent_today = (await db.execute(
            select(func.count()).where(
                Action.action_type == ActionType.CONNECT,
                Action.status == ActionStatus.SUCCESS,
                Action.executed_at >= today_start,
            )
        )).scalar() or 0

        DAILY_CAP = 20
        if sent_today >= DAILY_CAP:
            log.info("Daily cap reached (%d/%d)", sent_today, DAILY_CAP)
            await engine.dispose()
            return

        # Load active session
        session_mgr = SessionManager()
        session_row = (await db.execute(
            select(BrowserSession).where(BrowserSession.status == "ACTIVE").limit(1)
        )).scalar_one_or_none()
        if not session_row:
            log.debug("run_pending_actions: no active session")
            await engine.dispose()
            return

        storage_state = session_mgr.load_session(session_row.account_name)
        if not storage_state:
            log.debug("run_pending_actions: session file missing")
            await engine.dispose()
            return

        # Max 3 invites per run — prevents burst detection
        BATCH_SIZE = min(3, DAILY_CAP - sent_today)
        result = await db.execute(
            select(Action).where(
                Action.action_type == ActionType.CONNECT,
                Action.status == ActionStatus.PENDING,
                (Action.scheduled_at == None) | (Action.scheduled_at <= now),  # noqa: E711
            ).limit(BATCH_SIZE)
        )
        actions = result.scalars().all()
        if not actions:
            await engine.dispose()
            return

        ai = AIGenerator()
        log.info("Background: sending %d invite(s) (sent today: %d/%d)", len(actions), sent_today, DAILY_CAP)

        for action in actions:
            lead = await db.get(Lead, action.lead_id) if action.lead_id else None
            if not lead or not lead.linkedin_url:
                action.status = ActionStatus.FAILED
                action.result = {"error": "Lead or URL missing"}
                await db.commit()
                continue

            if lead.connection_status in (ConnectionStatus.PENDING, ConnectionStatus.ACCEPTED):
                action.status = ActionStatus.SUCCESS
                action.result = {"skipped": "already_connected_or_pending"}
                await db.commit()
                continue

            action.status = ActionStatus.RUNNING
            await db.commit()

            try:
                # Drive the invite note toward the campaign's end-goal (if any).
                campaign = await db.get(Campaign, action.campaign_id) if action.campaign_id else None
                goal = (campaign.goal or "").strip() if campaign else ""
                note = await ai.generate_connect_note(
                    lead_name=lead.name,
                    lead_company=lead.company,
                    lead_title=lead.title,
                    context=(f"Your goal with this outreach: {goal}" if goal else ""),
                )

                # Voyager API call — goes out from YOUR IP (same machine = same IP as LinkedIn session)
                result_data = await _voyager_send_invite(
                    linkedin_url=lead.linkedin_url,
                    note=note,
                    storage_state=storage_state,
                )

                if result_data.get("success"):
                    action.status = ActionStatus.SUCCESS
                    action.executed_at = now
                    lead.connection_status = ConnectionStatus.PENDING
                    lead.connection_sent_at = datetime.now(timezone.utc)
                    log.info("✓ Invite sent to %s", lead.name)
                elif result_data.get("session_expired"):
                    session_row.status = "EXPIRED"
                    action.status = ActionStatus.PENDING
                    log.warning("Session expired — stopping batch")
                    await db.commit()
                    break
                elif result_data.get("already_pending"):
                    action.status = ActionStatus.SUCCESS
                    lead.connection_status = ConnectionStatus.PENDING
                elif result_data.get("already_connected"):
                    action.status = ActionStatus.SUCCESS
                    lead.connection_status = ConnectionStatus.ACCEPTED
                else:
                    action.status = ActionStatus.FAILED
                    log.warning("✗ %s: %s", lead.name, result_data.get("error"))

                action.result = result_data

            except Exception as exc:
                action.status = ActionStatus.FAILED
                action.result = {"error": str(exc)}
                log.error("Action %d failed: %s", action.id, exc)

            await db.commit()

            # Human-like gap between invites: 45–120 seconds (PhantomBuster uses 30–90s)
            if action != actions[-1]:
                delay = random.uniform(45, 120)
                log.debug("Waiting %.0fs before next invite", delay)
                await asyncio.sleep(delay)

    await engine.dispose()


async def poll_inbox_async() -> None:
    """
    Inbox polling — disabled for headless-browser approach.

    Headless Chromium launched from this process is detectable even from the
    user's home IP (different screen resolution, missing GPU, wrong Chrome
    internals). LinkedIn flags headless bots within a few sessions.

    Inbox checking goes through the Chrome extension instead: the extension
    navigates LinkedIn inside the user's real Chrome tab, which is indistinguishable
    from normal browsing activity.
    """
    log.debug("poll_inbox_async: no-op — inbox polling via Chrome extension only")


async def background_loop() -> None:
    """PhantomBuster-style scheduler: business-hours sends, no headless browsers."""
    # Check every 5 minutes during business hours.
    # run_pending_actions() sends max 3 invites per run with 45–120 s delays
    # → bursts of 3 every 5 min = up to 36/hr, capped to 20/day by daily cap.
    action_interval = 300  # 5 minutes
    action_timer = 0

    while True:
        await asyncio.sleep(60)
        action_timer += 60

        if action_timer >= action_interval:
            action_timer = 0
            try:
                await run_pending_actions()
            except Exception as exc:
                log.error("background action error: %s", exc)


async def main() -> None:
    # Create directories
    Path("logs").mkdir(exist_ok=True)
    Path("sessions").mkdir(exist_ok=True)

    # Set up database
    await create_tables()

    # Start background worker
    asyncio.create_task(background_loop())

    # Start FastAPI
    import uvicorn
    config = uvicorn.Config(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),  # Railway/Render inject $PORT; default 8000 locally
        reload=not _IS_PROD,          # no auto-reload in production
        reload_dirs=["app"],          # relative to backend/ (where run_dev.py is executed)
        log_level=settings.log_level.lower(),
    )
    server = uvicorn.Server(config)

    log.info("=" * 55)
    log.info("  LeadPilot AI — Dev Server")
    log.info("  API:  http://localhost:8000")
    log.info("  Docs: http://localhost:8000/docs")
    log.info("  DB:   SQLite (leadpilot_dev.db)")
    log.info("=" * 55)

    await server.serve()


if __name__ == "__main__":
    asyncio.run(main())
