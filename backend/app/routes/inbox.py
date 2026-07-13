"""
Inbox routes — conversation management and inbox polling.

GET  /inbox                   → list all conversations (one per lead with messages)
GET  /inbox/{lead_id}         → get full message thread for a lead
POST /inbox/{lead_id}/reply   → send a reply message to a lead
POST /inbox/poll              → manually trigger inbox polling (dispatches Celery task)
GET  /inbox/poll/status       → get last poll status
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.dependencies import get_db, require_auth
from app.security import get_current_user
from app.exceptions import BadRequestError
from app.models import (
    Action, ActionStatus, ActionType, InboxPoll, Lead, LeadStatus,
    Message, MessageDirection, User,
)
from app.schemas import ApiResponse, PaginatedResponse

router = APIRouter(prefix="/inbox", tags=["Inbox"])


# ── Schemas ───────────────────────────────────────────────────────────────────

class MessageOut(BaseModel):
    id: int
    lead_id: int
    direction: str
    body: str
    sent_at: str
    read: bool
    linkedin_thread_id: str | None

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_obj(cls, m: Message) -> "MessageOut":
        return cls(
            id=m.id,
            lead_id=m.lead_id,
            direction=m.direction.value,
            body=m.body,
            sent_at=m.sent_at.isoformat(),
            read=m.read,
            linkedin_thread_id=m.linkedin_thread_id,
        )


class ConversationOut(BaseModel):
    lead_id: int
    lead_name: str
    lead_company: str | None
    lead_linkedin_url: str | None
    lead_status: str
    connection_status: str
    last_message: str | None
    last_message_at: str | None
    unread_count: int
    linkedin_thread_id: str | None = None
    messages: list[MessageOut]


class ReplyRequest(BaseModel):
    body: str
    campaign_id: int | None = None


class PollStatusOut(BaseModel):
    id: int
    polled_at: str
    accepts_found: int
    replies_found: int
    followups_queued: int
    error: str | None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("", response_model=ApiResponse[list[ConversationOut]])
async def list_conversations(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[list[ConversationOut]]:
    """
    Return one ConversationOut per lead that has at least one message,
    sorted by last message time descending.
    """
    result = await db.execute(
        select(Lead)
        .join(Message, Message.lead_id == Lead.id)
        .where(Lead.user_id == user.id)
        .options(selectinload(Lead.messages))
        .group_by(Lead.id)
        .order_by(Lead.last_message_at.desc().nullslast())
    )
    leads = result.unique().scalars().all()

    conversations: list[ConversationOut] = []
    for lead in leads:
        msgs = sorted(lead.messages, key=lambda m: m.sent_at)
        unread = sum(1 for m in msgs if not m.read and m.direction == MessageDirection.INBOUND)
        last_msg = msgs[-1] if msgs else None
        thread_id = next((m.linkedin_thread_id for m in reversed(msgs) if m.linkedin_thread_id), None)
        conversations.append(ConversationOut(
            lead_id=lead.id,
            lead_name=lead.name,
            lead_company=lead.company,
            lead_linkedin_url=lead.linkedin_url,
            lead_status=lead.status.value,
            connection_status=lead.connection_status.value,
            last_message=last_msg.body[:200] if last_msg else None,
            last_message_at=last_msg.sent_at.isoformat() if last_msg else None,
            unread_count=unread,
            linkedin_thread_id=thread_id,
            messages=[MessageOut.from_orm_obj(m) for m in msgs],
        ))

    return ApiResponse(data=conversations, message=f"{len(conversations)} conversations")


@router.post("/ingest", response_model=ApiResponse[dict])
async def ingest_inbox(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Store LinkedIn conversations fetched by the extension. Each conversation is keyed by the other
    participant's /in/<vanity>; we match it to a lead and upsert its messages (deduped by
    direction+body so re-fetching is idempotent).
    """
    import re
    conversations = body.get("conversations", []) or []

    def vanity_of(url: str | None) -> str | None:
        if not url or "/in/" not in url:
            return None
        return (url.split("/in/")[1].split("/")[0].split("?")[0].strip().lower()) or None

    def norm_name(s: str | None) -> str:
        return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", "", (s or "").lower())).strip()

    leads = (await db.execute(select(Lead).where(Lead.user_id == user.id))).scalars().all()
    lead_by_vanity: dict[str, Lead] = {}
    lead_by_name: dict[str, Lead] = {}
    for l in leads:
        v = vanity_of(l.linkedin_url)
        if v:
            lead_by_vanity[v] = l
        n = norm_name(l.name)
        if n:
            lead_by_name.setdefault(n, l)

    def match_lead(conv) -> Lead | None:
        # The messaging GraphQL gives the participant's URN-based profileUrl (not the public vanity),
        # so vanity rarely matches — match by NAME (normalized; exact, else prefix either direction).
        v = str(conv.get("vanity") or "").strip().lower()
        if v and v in lead_by_vanity:
            return lead_by_vanity[v]
        n = norm_name(conv.get("name"))
        if not n:
            return None
        if n in lead_by_name:
            return lead_by_name[n]
        for ln, l in lead_by_name.items():
            if ln.startswith(n) or n.startswith(ln):
                return l
        return None

    added = 0
    matched_threads = 0
    for conv in conversations:
        lead = match_lead(conv)
        if not lead:
            continue
        matched_threads += 1
        existing = (await db.execute(select(Message).where(Message.lead_id == lead.id))).scalars().all()
        seen = {(m.direction.value, (m.body or "").strip()[:200]) for m in existing}
        last_at = lead.last_message_at
        # SQLite returns naive datetimes; coerce to tz-aware so comparisons below don't TypeError.
        if last_at is not None and last_at.tzinfo is None:
            last_at = last_at.replace(tzinfo=timezone.utc)
        for m in conv.get("messages", []):
            text = str(m.get("body") or "").strip()
            if not text:
                continue
            direction = MessageDirection.OUTBOUND if m.get("dir") == "OUTBOUND" else MessageDirection.INBOUND
            key = (direction.value, text[:200])
            if key in seen:
                continue
            seen.add(key)
            at_ms = m.get("at") or 0
            try:
                sent_at = datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc) if at_ms else datetime.now(timezone.utc)
            except Exception:
                sent_at = datetime.now(timezone.utc)
            db.add(Message(
                user_id=lead.user_id,
                lead_id=lead.id,
                direction=direction,
                body=text,
                sent_at=sent_at,
                read=(direction == MessageDirection.OUTBOUND),
                linkedin_thread_id=str(conv.get("threadId") or "") or None,
            ))
            added += 1
            if last_at is None or sent_at > last_at:
                last_at = sent_at
        lead.last_message_at = last_at

    await db.commit()
    return ApiResponse(
        message=f"Inbox synced — {added} new message(s) across {matched_threads} matched conversation(s).",
        data={"added": added, "matched_threads": matched_threads, "conversations_seen": len(conversations)},
    )


@router.get("/{lead_id}", response_model=ApiResponse[ConversationOut])
async def get_conversation(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[ConversationOut]:
    """Get the full message thread for a specific lead."""
    result = await db.execute(
        select(Lead).options(selectinload(Lead.messages)).where(Lead.id == lead_id, Lead.user_id == user.id)
    )
    lead = result.scalar_one_or_none()
    if not lead:
        raise BadRequestError(f"Lead {lead_id} not found")

    msgs = sorted(lead.messages, key=lambda m: m.sent_at)

    # Mark inbound messages as read
    for m in msgs:
        if not m.read and m.direction == MessageDirection.INBOUND:
            m.read = True
    await db.flush()

    unread = 0
    last_msg = msgs[-1] if msgs else None

    return ApiResponse(data=ConversationOut(
        lead_id=lead.id,
        lead_name=lead.name,
        lead_company=lead.company,
        lead_linkedin_url=lead.linkedin_url,
        lead_status=lead.status.value,
        connection_status=lead.connection_status.value,
        last_message=last_msg.body[:200] if last_msg else None,
        last_message_at=last_msg.sent_at.isoformat() if last_msg else None,
        unread_count=unread,
        messages=[MessageOut.from_orm_obj(m) for m in msgs],
    ))


@router.post("/{lead_id}/record", response_model=ApiResponse[dict])
async def record_outbound(
    lead_id: int,
    body: ReplyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Store an OUTBOUND message that the extension has ALREADY sent via LinkedIn (no Playwright).
    Used by the inbox reply + campaign follow-ups so the message persists in the thread.
    """
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise BadRequestError(f"Lead {lead_id} not found")
    now = datetime.now(timezone.utc)
    msg = Message(
        user_id=user.id,
        lead_id=lead_id,
        campaign_id=body.campaign_id,
        direction=MessageDirection.OUTBOUND,
        body=body.body,
        sent_at=now,
        read=True,
    )
    db.add(msg)
    lead.last_message_at = now
    await db.flush()
    return ApiResponse(message="Recorded.", data={"message_id": msg.id})


@router.post("/{lead_id}/reply", response_model=ApiResponse[dict])
async def send_reply(
    lead_id: int,
    body: ReplyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Queue a MESSAGE action for this lead so the Celery worker sends it via
    Playwright, and store it in messages as OUTBOUND.
    """
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise BadRequestError(f"Lead {lead_id} not found")
    if not lead.linkedin_url:
        raise BadRequestError("Lead has no LinkedIn URL — cannot send message")

    # Queue Playwright action
    action = Action(
        user_id=user.id,
        lead_id=lead_id,
        campaign_id=body.campaign_id,
        action_type=ActionType.MESSAGE,
        payload={"message": body.body},
        status=ActionStatus.PENDING,
    )
    db.add(action)
    await db.flush()

    # Dispatch immediately
    from app.tasks import execute_action_task
    task = execute_action_task.delay(action.id)

    # Store outbound message record
    msg = Message(
        user_id=user.id,
        lead_id=lead_id,
        campaign_id=body.campaign_id,
        direction=MessageDirection.OUTBOUND,
        body=body.body,
        sent_at=datetime.now(timezone.utc),
        read=True,
    )
    db.add(msg)
    lead.last_message_at = datetime.now(timezone.utc)

    return ApiResponse(
        message="Reply queued.",
        data={"action_id": action.id, "task_id": task.id},
    )


@router.post("/poll", response_model=ApiResponse[dict])
async def trigger_poll(
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Manually trigger an inbox poll via Celery."""
    from app.tasks import poll_linkedin_inbox
    task = poll_linkedin_inbox.delay()
    return ApiResponse(message="Inbox poll dispatched.", data={"task_id": task.id})


@router.get("/poll/status", response_model=ApiResponse[PollStatusOut | None])
async def poll_status(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[PollStatusOut | None]:
    """Return the most recent inbox poll result."""
    result = await db.execute(
        select(InboxPoll).order_by(InboxPoll.polled_at.desc()).limit(1)
    )
    poll = result.scalar_one_or_none()
    if not poll:
        return ApiResponse(data=None, message="No polls run yet.")
    return ApiResponse(data=PollStatusOut(
        id=poll.id,
        polled_at=poll.polled_at.isoformat(),
        accepts_found=poll.accepts_found,
        replies_found=poll.replies_found,
        followups_queued=poll.followups_queued,
        error=poll.error,
    ))
