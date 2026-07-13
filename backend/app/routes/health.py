from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import text

from app.config import settings
from app.database import AsyncSessionLocal
from app.redis_client import redis_ping
from app.schemas import ApiResponse, HealthOut

router = APIRouter(tags=["Health"])


@router.get("/health", response_model=ApiResponse[HealthOut])
async def health_check() -> ApiResponse[HealthOut]:
    # DB probe
    db_status = "ok"
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
    except Exception:
        db_status = "error"

    # Redis probe
    redis_status = "ok" if await redis_ping() else "error"

    overall = "ok" if db_status == "ok" and redis_status == "ok" else "degraded"
    return ApiResponse(
        data=HealthOut(
            status=overall,
            version=settings.app_version,
            db=db_status,
            redis=redis_status,
        )
    )
