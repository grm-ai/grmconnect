from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.dependencies import get_db, require_auth
from app.exceptions import BadRequestError
from app.logger import app_logger
from app.schemas import ApiResponse, WebhookPayload

router = APIRouter(prefix="/webhook", tags=["Webhook"])


@router.post("/n8n", response_model=ApiResponse[dict])
async def n8n_webhook(
    payload: WebhookPayload,
    request: Request,
    db=Depends(get_db),
    _: str = require_auth,
) -> ApiResponse[dict]:
    """
    Generic webhook endpoint for n8n automations.

    Supported events:
      - lead.create       → creates a new lead
      - lead.update       → updates an existing lead
      - campaign.activate → sets campaign status to ACTIVE
      - action.queue      → queues a list of action IDs
      - action.create     → creates and immediately queues a new action
    """
    event = payload.event
    data = payload.data
    app_logger.info("Webhook received | event=%s", event)

    if event == "lead.create":
        from app.models import Lead
        from app.schemas import LeadCreate

        body = LeadCreate(**data)
        lead = Lead(**body.model_dump())
        db.add(lead)
        await db.flush()
        await db.refresh(lead)
        return ApiResponse(message="Lead created via webhook.", data={"lead_id": lead.id})

    elif event == "lead.update":
        from app.models import Lead
        from app.exceptions import LeadNotFoundError

        lead_id = data.pop("id", None)
        if not lead_id:
            raise BadRequestError("'id' is required for lead.update event")
        lead = await db.get(Lead, lead_id)
        if not lead:
            raise LeadNotFoundError()
        for k, v in data.items():
            if hasattr(lead, k):
                setattr(lead, k, v)
        await db.flush()
        return ApiResponse(message="Lead updated via webhook.", data={"lead_id": lead_id})

    elif event == "campaign.activate":
        from app.models import Campaign, CampaignStatus
        from app.exceptions import CampaignNotFoundError

        campaign_id = data.get("campaign_id")
        if not campaign_id:
            raise BadRequestError("'campaign_id' required")
        campaign = await db.get(Campaign, campaign_id)
        if not campaign:
            raise CampaignNotFoundError()
        campaign.status = CampaignStatus.ACTIVE
        await db.flush()
        return ApiResponse(message="Campaign activated.", data={"campaign_id": campaign_id})

    elif event == "action.queue":
        from app.tasks import execute_action_task
        from app.models import Action, ActionStatus

        action_ids = data.get("action_ids", [])
        if not action_ids:
            raise BadRequestError("'action_ids' list is required")

        queued = []
        for aid in action_ids:
            action = await db.get(Action, aid)
            if action and action.status == ActionStatus.PENDING:
                action.status = ActionStatus.QUEUED
                task = execute_action_task.delay(action.id)
                queued.append({"action_id": aid, "task_id": task.id})

        return ApiResponse(
            message=f"Queued {len(queued)} actions.",
            data={"queued": queued},
        )

    elif event == "action.create":
        from app.models import Action
        from app.schemas import ActionCreate
        from app.tasks import execute_action_task

        body = ActionCreate(**data)
        action = Action(**body.model_dump())
        db.add(action)
        await db.flush()
        await db.refresh(action)
        task = execute_action_task.delay(action.id)
        return ApiResponse(
            message="Action created and queued.",
            data={"action_id": action.id, "task_id": task.id},
        )

    else:
        raise BadRequestError(f"Unknown event type: '{event}'")
