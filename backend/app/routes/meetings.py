"""
Meetings — calls the AI flagged as likely-booked during autopilot conversations.

GET  /meetings                  → list leads with a PENDING or CONFIRMED call
POST /meetings/{lead_id}/confirm → user confirms the call is real
POST /meetings/{lead_id}/dismiss → user dismisses a false positive
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, require_auth
from app.security import get_current_user
from app.exceptions import BadRequestError
from app.models import Action, Campaign, Lead, User
from app.schemas import ApiResponse

router = APIRouter(prefix="/meetings", tags=["Meetings"])


async def _campaign_name_for_lead(db: AsyncSession, lead_id: int) -> str | None:
    row = (await db.execute(
        select(Action.campaign_id).where(
            Action.lead_id == lead_id, Action.campaign_id.isnot(None)
        ).limit(1)
    )).scalar_one_or_none()
    if not row:
        return None
    camp = await db.get(Campaign, row)
    return camp.name if camp else None


@router.get("", response_model=ApiResponse[dict])
async def list_meetings(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Return leads with a call the AI flagged (PENDING) or the user confirmed (CONFIRMED)."""
    leads = (await db.execute(
        select(Lead).where(Lead.user_id == user.id, Lead.meeting_status.in_(["PENDING", "CONFIRMED"]))
        .order_by(Lead.meeting_detected_at.desc().nullslast())
    )).scalars().all()

    pending: list[dict] = []
    confirmed: list[dict] = []
    for lead in leads:
        item = {
            "lead_id": lead.id,
            "lead_name": lead.name,
            "lead_company": lead.company,
            "linkedin_url": lead.linkedin_url,
            "detail": lead.meeting_detail or "",
            "detected_at": lead.meeting_detected_at.isoformat() if lead.meeting_detected_at else None,
            "campaign": await _campaign_name_for_lead(db, lead.id),
        }
        (confirmed if lead.meeting_status == "CONFIRMED" else pending).append(item)

    return ApiResponse(
        data={"pending": pending, "confirmed": confirmed,
              "pending_count": len(pending), "confirmed_count": len(confirmed)},
        message=f"{len(pending)} pending, {len(confirmed)} confirmed call(s).",
    )


@router.post("/{lead_id}/confirm", response_model=ApiResponse[dict])
async def confirm_meeting(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise BadRequestError(f"Lead {lead_id} not found")
    lead.meeting_status = "CONFIRMED"
    if not lead.meeting_detected_at:
        lead.meeting_detected_at = datetime.now(timezone.utc)
    await db.commit()
    return ApiResponse(message="Call confirmed.", data={"lead_id": lead_id, "meeting_status": "CONFIRMED"})


@router.post("/{lead_id}/dismiss", response_model=ApiResponse[dict])
async def dismiss_meeting(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise BadRequestError(f"Lead {lead_id} not found")
    lead.meeting_status = None
    lead.meeting_detail = None
    lead.meeting_detected_at = None
    await db.commit()
    return ApiResponse(message="Dismissed.", data={"lead_id": lead_id, "meeting_status": "NONE"})
