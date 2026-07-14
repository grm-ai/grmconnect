from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.security import get_current_user
from app.exceptions import ActionNotFoundError, BadRequestError
from app.models import Action, ActionStatus, User
from app.schemas import (
    ActionCreate,
    ActionOut,
    ActionQueueRequest,
    ApiResponse,
    PaginatedResponse,
)

router = APIRouter(prefix="/actions", tags=["Actions"])


# ── CRUD ──────────────────────────────────────────────────────────────────────

@router.post("", response_model=ApiResponse[ActionOut], status_code=status.HTTP_201_CREATED)
async def create_action(
    body: ActionCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[ActionOut]:
    action = Action(**body.model_dump(), user_id=user.id)
    db.add(action)
    await db.flush()
    await db.refresh(action)
    return ApiResponse(message="Action created.", data=ActionOut.model_validate(action))


@router.get("", response_model=PaginatedResponse[ActionOut])
async def list_actions(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    status_filter: str | None = Query(None, alias="status"),
    campaign_id: int | None = Query(None),
    lead_id: int | None = Query(None),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PaginatedResponse[ActionOut]:
    q = select(Action).where(Action.user_id == user.id)
    if status_filter:
        q = q.where(Action.status == status_filter)
    if campaign_id:
        q = q.where(Action.campaign_id == campaign_id)
    if lead_id:
        q = q.where(Action.lead_id == lead_id)

    total = (await db.execute(select(func.count()).select_from(q.subquery()))).scalar_one()
    rows = (
        await db.execute(
            q.order_by(Action.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
        )
    ).scalars().all()
    return PaginatedResponse(
        data=[ActionOut.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


async def _get_own_action(db: AsyncSession, action_id: int, user: User) -> Action:
    """Fetch an action, but only if it belongs to the current user (else 404 — no cross-tenant peeking)."""
    action = await db.get(Action, action_id)
    if not action or action.user_id != user.id:
        raise ActionNotFoundError()
    return action


@router.get("/{action_id}", response_model=ApiResponse[ActionOut])
async def get_action(
    action_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[ActionOut]:
    action = await _get_own_action(db, action_id, user)
    return ApiResponse(data=ActionOut.model_validate(action))


@router.delete("/{action_id}", response_model=ApiResponse[None])
async def delete_action(
    action_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[None]:
    action = await _get_own_action(db, action_id, user)
    await db.delete(action)
    return ApiResponse(message="Action deleted.")


# ── Queue / Control ───────────────────────────────────────────────────────────

@router.post("/queue", response_model=ApiResponse[dict])
async def queue_actions(
    body: ActionQueueRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    from app.tasks import execute_action_task

    queued = []
    for action_id in body.action_ids:
        action = await db.get(Action, action_id)
        if not action or action.user_id != user.id:
            continue
        if action.status not in (ActionStatus.PENDING, ActionStatus.FAILED):
            continue
        action.status = ActionStatus.QUEUED
        task = execute_action_task.delay(action.id)
        queued.append({"action_id": action.id, "task_id": task.id})

    return ApiResponse(
        message=f"Queued {len(queued)} actions.",
        data={"queued": queued},
    )


@router.post("/{action_id}/retry", response_model=ApiResponse[dict])
async def retry_action(
    action_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    from app.tasks import execute_action_task

    action = await _get_own_action(db, action_id, user)
    if action.status not in (ActionStatus.FAILED, ActionStatus.CANCELLED):
        raise BadRequestError(f"Cannot retry action in status {action.status!r}")

    action.status = ActionStatus.QUEUED
    action.retry_count += 1
    task = execute_action_task.delay(action.id)
    return ApiResponse(
        message="Action queued for retry.",
        data={"action_id": action_id, "task_id": task.id},
    )


@router.post("/{action_id}/cancel", response_model=ApiResponse[None])
async def cancel_action(
    action_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[None]:
    action = await _get_own_action(db, action_id, user)
    if action.status in (ActionStatus.SUCCESS, ActionStatus.RUNNING):
        raise BadRequestError(f"Cannot cancel action in status {action.status!r}")

    action.status = ActionStatus.CANCELLED
    return ApiResponse(message="Action cancelled.")


@router.get("/{action_id}/logs", response_model=ApiResponse[dict])
async def get_action_logs(
    action_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    action = await _get_own_action(db, action_id, user)
    return ApiResponse(
        data={
            "action_id": action_id,
            "status": action.status,
            "retry_count": action.retry_count,
            "result": action.result or {},
            "scheduled_at": action.scheduled_at.isoformat() if action.scheduled_at else None,
            "executed_at": action.executed_at.isoformat() if action.executed_at else None,
        }
    )
