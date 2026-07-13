from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.security import get_current_user
from app.models import User
from app.schemas import ApiResponse

router = APIRouter(prefix="/ai", tags=["AI"])


def _sender_of(user: User) -> dict:
    return {
        "sender_name": user.sender_name or "", "sender_role": user.sender_role or "",
        "sender_company": user.sender_company or "", "sender_about": user.sender_about or "",
    }


class GenerateRequest(BaseModel):
    action: str                  # generate | rewrite | shorten | expand | follow_up | connect
    lead_name: str | None = None
    lead_company: str | None = None
    lead_title: str | None = None
    lead_industry: str | None = None
    context: str | None = None
    tone: str | None = None
    existing_message: str | None = None


class GenerateResponse(BaseModel):
    message: str
    tokens_used: int = 0


@router.post("/generate", response_model=ApiResponse[GenerateResponse])
async def generate_message(
    body: GenerateRequest,
    user: User = Depends(get_current_user),
) -> ApiResponse[GenerateResponse]:
    from app.services.ai_generator import AIGenerator

    ai = AIGenerator(sender=_sender_of(user))
    name    = body.lead_name or "there"
    company = body.lead_company
    context = body.context or ""

    if body.action == "connect":
        text = await ai.generate_connect_note(
            lead_name=name,
            lead_company=company,
            context=context,
        )

    elif body.action == "shorten" and body.existing_message:
        sentences = body.existing_message.split(". ")
        text = ". ".join(sentences[: max(1, len(sentences) // 2)]) + "."

    elif body.action == "expand" and body.existing_message:
        text = await ai.generate_message(
            lead_name=name,
            lead_company=company,
            purpose=f"expand on this message: {body.existing_message[:200]}",
        )

    elif body.action == "follow_up":
        text = await ai.generate_message(
            lead_name=name,
            lead_company=company,
            purpose="following up on my previous message — keeping it brief and adding value",
        )

    else:
        # generate | rewrite | default
        purpose = context or "introducing myself and exploring potential synergies"
        text = await ai.generate_message(
            lead_name=name,
            lead_company=company,
            purpose=purpose,
        )

    return ApiResponse(data=GenerateResponse(message=text or ""))
