from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

from celery import Task
from celery.utils.log import get_task_logger

from app.celery_app import celery_app
from app.logger import celery_logger

log = get_task_logger(__name__)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _run(coro):
    """Run an async coroutine from a sync Celery task."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_closed():
            raise RuntimeError
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    return loop.run_until_complete(coro)


# ── Core task ─────────────────────────────────────────────────────────────────

@celery_app.task(
    bind=True,
    name="app.tasks.execute_action_task",
    max_retries=3,
    default_retry_delay=60,
    acks_late=True,
    track_started=True,
)
def execute_action_task(self: Task, action_id: int) -> dict:
    """Execute a single automation action via Playwright."""
    celery_logger.info("execute_action_task started | action_id=%s attempt=%s", action_id, self.request.retries)

    async def _run_action():
        from sqlalchemy import select, update
        from app.database import get_sync_session
        from app.models import Action, ActionStatus, Lead, BrowserSession
        from app.services.browser import BrowserService
        from app.services.session_manager import SessionManager

        db = get_sync_session()
        try:
            # ── Load action ───────────────────────────────────────────────────
            action = db.get(Action, action_id)
            if action is None:
                celery_logger.error("Action %s not found", action_id)
                return {"success": False, "error": "Action not found"}

            if action.status in (ActionStatus.SUCCESS, ActionStatus.CANCELLED):
                celery_logger.info("Action %s already %s – skip", action_id, action.status)
                return {"success": True, "skipped": True}

            # ── Mark running ──────────────────────────────────────────────────
            action.status = ActionStatus.RUNNING
            action.executed_at = datetime.now(timezone.utc)
            db.commit()

            # ── Resolve lead URL ──────────────────────────────────────────────
            lead_url: str | None = None
            if action.lead_id:
                lead = db.get(Lead, action.lead_id)
                lead_url = lead.linkedin_url if lead else None

            # ── Load session ──────────────────────────────────────────────────
            session_mgr = SessionManager()
            session_row = db.query(BrowserSession).filter(
                BrowserSession.status == "ACTIVE"
            ).first()
            account_name = session_row.account_name if session_row else "default"
            storage_state = session_mgr.load_session(account_name)

            # ── Execute via browser ───────────────────────────────────────────
            browser_svc = BrowserService()
            result = browser_svc.run_action_sync(
                action_type=action.action_type,
                payload=action.payload,
                lead_url=lead_url,
                storage_state=storage_state,
            )

            # ── Persist result ────────────────────────────────────────────────
            action.status = ActionStatus.SUCCESS if result.get("success") else ActionStatus.FAILED
            action.result = result

            if result.get("session_expired") and session_row:
                session_row.status = "EXPIRED"
                celery_logger.warning("Action %s: session marked EXPIRED", action_id)

            db.commit()

            celery_logger.info("Action %s finished: %s", action_id, action.status)
            return result

        except Exception as exc:
            db.rollback()
            action_row = db.get(Action, action_id)
            if action_row:
                action_row.status = ActionStatus.RETRYING
                action_row.retry_count += 1
                action_row.result = {"error": str(exc)}
                db.commit()

            celery_logger.exception("Action %s failed: %s", action_id, exc)
            raise self.retry(exc=exc)
        finally:
            db.close()

    return _run(_run_action())


# ── Scheduler task ────────────────────────────────────────────────────────────

@celery_app.task(
    name="app.tasks.process_pending_actions",
    ignore_result=False,
)
def process_pending_actions() -> dict:
    """Enqueue all due PENDING actions."""
    celery_logger.info("process_pending_actions triggered")

    def _run_sync():
        from datetime import datetime, timezone
        from app.database import get_sync_session
        from app.models import Action, ActionStatus
        from app.services.rate_limiter import RateLimiterSync

        db = get_sync_session()
        queued = 0
        try:
            now = datetime.now(timezone.utc)
            pending = db.query(Action).filter(
                Action.status == ActionStatus.PENDING,
                (Action.scheduled_at == None) | (Action.scheduled_at <= now),
            ).all()

            rate_limiter = RateLimiterSync()
            for action in pending:
                if action.campaign_id:
                    allowed = rate_limiter.check_campaign_limit(action.campaign_id)
                    if not allowed:
                        celery_logger.debug("Campaign %s at daily limit – skip", action.campaign_id)
                        continue

                action.status = ActionStatus.QUEUED
                execute_action_task.delay(action.id)
                queued += 1

            db.commit()
            celery_logger.info("process_pending_actions: queued %s actions", queued)
            return {"queued": queued}
        finally:
            db.close()

    return _run_sync()


# ── Inbox polling task ────────────────────────────────────────────────────────

@celery_app.task(
    name="app.tasks.poll_linkedin_inbox",
    ignore_result=False,
    max_retries=2,
    default_retry_delay=120,
)
def poll_linkedin_inbox() -> dict:
    """
    Poll the LinkedIn inbox to:
    1. Detect accepted connection requests  → update lead.connection_status + queue follow-up
    2. Detect new inbound messages/replies  → store in messages table + update lead status
    """
    celery_logger.info("poll_linkedin_inbox started")

    from playwright.sync_api import sync_playwright
    from app.database import get_sync_session
    from app.models import (
        Lead, Action, ActionStatus, ActionType, BrowserSession,
        ConnectionStatus, LeadStatus, Message, MessageDirection, InboxPoll,
    )
    from app.services.session_manager import SessionManager

    db = get_sync_session()
    poll_log = InboxPoll()
    db.add(poll_log)
    db.flush()

    try:
        session_mgr = SessionManager()
        session_row = db.query(BrowserSession).filter(
            BrowserSession.status == "ACTIVE"
        ).first()

        if not session_row:
            celery_logger.warning("poll_linkedin_inbox: no active browser session found")
            poll_log.error = "No active LinkedIn session"
            db.commit()
            return {"error": "No active session"}

        storage_state = session_mgr.load_session(session_row.account_name)
        if not storage_state:
            celery_logger.warning("poll_linkedin_inbox: session file missing")
            poll_log.error = "Session file not found"
            db.commit()
            return {"error": "Session file not found"}

        poll_result: dict = {}

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, slow_mo=50)
            context = browser.new_context(
                viewport={"width": 1280, "height": 800},
                storage_state=storage_state,
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
            )
            page = context.new_page()

            async def _do_poll():
                from app.services.browser import InboxPollerHandler
                handler = InboxPollerHandler()
                return await handler.poll(page)

            try:
                poll_result = asyncio.run(_do_poll())
            finally:
                context.close()
                browser.close()

        now = datetime.now(timezone.utc)

        # ── Process accepted connections ───────────────────────────────────────
        accepts_found = 0
        followups_queued = 0

        for profile_url in poll_result.get("accepted_profiles", []):
            lead = db.query(Lead).filter(Lead.linkedin_url.ilike(f"%{_normalize_url(profile_url)}%")).first()
            if not lead:
                celery_logger.debug("poll_inbox: no lead found for profile %s", profile_url)
                continue

            if lead.connection_status == ConnectionStatus.ACCEPTED:
                continue  # already processed

            # Update connection status
            lead.connection_status = ConnectionStatus.ACCEPTED
            lead.connection_accepted_at = now
            lead.status = LeadStatus.ACTIVE
            accepts_found += 1
            celery_logger.info("Connection accepted: %s (lead_id=%s)", lead.name, lead.id)

            # Queue the follow-up message from the campaign sequence
            followup_action = _create_followup_action(db, lead, now)
            if followup_action:
                db.add(followup_action)
                followups_queued += 1

        # ── Process new inbound messages ───────────────────────────────────────
        replies_found = 0

        for msg_data in poll_result.get("new_messages", []):
            profile_url = msg_data.get("profile_url", "")
            sender_name = msg_data.get("sender_name", "")
            body = msg_data.get("body", "")
            thread_id = msg_data.get("thread_id", "")

            if not body:
                continue

            lead = None
            if profile_url:
                lead = db.query(Lead).filter(Lead.linkedin_url.ilike(f"%{_normalize_url(profile_url)}%")).first()

            if not lead and sender_name:
                # Fall back to name matching
                parts = sender_name.strip().split()
                if parts:
                    lead = db.query(Lead).filter(Lead.name.ilike(f"%{parts[0]}%")).first()

            if not lead:
                celery_logger.debug("poll_inbox: no lead for message from %s", sender_name)
                continue

            # Skip if we already have this message (dedup by thread_id + body snippet)
            existing = db.query(Message).filter(
                Message.lead_id == lead.id,
                Message.direction == MessageDirection.INBOUND,
                Message.body == body,
            ).first()
            if existing:
                continue

            # Store the message
            message = Message(
                lead_id=lead.id,
                direction=MessageDirection.INBOUND,
                body=body,
                linkedin_thread_id=thread_id,
                sent_at=now,
                read=False,
            )
            db.add(message)

            # Update lead status
            lead.status = LeadStatus.REPLIED
            lead.last_message_at = now
            replies_found += 1
            celery_logger.info("New reply from %s (lead_id=%s)", lead.name, lead.id)

        poll_log.accepts_found = accepts_found
        poll_log.replies_found = replies_found
        poll_log.followups_queued = followups_queued
        db.commit()

        celery_logger.info(
            "poll_linkedin_inbox complete | accepts=%d replies=%d followups=%d",
            accepts_found, replies_found, followups_queued
        )
        return {
            "accepts_found": accepts_found,
            "replies_found": replies_found,
            "followups_queued": followups_queued,
        }

    except Exception as exc:
        db.rollback()
        poll_log.error = str(exc)
        try:
            db.commit()
        except Exception:
            pass
        celery_logger.exception("poll_linkedin_inbox failed: %s", exc)
        return {"error": str(exc)}
    finally:
        db.close()


def _normalize_url(url: str) -> str:
    """Strip query params and trailing slashes for fuzzy matching."""
    return url.split("?")[0].rstrip("/").split("/in/")[-1] if "/in/" in url else url


def _create_followup_action(db, lead, now: datetime):
    """
    Look up the lead's campaign sequence and create the first follow-up action
    to be sent after connection acceptance, scheduled with the configured delay.
    """
    from app.models import Action, ActionStatus, ActionType, Campaign, Sequence, SequenceStep

    # Find the active campaign this lead belongs to
    action_ref = db.query(Action).filter(
        Action.lead_id == lead.id,
        Action.action_type == ActionType.CONNECT,
        Action.status == ActionStatus.SUCCESS,
    ).order_by(Action.created_at.desc()).first()

    if not action_ref or not action_ref.campaign_id:
        return None

    campaign = db.get(Campaign, action_ref.campaign_id)
    if not campaign:
        return None

    # Find the MESSAGE step in the campaign sequence
    sequence = db.query(Sequence).filter(Sequence.campaign_id == campaign.id).first()
    if not sequence:
        return None

    message_step = db.query(SequenceStep).filter(
        SequenceStep.sequence_id == sequence.id,
        SequenceStep.action_type == ActionType.MESSAGE,
    ).order_by(SequenceStep.day_offset).first()

    if not message_step or not message_step.message_template:
        return None

    # Personalise the template
    first_name = lead.name.split()[0] if lead.name else "there"
    company = lead.company or "your company"
    body = (message_step.message_template
            .replace("{{first_name}}", first_name)
            .replace("{{name}}", lead.name or "there")
            .replace("{{company}}", company))

    scheduled_at = now + timedelta(days=message_step.day_offset or 1)

    followup = Action(
        lead_id=lead.id,
        campaign_id=campaign.id,
        action_type=ActionType.MESSAGE,
        payload={"message": body},
        status=ActionStatus.PENDING,
        scheduled_at=scheduled_at,
    )
    return followup
