from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from app.config import settings
from app.logger import app_logger
from app.models import ActionType, CampaignStatus


class CampaignEngine:
    """
    High-level service that materialises sequence steps into Action rows
    for all active campaigns.
    """

    async def enqueue_due_steps(self, db) -> int:
        from sqlalchemy import select
        from app.models import Action, Campaign, Lead, Sequence, SequenceStep, LeadStatus

        now = datetime.now(timezone.utc)
        created = 0

        result = await db.execute(
            select(Campaign).where(Campaign.status == CampaignStatus.ACTIVE)
        )
        campaigns = result.scalars().all()

        for campaign in campaigns:
            seq_result = await db.execute(
                select(Sequence).where(Sequence.campaign_id == campaign.id)
            )
            sequences = seq_result.scalars().all()

            lead_result = await db.execute(
                select(Lead).where(Lead.status.in_([LeadStatus.ACTIVE, LeadStatus.PENDING]))
            )
            leads = lead_result.scalars().all()

            for sequence in sequences:
                step_result = await db.execute(
                    select(SequenceStep)
                    .where(SequenceStep.sequence_id == sequence.id)
                    .order_by(SequenceStep.day_offset)
                )
                steps = step_result.scalars().all()

                for lead in leads:
                    for step in steps:
                        exists = await db.execute(
                            select(Action).where(
                                Action.campaign_id == campaign.id,
                                Action.lead_id == lead.id,
                                Action.action_type == step.action_type,
                            )
                        )
                        if exists.scalars().first():
                            continue

                        payload: dict[str, Any] = {}
                        if step.message_template:
                            payload["message"] = self._render_template(
                                step.message_template, lead
                            )

                        action = Action(
                            user_id=campaign.user_id,   # keep actions owned by the campaign's user
                            campaign_id=campaign.id,
                            lead_id=lead.id,
                            action_type=step.action_type,
                            payload=payload,
                            scheduled_at=now,
                        )
                        db.add(action)
                        created += 1

        await db.flush()
        app_logger.info("CampaignEngine | created %s new actions", created)
        return created

    def _render_template(self, template: str, lead) -> str:
        return (
            template
            .replace("{{name}}", lead.name or "")
            .replace("{{company}}", lead.company or "")
            .replace("{{email}}", lead.email or "")
        )
