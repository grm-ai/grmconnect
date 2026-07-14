"""
Auth routes — email + password signup/login, returning a JWT the frontend stores and sends
as `Authorization: Bearer <token>` on every request.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db
from app.exceptions import BadRequestError, UnauthorizedError
from app.models import User
from app.schemas import ApiResponse
from app.security import create_access_token, get_current_user, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["Auth"])


class SignupIn(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    password: str = Field(..., min_length=6, max_length=128)
    name: str | None = None


class LoginIn(BaseModel):
    email: str
    password: str


class AuthOut(BaseModel):
    token: str
    user: dict


class ProfileIn(BaseModel):
    sender_name: str | None = None
    sender_role: str | None = None
    sender_company: str | None = None
    sender_about: str | None = None
    sender_talking_points: str | None = None


def _norm_email(e: str) -> str:
    return (e or "").strip().lower()


def _user_dict(u: User) -> dict:
    return {
        "id": u.id, "email": u.email, "name": u.name,
        "sender_name": u.sender_name, "sender_role": u.sender_role,
        "sender_company": u.sender_company, "sender_about": u.sender_about,
        "sender_talking_points": u.sender_talking_points,
    }


@router.post("/signup", response_model=ApiResponse[AuthOut])
async def signup(body: SignupIn, db: AsyncSession = Depends(get_db)) -> ApiResponse[AuthOut]:
    email = _norm_email(body.email)
    if "@" not in email or "." not in email.split("@")[-1]:
        raise BadRequestError("Please enter a valid email address.")
    exists = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if exists:
        raise BadRequestError("An account with this email already exists — please log in.")
    user = User(
        email=email,
        password_hash=hash_password(body.password),
        name=(body.name or "").strip() or None,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    token = create_access_token(user.id)
    await db.commit()
    return ApiResponse(
        message="Account created.",
        data=AuthOut(token=token, user={"id": user.id, "email": user.email, "name": user.name}),
    )


@router.post("/login", response_model=ApiResponse[AuthOut])
async def login(body: LoginIn, db: AsyncSession = Depends(get_db)) -> ApiResponse[AuthOut]:
    email = _norm_email(body.email)
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if not user or not verify_password(body.password, user.password_hash):
        raise UnauthorizedError("Wrong email or password.")
    token = create_access_token(user.id)
    return ApiResponse(
        message="Logged in.",
        data=AuthOut(token=token, user={"id": user.id, "email": user.email, "name": user.name}),
    )


@router.get("/me", response_model=ApiResponse[dict])
async def me(user: User = Depends(get_current_user)) -> ApiResponse[dict]:
    return ApiResponse(data=_user_dict(user))


@router.patch("/profile", response_model=ApiResponse[dict])
async def update_profile(
    body: ProfileIn,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Save the user's 'About You' outreach identity (used by the AI to personalise messages)."""
    for field in ("sender_name", "sender_role", "sender_company", "sender_about", "sender_talking_points"):
        val = getattr(body, field)
        if val is not None:
            setattr(user, field, val.strip() or None)
    await db.commit()
    return ApiResponse(message="Profile saved.", data=_user_dict(user))
