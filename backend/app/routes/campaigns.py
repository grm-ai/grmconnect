from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, require_auth
from app.security import get_current_user
from app.exceptions import CampaignNotFoundError
from app.logger import app_logger
from app.models import (
    Action, ActionStatus, ActionType, Campaign, CampaignStatus,
    ConnectionStatus, Lead, LeadStatus, Message, MessageDirection, User,
)
from app.schemas import (
    ApiResponse,
    CampaignCreate,
    CampaignOut,
    CampaignUpdate,
    PaginatedResponse,
)

router = APIRouter(prefix="/campaigns", tags=["Campaigns"])

# Default drip: (day_offset, action_type). Day 0 connect → Day 2 message → Day 5 follow-up.
_DEFAULT_SEQUENCE = [
    (0, ActionType.CONNECT),
    (2, ActionType.MESSAGE),
    (5, ActionType.FOLLOWUP),
]


def _vanity(url: str | None) -> str | None:
    if not url or "/in/" not in url:
        return None
    return (url.split("/in/")[1].split("/")[0].split("?")[0].strip().lower()) or None


@router.post("", response_model=ApiResponse[CampaignOut], status_code=status.HTTP_201_CREATED)
async def create_campaign(
    body: CampaignCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[CampaignOut]:
    campaign = Campaign(**body.model_dump(), user_id=user.id)
    db.add(campaign)
    await db.flush()
    await db.refresh(campaign)
    return ApiResponse(message="Campaign created.", data=CampaignOut.model_validate(campaign))


@router.get("", response_model=PaginatedResponse[CampaignOut])
async def list_campaigns(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    status_filter: str | None = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PaginatedResponse[CampaignOut]:
    q = select(Campaign).where(Campaign.user_id == user.id)
    if status_filter:
        q = q.where(Campaign.status == status_filter)

    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    rows = (await db.execute(q.offset((page - 1) * page_size).limit(page_size))).scalars().all()
    return PaginatedResponse(
        data=[CampaignOut.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


_DEFAULT_TEMPLATES = {
    ActionType.CONNECT:  "Hi {{first_name}}, I came across your profile and would love to connect.",
    ActionType.MESSAGE:  "Thanks for connecting, {{first_name}}! I'd love to learn more about your work at {{company}} — open to a quick chat?",
    ActionType.FOLLOWUP: "Just following up, {{first_name}} — happy to share more whenever you have a moment.",
}


def _render(tpl: str, lead: Lead) -> str:
    first = (lead.name or "").strip().split(" ")[0] if lead.name else "there"
    return (tpl.replace("{{first_name}}", first)
               .replace("{{name}}", lead.name or "there")
               .replace("{{company}}", lead.company or "your company")
               .replace("{{title}}", lead.title or ""))[:800]


@router.post("/{campaign_id}/activate", response_model=ApiResponse[dict])
async def activate_campaign(
    campaign_id: int,
    body: dict | None = None,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Activate a campaign for a chosen AUDIENCE with chosen TEMPLATES. Body (all optional):
      { "lead_ids": [..],                     # audience; omitted → all URL-imported, non-connected
        "connect_template": "...{{first_name}}...",
        "message_template": "...", "followup_template": "..." }
    Enrols each lead and materialises the drip (Day0 CONNECT / Day2 MESSAGE / Day5 FOLLOWUP) as
    Action rows whose payload carries the RENDERED text for that specific lead — so exactly what
    each person will receive is fixed and visible. Idempotent (won't double-enrol).
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    body = body or {}
    lead_ids = body.get("lead_ids")
    id_filter = set(int(x) for x in lead_ids) if lead_ids else None
    # A blank template means "let the AI write this step per-lead" from the campaign goal +
    # the About You profile — resolved lazily at /due time. A provided template is used as-is.
    templates = {
        ActionType.CONNECT:  (body.get("connect_template")  or "").strip(),
        ActionType.MESSAGE:  (body.get("message_template")  or "").strip(),
        ActionType.FOLLOWUP: (body.get("followup_template") or "").strip(),
    }

    leads = (await db.execute(select(Lead).where(Lead.user_id == user.id))).scalars().all()

    # URL audience: find-or-create leads from pasted profile URLs, then target exactly those.
    urls = body.get("urls") or []
    if urls:
        by_vanity = {}
        for l in leads:
            v = _vanity(l.linkedin_url)
            if v:
                by_vanity[v] = l
        url_ids: set[int] = set()
        created = 0
        for raw in urls:
            u = str(raw).strip()
            if "/in/" not in u:
                continue
            v = _vanity(u)
            if not v:
                continue
            lead = by_vanity.get(v)
            if not lead:
                full = u if u.startswith("http") else f"https://www.linkedin.com/in/{v}"
                name = (v.replace("-", " ").replace(".", " ").strip().title()[:80]) or "LinkedIn Member"
                lead = Lead(name=name, linkedin_url=full, status=LeadStatus.PENDING, connection_status=ConnectionStatus.NOT_SENT, user_id=user.id)
                db.add(lead)
                await db.flush()
                leads.append(lead)
                by_vanity[v] = lead
                created += 1
            url_ids.add(lead.id)
        if url_ids:
            id_filter = url_ids if id_filter is None else (id_filter | url_ids)
        app_logger.info("campaign %s: %d URLs → %d new leads created", campaign_id, len(urls), created)

    now = datetime.now(timezone.utc)
    enrolled = 0
    for lead in leads:
        if id_filter is not None and lead.id not in id_filter:
            continue
        if not lead.linkedin_url or "/in/" not in lead.linkedin_url:
            continue  # only URL-imported profiles
        if lead.connection_status == ConnectionStatus.ACCEPTED:
            continue
        existing = (await db.execute(
            select(func.count()).where(Action.campaign_id == campaign_id, Action.lead_id == lead.id)
        )).scalar() or 0
        if existing:
            continue
        for day_offset, atype in _DEFAULT_SEQUENCE:
            tpl = templates[atype]
            payload = {"day_offset": day_offset, "source": "campaign_drip"}
            if tpl:
                payload["text"] = _render(tpl, lead)
            else:
                payload["text"] = ""      # AI writes this step lazily at /due (goal + About You)
                payload["ai"] = True
            db.add(Action(
                user_id=user.id,
                campaign_id=campaign_id,
                lead_id=lead.id,
                action_type=atype,
                status=ActionStatus.PENDING,
                scheduled_at=now + timedelta(days=day_offset),
                payload=payload,
            ))
        enrolled += 1

    # set_active=False → just import/enrol the leads (campaign stays DRAFT, nothing is sent).
    # Sending only begins once the user explicitly Activates. Defaults True for backward-compat.
    set_active = bool(body.get("set_active", True))
    if set_active:
        campaign.status = CampaignStatus.ACTIVE
    await db.commit()
    app_logger.info("campaign %s %s — enrolled %d leads", campaign_id,
                    "activated" if set_active else "imported (draft)", enrolled)
    return ApiResponse(
        message=(f"Campaign activated — {enrolled} leads enrolled into the drip." if set_active
                 else f"Imported {enrolled} lead(s) — nothing sent yet. Click Activate to start sending."),
        data={"enrolled": enrolled, "daily_limit": campaign.daily_limit, "set_active": set_active},
    )


@router.get("/{campaign_id}/due", response_model=ApiResponse[list[dict]])
async def campaign_due_actions(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[list[dict]]:
    """
    Return the DUE steps for a campaign (scheduled_at <= now, still PENDING), gated by relationship
    state and capped at the campaign's daily_limit. CONNECT is due only while the lead is NOT_SENT;
    MESSAGE/FOLLOWUP only once the lead is ACCEPTED (connected). Message text is AI-generated here.
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    now = datetime.now(timezone.utc)

    # For steps left blank at launch (payload.ai == True), the AI writes the text per-lead now,
    # driven by the campaign goal + your About You profile. Generated text is cached back into the
    # action payload so it's stable and not regenerated on the next poll.
    from app.services.ai_generator import AIGenerator
    from app.routes.settings_route import get_user_keys
    ai = AIGenerator(sender={
        "sender_name": user.sender_name or "", "sender_role": user.sender_role or "",
        "sender_company": user.sender_company or "", "sender_about": user.sender_about or "",
        "sender_talking_points": user.sender_talking_points or "",
    }, keys=get_user_keys(user.id))
    goal = (campaign.goal or "").strip()
    _dirty = {"v": False}

    async def resolve_text(a: Action, lead: Lead) -> str:
        text = (a.payload or {}).get("text") or ""
        if text or not (a.payload or {}).get("ai"):
            return text
        if a.action_type == ActionType.CONNECT:
            t = await ai.generate_connect_note(
                lead.name, lead.company, lead.title,
                context=(f"Your goal with this outreach: {goal}" if goal else ""),
            )
        elif a.action_type == ActionType.MESSAGE:
            t = await ai.generate_message(
                lead.name, lead.company,
                purpose=(f"your first message now that they accepted your connection request; naturally work toward: {goal}"
                         if goal else "a warm first message now that they connected"),
            )
        else:  # FOLLOWUP
            t = await ai.generate_message(
                lead.name, lead.company,
                purpose=(f"a brief, friendly follow-up that nudges toward: {goal}"
                         if goal else "a brief, friendly follow-up"),
            )
        t = (t or "").strip()
        if t:
            a.payload = {**(a.payload or {}), "text": t}
            _dirty["v"] = True
        return t

    # ── GLOBAL daily caps ────────────────────────────────────────────────────
    # 20/day (etc.) must be a HARD cap across ALL campaigns AND every other send path,
    # not per-batch. Count what's already gone out today and only hand back the remainder,
    # so auto-run cycles can never push the daily total past the limit.
    from app.config import settings as _cfg
    from app.services.rate_limiter import RateLimiter
    _rl = RateLimiter()
    connect_used = await _rl.count_connect_sent_today(db, user.id)   # from the lead, survives campaign delete
    msg_used = (await _rl._count_from_db(db, None, "MESSAGE", user_id=user.id)) + (await _rl._count_from_db(db, None, "FOLLOWUP", user_id=user.id))
    connect_remaining = max(0, _cfg.daily_connect_limit - connect_used)
    msg_remaining = max(0, _cfg.daily_message_limit - msg_used)

    rows = (await db.execute(
        select(Action).where(
            Action.campaign_id == campaign_id,
            Action.status == ActionStatus.PENDING,
            Action.scheduled_at <= now,
        ).order_by(Action.scheduled_at)
    )).scalars().all()

    out: list[dict] = []
    connect_added = 0
    msg_added = 0
    for a in rows:
        if len(out) >= campaign.daily_limit:
            break
        lead = await db.get(Lead, a.lead_id) if a.lead_id else None
        if not lead or not lead.linkedin_url:
            continue
        if a.action_type == ActionType.CONNECT:
            if lead.connection_status != ConnectionStatus.NOT_SENT:
                continue  # already sent/connected → skip (runner will mark it done)
            if connect_added >= connect_remaining:
                continue  # global daily connect limit reached → hand back nothing more
            text = await resolve_text(a, lead)
            out.append({"action_id": a.id, "action_type": "CONNECT", "lead_id": lead.id,
                        "lead_name": lead.name, "linkedin_url": lead.linkedin_url, "text": text or None})
            connect_added += 1
        else:  # MESSAGE / FOLLOWUP
            if lead.connection_status != ConnectionStatus.ACCEPTED:
                continue  # not connected yet → not due
            # Only message people WE actually invited & won. A lead can be ACCEPTED merely because
            # name-sync matched a PRE-EXISTING connection (someone you were already connected to) —
            # we must NOT auto-message those; they never got a campaign invite.
            connect_won = (await db.execute(
                select(Action.id).where(
                    Action.campaign_id == campaign_id,
                    Action.lead_id == lead.id,
                    Action.action_type == ActionType.CONNECT,
                    Action.status == ActionStatus.SUCCESS,
                ).limit(1)
            )).scalar_one_or_none()
            if not connect_won:
                continue  # pre-existing connection (name-matched) → don't auto-message
            if msg_added >= msg_remaining:
                continue  # global daily message limit reached
            text = await resolve_text(a, lead)
            if not text:
                text = f"Hi {lead.name}, great to be connected! Would love to exchange ideas."
            thread = None
            m = (await db.execute(
                select(Message).where(Message.lead_id == lead.id, Message.linkedin_thread_id.isnot(None))
                .order_by(Message.sent_at.desc()).limit(1)
            )).scalar_one_or_none()
            if m:
                thread = m.linkedin_thread_id
            out.append({"action_id": a.id, "action_type": a.action_type.value, "lead_id": lead.id,
                        "lead_name": lead.name, "linkedin_url": lead.linkedin_url, "text": text, "thread": thread})
            msg_added += 1

    if _dirty["v"]:
        await db.commit()
    return ApiResponse(data=out, message=f"{len(out)} due step(s).")


@router.post("/actions/{action_id}/result", response_model=ApiResponse[dict])
async def campaign_action_result(
    action_id: int,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Record the outcome of a campaign step the extension executed."""
    action = await db.get(Action, action_id)
    if not action or action.user_id != user.id:
        raise HTTPException(status_code=404, detail="Action not found")
    now = datetime.now(timezone.utc)
    success = bool(body.get("success"))
    already_connected = bool(body.get("already_connected"))
    already_pending = bool(body.get("already_pending"))
    lead = await db.get(Lead, action.lead_id) if action.lead_id else None

    # "Already connected" / "already pending" are NOT failures — the person is reachable.
    # Record them as SUCCESS and sync the lead's real state so we don't keep retrying them.
    if already_connected:
        action.status = ActionStatus.SUCCESS
        action.executed_at = now
        action.result = {"already_connected": True}
        if lead:
            lead.connection_status = ConnectionStatus.ACCEPTED
            if not lead.connection_accepted_at:
                lead.connection_accepted_at = now
        await db.commit()
        return ApiResponse(message="Already connected.", data={"action_id": action_id, "status": "SUCCESS", "already_connected": True})

    if already_pending:
        action.status = ActionStatus.SUCCESS
        action.executed_at = now
        action.result = {"already_pending": True}
        if lead and lead.connection_status == ConnectionStatus.NOT_SENT:
            lead.connection_status = ConnectionStatus.PENDING
        await db.commit()
        return ApiResponse(message="Already pending.", data={"action_id": action_id, "status": "SUCCESS", "already_pending": True})

    action.status = ActionStatus.SUCCESS if success else ActionStatus.FAILED
    action.executed_at = now
    action.result = {"success": success, "error": body.get("error")}

    if success and lead:
        if action.action_type == ActionType.CONNECT:
            if lead.connection_status == ConnectionStatus.NOT_SENT:
                lead.connection_status = ConnectionStatus.PENDING
                # Stamp the send on the LEAD (survives campaign deletion) so the daily cap is accurate.
                lead.connection_sent_at = now
        else:  # MESSAGE / FOLLOWUP → persist the outbound message
            db.add(Message(
                lead_id=lead.id,
                campaign_id=action.campaign_id,
                direction=MessageDirection.OUTBOUND,
                body=str(body.get("text") or "")[:2000] or "(campaign message)",
                sent_at=now,
                read=True,
            ))
            lead.last_message_at = now
    await db.commit()
    return ApiResponse(message="Recorded.", data={"action_id": action_id, "status": action.status.value})


@router.get("/{campaign_id}/progress", response_model=ApiResponse[dict])
async def campaign_progress(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Per-lead drip progress: for every enrolled lead, the status of each step (connect / message /
    follow-up) + a human-readable current stage, plus summary counts. This is what the campaign
    detail shows so you can see WHO got contacted, how far each is, and what's next.
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()

    actions = (await db.execute(
        select(Action).where(Action.campaign_id == campaign_id).order_by(Action.lead_id, Action.scheduled_at)
    )).scalars().all()

    type_key = {ActionType.CONNECT: "connect", ActionType.MESSAGE: "message", ActionType.FOLLOWUP: "followup"}
    by_lead: dict[int, dict] = {}
    for a in actions:
        if a.lead_id is None:
            continue
        entry = by_lead.setdefault(a.lead_id, {"lead_id": a.lead_id, "connect": None, "message": None, "followup": None})
        k = type_key.get(a.action_type)
        if k:
            entry[k] = {
                "status": a.status.value,
                "scheduled_at": a.scheduled_at.isoformat() if a.scheduled_at else None,
                "executed_at": a.executed_at.isoformat() if a.executed_at else None,
            }

    def stage_of(lead, e) -> str:
        cs = lead.connection_status
        conn = (e.get("connect") or {}).get("status")
        msg = (e.get("message") or {}).get("status")
        fu = (e.get("followup") or {}).get("status")
        if cs == ConnectionStatus.ACCEPTED:
            if fu == "SUCCESS":
                return "Done — full sequence sent"
            if msg == "SUCCESS":
                return "Connected · follow-up pending (Day 5)"
            return "Connected · message pending (Day 2)"
        if conn == "SUCCESS" or cs == ConnectionStatus.PENDING:
            return "Invite sent · awaiting acceptance"
        if conn == "FAILED":
            return "Connect failed"
        return "Not started (connect pending)"

    leads_out: list[dict] = []
    summary = {"enrolled": 0,
               "connect": {"SUCCESS": 0, "PENDING": 0, "FAILED": 0},
               "message": {"SUCCESS": 0, "PENDING": 0, "FAILED": 0},
               "followup": {"SUCCESS": 0, "PENDING": 0, "FAILED": 0}}
    for lead_id, e in by_lead.items():
        lead = await db.get(Lead, lead_id)
        if not lead:
            continue
        # Source of truth for "did we connect" is the lead's connection_status, NOT the raw
        # connect-action status. If the lead is ACCEPTED/PENDING, the connect effectively
        # succeeded — override a stale/false "failed" so the table shows the real state.
        if lead.connection_status in (ConnectionStatus.ACCEPTED, ConnectionStatus.PENDING) and e.get("connect"):
            e["connect"]["status"] = "SUCCESS"
        summary["enrolled"] += 1
        for k in ("connect", "message", "followup"):
            st = (e.get(k) or {}).get("status")
            if st in ("SUCCESS", "FAILED"):
                summary[k][st] += 1
            elif st:
                summary[k]["PENDING"] += 1
        leads_out.append({
            **e,
            "lead_name": lead.name,
            "lead_company": lead.company,
            "linkedin_url": lead.linkedin_url,
            "connection_status": lead.connection_status.value,
            "stage": stage_of(lead, e),
        })

    # Sort: connected first, then invite-sent, then not-started.
    order = {"Connected": 0, "Invite": 1}
    leads_out.sort(key=lambda x: (0 if x["connection_status"] == "ACCEPTED" else 1 if x["connection_status"] == "PENDING" else 2, x["lead_name"]))
    return ApiResponse(data={"summary": summary, "leads": leads_out}, message=f"{summary['enrolled']} leads in drip.")


@router.post("/{campaign_id}/retry-failed", response_model=ApiResponse[dict])
async def retry_failed_connects(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Re-queue FAILED connect steps so they're attempted again. Many 'failed' invites are transient
    (creator profiles where Connect is behind the '...' menu, redirects, timing) — SN member-id
    URLs actually redirect to the real profile, so a retry usually succeeds. Only resets leads still
    NOT_SENT (won't touch anyone already pending/connected). The daily cap still applies on send.
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    now = datetime.now(timezone.utc)
    actions = (await db.execute(
        select(Action).where(
            Action.campaign_id == campaign_id,
            Action.action_type == ActionType.CONNECT,
            Action.status == ActionStatus.FAILED,
        )
    )).scalars().all()
    reset = 0
    for a in actions:
        lead = await db.get(Lead, a.lead_id) if a.lead_id else None
        if lead and lead.connection_status == ConnectionStatus.NOT_SENT:
            a.status = ActionStatus.PENDING
            a.scheduled_at = now
            a.result = None
            reset += 1
    await db.commit()
    return ApiResponse(message=f"{reset} failed invite(s) re-queued — Activate/Auto-run will retry them (daily cap applies).",
                       data={"reset": reset})


@router.get("/{campaign_id}/autopilot/pending", response_model=ApiResponse[list[dict]])
async def campaign_autopilot_pending(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[list[dict]]:
    """
    For an autopilot campaign: find connected leads whose LAST message is an unanswered INBOUND
    reply, draft a goal-driven AI response for each, and (as a side effect) detect whether a
    call/meeting was agreed — flagging it as meeting_status=PENDING for the dashboard to confirm.
    The frontend sends each drafted reply via the extension, then records it, which flips the
    thread to OUTBOUND so it won't be re-answered.
    """
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    if not campaign.autopilot:
        return ApiResponse(data=[], message="Autopilot is off for this campaign.")

    from app.services.ai_generator import AIGenerator

    lead_ids = (await db.execute(
        select(Action.lead_id).where(
            Action.campaign_id == campaign_id, Action.lead_id.isnot(None)
        ).distinct()
    )).scalars().all()

    # Respect the GLOBAL daily message cap — autopilot replies count as messages too.
    from app.config import settings as _cfg
    from app.services.rate_limiter import RateLimiter
    _rl = RateLimiter()
    msg_used = (await _rl._count_from_db(db, None, "MESSAGE", user_id=user.id)) + (await _rl._count_from_db(db, None, "FOLLOWUP", user_id=user.id))
    msg_remaining = max(0, _cfg.daily_message_limit - msg_used)

    ai = AIGenerator(sender={
        "sender_name": user.sender_name or "", "sender_role": user.sender_role or "",
        "sender_company": user.sender_company or "", "sender_about": user.sender_about or "",
        "sender_talking_points": user.sender_talking_points or "",
    }, keys=get_user_keys(user.id))
    goal = (campaign.goal or "").strip()
    out: list[dict] = []
    for lid in lead_ids:
        if len(out) >= min(campaign.daily_limit, msg_remaining):
            break
        lead = await db.get(Lead, lid)
        if not lead or lead.connection_status != ConnectionStatus.ACCEPTED:
            continue
        msgs = (await db.execute(
            select(Message).where(Message.lead_id == lid).order_by(Message.sent_at)
        )).scalars().all()
        if not msgs or msgs[-1].direction != MessageDirection.INBOUND:
            continue  # no thread, or we already replied → nothing to do

        thread = [{"direction": m.direction.value, "body": m.body} for m in msgs]

        # Detect a newly-agreed call → flag for the dashboard (user confirms).
        try:
            det = await ai.detect_meeting(thread)
            if det.get("booked") and lead.meeting_status != "CONFIRMED":
                lead.meeting_status = "PENDING"
                lead.meeting_detail = det.get("detail") or ""
                lead.meeting_detected_at = datetime.now(timezone.utc)
        except Exception as exc:
            app_logger.warning("autopilot meeting-detect failed for lead %s: %s", lid, exc)

        reply = await ai.generate_reply(lead.name, thread, goal=goal, lead_company=lead.company)
        if not reply:
            continue
        thread_id = next((m.linkedin_thread_id for m in reversed(msgs) if m.linkedin_thread_id), None)
        out.append({
            "lead_id": lid,
            "lead_name": lead.name,
            "linkedin_url": lead.linkedin_url,
            "thread": thread_id,
            "reply": reply,
        })

    await db.commit()
    return ApiResponse(data=out, message=f"{len(out)} autopilot reply(ies) drafted.")


@router.get("/{campaign_id}", response_model=ApiResponse[CampaignOut])
async def get_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[CampaignOut]:
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    return ApiResponse(data=CampaignOut.model_validate(campaign))


@router.patch("/{campaign_id}", response_model=ApiResponse[CampaignOut])
async def update_campaign(
    campaign_id: int,
    body: CampaignUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[CampaignOut]:
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(campaign, field, value)
    await db.flush()
    await db.refresh(campaign)
    return ApiResponse(message="Campaign updated.", data=CampaignOut.model_validate(campaign))


@router.delete("/{campaign_id}", response_model=ApiResponse[None])
async def delete_campaign(
    campaign_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[None]:
    campaign = await db.get(Campaign, campaign_id)
    if not campaign or campaign.user_id != user.id:
        raise CampaignNotFoundError()
    await db.delete(campaign)
    return ApiResponse(message="Campaign deleted.")
