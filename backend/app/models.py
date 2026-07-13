from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

# SQLite uses INTEGER for autoincrement PKs; PostgreSQL uses BIGINT.
# This variant handles both transparently.
AutoPK = BigInteger().with_variant(Integer, "sqlite")


# ── Enums ─────────────────────────────────────────────────────────────────────

class LeadStatus(str, enum.Enum):
    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    CONTACTED = "CONTACTED"
    REPLIED = "REPLIED"
    CONVERTED = "CONVERTED"
    ARCHIVED = "ARCHIVED"


class ConnectionStatus(str, enum.Enum):
    NOT_SENT = "NOT_SENT"
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    IGNORED = "IGNORED"


class MessageDirection(str, enum.Enum):
    OUTBOUND = "OUTBOUND"
    INBOUND = "INBOUND"


class CampaignStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    COMPLETED = "COMPLETED"


class ActionType(str, enum.Enum):
    CONNECT = "CONNECT"
    MESSAGE = "MESSAGE"
    FOLLOWUP = "FOLLOWUP"
    VIEW_PROFILE = "VIEW_PROFILE"
    CUSTOM = "CUSTOM"


class ActionStatus(str, enum.Enum):
    PENDING = "PENDING"
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    RETRYING = "RETRYING"


class SessionStatus(str, enum.Enum):
    ACTIVE = "ACTIVE"
    EXPIRED = "EXPIRED"
    INVALID = "INVALID"


# ── Models ────────────────────────────────────────────────────────────────────

class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    name: Mapped[str | None] = mapped_column(String(255))
    # Per-user "About You" outreach identity (used by the AI to personalise messages).
    sender_name: Mapped[str | None] = mapped_column(String(255))
    sender_role: Mapped[str | None] = mapped_column(String(255))
    sender_company: Mapped[str | None] = mapped_column(String(255))
    sender_about: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class Lead(Base):
    __tablename__ = "leads"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    title: Mapped[str | None] = mapped_column(String(255))
    company: Mapped[str | None] = mapped_column(String(255))
    industry: Mapped[str | None] = mapped_column(String(255))
    location: Mapped[str | None] = mapped_column(String(255))
    linkedin_url: Mapped[str | None] = mapped_column(String(512))
    email: Mapped[str | None] = mapped_column(String(255))
    status: Mapped[LeadStatus] = mapped_column(
        Enum(LeadStatus, name="lead_status"), default=LeadStatus.PENDING, nullable=False
    )
    connection_status: Mapped[ConnectionStatus] = mapped_column(
        Enum(ConnectionStatus, name="connection_status"),
        default=ConnectionStatus.NOT_SENT, nullable=False
    )
    connection_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    connection_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    score: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text)
    # Call/meeting tracking — AI detects a likely-booked call; user confirms.
    # NONE (default/unset) | PENDING (AI thinks a call was agreed) | CONFIRMED (user confirmed).
    meeting_status: Mapped[str | None] = mapped_column(String(20))
    meeting_detail: Mapped[str | None] = mapped_column(Text)
    meeting_detected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    actions: Mapped[list[Action]] = relationship("Action", back_populates="lead", cascade="all, delete-orphan")
    messages: Mapped[list[Message]] = relationship("Message", back_populates="lead", cascade="all, delete-orphan")


class Campaign(Base):
    __tablename__ = "campaigns"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    # The end-goal the AI drives every message toward (e.g. "book a 15-min call about funding").
    goal: Mapped[str | None] = mapped_column(Text)
    # When true, the AI auto-sends goal-driven replies to inbound messages (full autopilot).
    autopilot: Mapped[bool] = mapped_column(default=False, nullable=False)
    status: Mapped[CampaignStatus] = mapped_column(
        Enum(CampaignStatus, name="campaign_status"), default=CampaignStatus.DRAFT, nullable=False
    )
    daily_limit: Mapped[int] = mapped_column(Integer, default=20, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    actions: Mapped[list[Action]] = relationship("Action", back_populates="campaign", cascade="all, delete-orphan")
    sequences: Mapped[list[Sequence]] = relationship("Sequence", back_populates="campaign", cascade="all, delete-orphan")


class Action(Base):
    __tablename__ = "actions"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    campaign_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("campaigns.id", ondelete="SET NULL"))
    lead_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("leads.id", ondelete="SET NULL"))
    action_type: Mapped[ActionType] = mapped_column(
        Enum(ActionType, name="action_type"), nullable=False
    )
    payload: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    status: Mapped[ActionStatus] = mapped_column(
        Enum(ActionStatus, name="action_status"), default=ActionStatus.PENDING, nullable=False
    )
    retry_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    result: Mapped[dict | None] = mapped_column(JSON)
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    campaign: Mapped[Campaign | None] = relationship("Campaign", back_populates="actions")
    lead: Mapped[Lead | None] = relationship("Lead", back_populates="actions")


class Sequence(Base):
    __tablename__ = "sequences"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    campaign_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("campaigns.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(255), nullable=False)

    campaign: Mapped[Campaign] = relationship("Campaign", back_populates="sequences")
    steps: Mapped[list[SequenceStep]] = relationship("SequenceStep", back_populates="sequence", cascade="all, delete-orphan")


class SequenceStep(Base):
    __tablename__ = "sequence_steps"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    sequence_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("sequences.id", ondelete="CASCADE"), nullable=False)
    day_offset: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    action_type: Mapped[ActionType] = mapped_column(
        Enum(ActionType, name="action_type"), nullable=False
    )
    message_template: Mapped[str | None] = mapped_column(Text)

    sequence: Mapped[Sequence] = relationship("Sequence", back_populates="steps")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    lead_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("leads.id", ondelete="CASCADE"), nullable=False)
    campaign_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("campaigns.id", ondelete="SET NULL"))
    direction: Mapped[MessageDirection] = mapped_column(
        Enum(MessageDirection, name="message_direction"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    linkedin_thread_id: Mapped[str | None] = mapped_column(String(512))
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    read: Mapped[bool] = mapped_column(default=False, nullable=False)

    lead: Mapped[Lead] = relationship("Lead", back_populates="messages")
    campaign: Mapped[Campaign | None] = relationship("Campaign")


class InboxPoll(Base):
    __tablename__ = "inbox_polls"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    polled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    accepts_found: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    replies_found: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    followups_queued: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)


class BrowserSession(Base):
    __tablename__ = "browser_sessions"

    id: Mapped[int] = mapped_column(AutoPK, primary_key=True, autoincrement=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id", ondelete="CASCADE"), index=True)
    account_name: Mapped[str] = mapped_column(String(255), nullable=False)
    cookie_file: Mapped[str] = mapped_column(String(512), nullable=False)
    status: Mapped[SessionStatus] = mapped_column(
        Enum(SessionStatus, name="session_status"), default=SessionStatus.ACTIVE, nullable=False
    )
    linkedin_name: Mapped[str | None] = mapped_column(String(255))
    linkedin_headline: Mapped[str | None] = mapped_column(String(512))
    linkedin_profile_url: Mapped[str | None] = mapped_column(String(512))
    last_used: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

