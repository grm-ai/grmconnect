"""Add messages table and connection tracking fields

Revision ID: 0002
Revises: 0001
Create Date: 2026-06-18 00:00:00.000000
"""
from __future__ import annotations
from typing import Sequence, Union
import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add connection tracking columns to leads
    op.add_column("leads", sa.Column("title", sa.String(255), nullable=True))
    op.add_column("leads", sa.Column("industry", sa.String(255), nullable=True))
    op.add_column("leads", sa.Column("location", sa.String(255), nullable=True))
    op.add_column("leads", sa.Column("connection_status",
        sa.Enum("NOT_SENT", "PENDING", "ACCEPTED", "IGNORED", name="connection_status"),
        nullable=False, server_default="NOT_SENT"))
    op.add_column("leads", sa.Column("connection_sent_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("leads", sa.Column("connection_accepted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("leads", sa.Column("last_message_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("leads", sa.Column("notes", sa.Text(), nullable=True))
    op.add_column("leads", sa.Column("score", sa.Integer(), nullable=False, server_default="0"))

    # messages table — stores full conversation history per lead
    op.create_table(
        "messages",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("lead_id", sa.BigInteger(), nullable=False),
        sa.Column("campaign_id", sa.BigInteger(), nullable=True),
        sa.Column("direction",
            sa.Enum("OUTBOUND", "INBOUND", name="message_direction"),
            nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("linkedin_thread_id", sa.String(512), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("read", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["lead_id"], ["leads.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["campaign_id"], ["campaigns.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_messages_lead_id", "messages", ["lead_id"])
    op.create_index("ix_messages_sent_at", "messages", ["sent_at"])
    op.create_index("ix_messages_direction", "messages", ["direction"])

    # inbox_polls — audit log of each inbox polling run
    op.create_table(
        "inbox_polls",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("polled_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("accepts_found", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("replies_found", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("followups_queued", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error", sa.Text(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("inbox_polls")
    op.drop_index("ix_messages_direction", table_name="messages")
    op.drop_index("ix_messages_sent_at", table_name="messages")
    op.drop_index("ix_messages_lead_id", table_name="messages")
    op.drop_table("messages")
    for col in ["score", "notes", "last_message_at", "connection_accepted_at",
                "connection_sent_at", "connection_status", "location", "industry", "title"]:
        op.drop_column("leads", col)
    op.execute("DROP TYPE IF EXISTS connection_status")
    op.execute("DROP TYPE IF EXISTS message_direction")
