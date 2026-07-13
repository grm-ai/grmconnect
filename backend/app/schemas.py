from __future__ import annotations

from datetime import datetime
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from app.models import (
    ActionStatus,
    ActionType,
    CampaignStatus,
    LeadStatus,
    SessionStatus,
)

T = TypeVar("T")


# ── Generic response wrappers ─────────────────────────────────────────────────

class ApiResponse(BaseModel, Generic[T]):
    success: bool = True
    message: str = "OK"
    data: T | None = None


class PaginatedResponse(BaseModel, Generic[T]):
    success: bool = True
    message: str = "OK"
    data: list[T] = []
    total: int = 0
    page: int = 1
    page_size: int = 20


class ErrorResponse(BaseModel):
    success: bool = False
    message: str
    details: dict[str, Any] = {}


# ── Lead ──────────────────────────────────────────────────────────────────────

class LeadCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    company: str | None = Field(None, max_length=255)
    linkedin_url: str | None = Field(None, max_length=512)
    email: str | None = Field(None, max_length=255)
    status: LeadStatus = LeadStatus.PENDING


class LeadUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    company: str | None = None
    linkedin_url: str | None = None
    email: str | None = None
    status: LeadStatus | None = None


class LeadOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    title: str | None
    company: str | None
    industry: str | None
    location: str | None
    linkedin_url: str | None
    email: str | None
    status: LeadStatus
    connection_status: str
    score: int
    notes: str | None
    connection_sent_at: datetime | None
    connection_accepted_at: datetime | None
    last_message_at: datetime | None
    created_at: datetime


# ── Campaign ──────────────────────────────────────────────────────────────────

class CampaignCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    description: str | None = None
    goal: str | None = None
    autopilot: bool = False
    status: CampaignStatus = CampaignStatus.DRAFT
    daily_limit: int = Field(20, ge=1, le=500)


class CampaignUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    description: str | None = None
    goal: str | None = None
    autopilot: bool | None = None
    status: CampaignStatus | None = None
    daily_limit: int | None = Field(None, ge=1, le=500)


class CampaignOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: str | None
    goal: str | None = None
    autopilot: bool = False
    status: CampaignStatus
    daily_limit: int
    created_at: datetime


# ── Action ────────────────────────────────────────────────────────────────────

class ActionCreate(BaseModel):
    campaign_id: int | None = None
    lead_id: int | None = None
    action_type: ActionType
    payload: dict[str, Any] = {}
    scheduled_at: datetime | None = None


class ActionQueueRequest(BaseModel):
    action_ids: list[int] = Field(..., min_length=1)


class ActionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    campaign_id: int | None
    lead_id: int | None
    action_type: ActionType
    payload: dict[str, Any]
    status: ActionStatus
    retry_count: int
    result: dict[str, Any] | None
    scheduled_at: datetime | None
    executed_at: datetime | None
    created_at: datetime


# ── Sequence ──────────────────────────────────────────────────────────────────

class SequenceStepCreate(BaseModel):
    day_offset: int = Field(0, ge=0)
    action_type: ActionType
    message_template: str | None = None


class SequenceCreate(BaseModel):
    campaign_id: int
    name: str = Field(..., min_length=1, max_length=255)
    steps: list[SequenceStepCreate] = []


class SequenceStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    sequence_id: int
    day_offset: int
    action_type: ActionType
    message_template: str | None


class SequenceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    campaign_id: int
    name: str
    steps: list[SequenceStepOut] = []


# ── Session ───────────────────────────────────────────────────────────────────

class BrowserSessionCreate(BaseModel):
    account_name: str = Field(..., min_length=1, max_length=255)
    cookie_file: str = Field(..., min_length=1, max_length=512)


class BrowserSessionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_name: str
    cookie_file: str
    status: SessionStatus
    last_used: datetime | None


# ── Runner ────────────────────────────────────────────────────────────────────

class RunTaskRequest(BaseModel):
    task_name: str = Field(..., description="Registered task name to execute")
    kwargs: dict[str, Any] = Field(default_factory=dict)
    countdown: int = Field(0, ge=0, description="Seconds to delay execution")


class RunTaskResponse(BaseModel):
    task_id: str
    task_name: str
    status: str = "queued"


# ── Webhook ───────────────────────────────────────────────────────────────────

class WebhookPayload(BaseModel):
    event: str
    data: dict[str, Any] = {}


# ── Health ────────────────────────────────────────────────────────────────────

class HealthOut(BaseModel):
    status: str = "ok"
    version: str
    db: str
    redis: str
