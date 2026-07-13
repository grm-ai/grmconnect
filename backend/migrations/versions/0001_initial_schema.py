"""Initial schema

Revision ID: 0001
Revises:
Create Date: 2024-01-01 00:00:00.000000
"""
from __future__ import annotations
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "leads",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("company", sa.String(255), nullable=True),
        sa.Column("linkedin_url", sa.String(512), nullable=True),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column(
            "status",
            sa.Enum("PENDING", "ACTIVE", "CONTACTED", "REPLIED", "CONVERTED", "ARCHIVED",
                    name="lead_status"),
            nullable=False, server_default="PENDING",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "campaigns",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column(
            "status",
            sa.Enum("DRAFT", "ACTIVE", "PAUSED", "COMPLETED", name="campaign_status"),
            nullable=False, server_default="DRAFT",
        ),
        sa.Column("daily_limit", sa.Integer(), nullable=False, server_default="20"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "actions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("campaign_id", sa.BigInteger(), nullable=True),
        sa.Column("lead_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "action_type",
            sa.Enum("CONNECT", "MESSAGE", "FOLLOWUP", "VIEW_PROFILE", "CUSTOM",
                    name="action_type"),
            nullable=False,
        ),
        sa.Column("payload", sa.JSON(), nullable=False, server_default="{}"),
        sa.Column(
            "status",
            sa.Enum("PENDING", "QUEUED", "RUNNING", "SUCCESS", "FAILED", "CANCELLED",
                    "RETRYING", name="action_status"),
            nullable=False, server_default="PENDING",
        ),
        sa.Column("retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("scheduled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("executed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["campaign_id"], ["campaigns.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["lead_id"], ["leads.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "sequences",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("campaign_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(255), nullable=False),
        sa.ForeignKeyConstraint(["campaign_id"], ["campaigns.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "sequence_steps",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("sequence_id", sa.BigInteger(), nullable=False),
        sa.Column("day_offset", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "action_type",
            sa.Enum("CONNECT", "MESSAGE", "FOLLOWUP", "VIEW_PROFILE", "CUSTOM",
                    name="action_type"),
            nullable=False,
        ),
        sa.Column("message_template", sa.Text(), nullable=True),
        sa.ForeignKeyConstraint(["sequence_id"], ["sequences.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "browser_sessions",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("account_name", sa.String(255), nullable=False, unique=True),
        sa.Column("cookie_file", sa.String(512), nullable=False),
        sa.Column(
            "status",
            sa.Enum("ACTIVE", "EXPIRED", "INVALID", name="session_status"),
            nullable=False, server_default="ACTIVE",
        ),
        sa.Column("last_used", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_index("ix_leads_status", "leads", ["status"])
    op.create_index("ix_actions_status", "actions", ["status"])
    op.create_index("ix_actions_campaign_id", "actions", ["campaign_id"])
    op.create_index("ix_actions_lead_id", "actions", ["lead_id"])
    op.create_index("ix_actions_scheduled_at", "actions", ["scheduled_at"])


def downgrade() -> None:
    op.drop_index("ix_actions_scheduled_at", table_name="actions")
    op.drop_index("ix_actions_lead_id", table_name="actions")
    op.drop_index("ix_actions_campaign_id", table_name="actions")
    op.drop_index("ix_actions_status", table_name="actions")
    op.drop_index("ix_leads_status", table_name="leads")
    op.drop_table("browser_sessions")
    op.drop_table("sequence_steps")
    op.drop_table("sequences")
    op.drop_table("actions")
    op.drop_table("campaigns")
    op.drop_table("leads")
    for enum_name in ("lead_status", "campaign_status", "action_type", "action_status", "session_status"):
        op.execute(f"DROP TYPE IF EXISTS {enum_name}")
