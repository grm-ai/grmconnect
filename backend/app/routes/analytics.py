from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.dependencies import get_db
from app.security import get_current_user
from app.models import (
    Action, ActionType, Campaign, CampaignStatus,
    ConnectionStatus, Lead, LeadStatus, Message, MessageDirection, User,
)
from app.schemas import ApiResponse

router = APIRouter(prefix="/analytics", tags=["Analytics"])


@router.get("/stats", response_model=ApiResponse[dict])
async def get_stats(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    uid = user.id
    total_leads        = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid))).scalar_one()
    active_campaigns   = (await db.execute(select(func.count()).select_from(Campaign).where(Campaign.user_id == uid, Campaign.status == CampaignStatus.ACTIVE))).scalar_one()
    connections_sent   = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.connection_status.in_([ConnectionStatus.PENDING, ConnectionStatus.ACCEPTED])))).scalar_one()
    connections_accepted = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.connection_status == ConnectionStatus.ACCEPTED))).scalar_one()
    replies_received   = (await db.execute(select(func.count()).select_from(Message).where(Message.user_id == uid, Message.direction == MessageDirection.INBOUND))).scalar_one()
    replied_leads      = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.status == LeadStatus.REPLIED))).scalar_one()
    converted_leads    = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.status == LeadStatus.CONVERTED))).scalar_one()

    acceptance_rate = round(connections_accepted / connections_sent * 100, 1) if connections_sent > 0 else 0.0

    return ApiResponse(data={
        "total_leads": total_leads,
        "active_campaigns": active_campaigns,
        "connections_sent": connections_sent,
        "connections_accepted": connections_accepted,
        "replies_received": replies_received,
        "replied_leads": replied_leads,
        "converted_leads": converted_leads,
        "acceptance_rate": acceptance_rate,
        "hot_leads": connections_accepted,
        "meetings_booked": converted_leads,
        "conversion_rate": acceptance_rate,
    })


@router.get("/funnel", response_model=ApiResponse[list[dict]])
async def get_funnel(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[list[dict]]:
    uid = user.id
    total      = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid))).scalar_one() or 1
    contacted  = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.connection_status.in_([ConnectionStatus.PENDING, ConnectionStatus.ACCEPTED])))).scalar_one()
    accepted   = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.connection_status == ConnectionStatus.ACCEPTED))).scalar_one()
    replied    = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.status == LeadStatus.REPLIED))).scalar_one()
    converted  = (await db.execute(select(func.count()).select_from(Lead).where(Lead.user_id == uid, Lead.status == LeadStatus.CONVERTED))).scalar_one()

    def pct(n: int) -> int:
        return round(n / total * 100)

    return ApiResponse(data=[
        {"stage": "Leads",     "count": total,     "percentage": 100,       "color": "#6366f1"},
        {"stage": "Contacted", "count": contacted,  "percentage": pct(contacted),  "color": "#8b5cf6"},
        {"stage": "Accepted",  "count": accepted,   "percentage": pct(accepted),   "color": "#a78bfa"},
        {"stage": "Replied",   "count": replied,    "percentage": pct(replied),    "color": "#c4b5fd"},
        {"stage": "Converted", "count": converted,  "percentage": pct(converted),  "color": "#ddd6fe"},
    ])


@router.get("/trends", response_model=ApiResponse[dict])
async def get_trends(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=14)

    rows = (await db.execute(
        select(Message.sent_at, Message.direction)
        .where(Message.user_id == user.id, Message.sent_at >= cutoff)
    )).all()

    sent_by_day: dict[str, int] = {}
    replies_by_day: dict[str, int] = {}

    for sent_at, direction in rows:
        day = sent_at.strftime("%Y-%m-%d")
        if direction == MessageDirection.OUTBOUND:
            sent_by_day[day] = sent_by_day.get(day, 0) + 1
        else:
            replies_by_day[day] = replies_by_day.get(day, 0) + 1

    days = [
        (datetime.now(timezone.utc) - timedelta(days=i)).strftime("%Y-%m-%d")
        for i in range(13, -1, -1)
    ]

    return ApiResponse(data={
        "sent":    [{"date": d, "value": sent_by_day.get(d, 0)}    for d in days],
        "replies": [{"date": d, "value": replies_by_day.get(d, 0)} for d in days],
    })


@router.get("/activity", response_model=ApiResponse[list[dict]])
async def get_activity(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[list[dict]]:
    result = await db.execute(
        select(Action)
        .where(Action.user_id == user.id)
        .options(selectinload(Action.lead))
        .order_by(Action.created_at.desc())
        .limit(20)
    )
    actions = result.scalars().all()

    _labels: dict[ActionType, str] = {
        ActionType.CONNECT:      "Connection request sent",
        ActionType.MESSAGE:      "Message sent",
        ActionType.FOLLOWUP:     "Follow-up sent",
        ActionType.VIEW_PROFILE: "Profile viewed",
        ActionType.CUSTOM:       "Custom action",
    }

    activities = []
    for action in actions:
        lead_name    = action.lead.name    if action.lead else "Unknown"
        lead_company = action.lead.company if action.lead else ""
        activities.append({
            "id":           str(action.id),
            "type":         action.action_type.value.lower(),
            "title":        _labels.get(action.action_type, action.action_type.value),
            "description":  f"{lead_name}{f' at {lead_company}' if lead_company else ''}",
            "lead_name":    lead_name,
            "lead_company": lead_company or "",
            "status":       action.status.value,
            "created_at":   action.created_at.isoformat(),
        })

    return ApiResponse(data=activities, message=f"{len(activities)} recent activities")
