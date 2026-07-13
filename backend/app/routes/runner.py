from __future__ import annotations

from fastapi import APIRouter, Depends

from app.dependencies import require_auth
from app.exceptions import BadRequestError
from app.schemas import ApiResponse, RunTaskRequest, RunTaskResponse

router = APIRouter(prefix="/run-task", tags=["Runner"])

# Registry of tasks that can be triggered via the API
_ALLOWED_TASKS: dict[str, str] = {
    "execute_action_task": "app.tasks.execute_action_task",
    "process_pending_actions": "app.tasks.process_pending_actions",
}


@router.post("", response_model=ApiResponse[RunTaskResponse])
async def run_task(
    body: RunTaskRequest,
    _: str = require_auth,
) -> ApiResponse[RunTaskResponse]:
    from celery import current_app as celery_current

    full_name = _ALLOWED_TASKS.get(body.task_name)
    if not full_name:
        raise BadRequestError(
            f"Unknown task '{body.task_name}'. Allowed: {list(_ALLOWED_TASKS)}"
        )

    from app.celery_app import celery_app
    task_fn = celery_app.tasks.get(full_name)
    if task_fn is None:
        raise BadRequestError(f"Task '{full_name}' not registered in Celery.")

    result = task_fn.apply_async(kwargs=body.kwargs, countdown=body.countdown)

    return ApiResponse(
        message="Task dispatched.",
        data=RunTaskResponse(
            task_id=result.id,
            task_name=full_name,
        ),
    )
