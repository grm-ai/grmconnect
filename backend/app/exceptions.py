from __future__ import annotations

from fastapi import Request, status
from fastapi.responses import JSONResponse


# ── Base ──────────────────────────────────────────────────────────────────────

class AppException(Exception):
    status_code: int = status.HTTP_500_INTERNAL_SERVER_ERROR
    message: str = "An unexpected error occurred."

    def __init__(self, message: str | None = None, details: dict | None = None) -> None:
        self.message = message or self.__class__.message
        self.details = details or {}
        super().__init__(self.message)


# ── 400 ───────────────────────────────────────────────────────────────────────

class BadRequestError(AppException):
    status_code = status.HTTP_400_BAD_REQUEST
    message = "Bad request."


class ValidationError(BadRequestError):
    message = "Validation failed."


# ── 401 ───────────────────────────────────────────────────────────────────────

class UnauthorizedError(AppException):
    status_code = status.HTTP_401_UNAUTHORIZED
    message = "Unauthorized – valid API key required."


# ── 403 ───────────────────────────────────────────────────────────────────────

class ForbiddenError(AppException):
    status_code = status.HTTP_403_FORBIDDEN
    message = "Forbidden."


# ── 404 ───────────────────────────────────────────────────────────────────────

class NotFoundError(AppException):
    status_code = status.HTTP_404_NOT_FOUND
    message = "Resource not found."


class LeadNotFoundError(NotFoundError):
    message = "Lead not found."


class CampaignNotFoundError(NotFoundError):
    message = "Campaign not found."


class ActionNotFoundError(NotFoundError):
    message = "Action not found."


class SessionNotFoundError(NotFoundError):
    message = "Session not found."


# ── 409 ───────────────────────────────────────────────────────────────────────

class ConflictError(AppException):
    status_code = status.HTTP_409_CONFLICT
    message = "Resource conflict."


# ── 422 ───────────────────────────────────────────────────────────────────────

class UnprocessableError(AppException):
    status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
    message = "Unprocessable entity."


# ── 429 ───────────────────────────────────────────────────────────────────────

class RateLimitError(AppException):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    message = "Rate limit exceeded."


# ── Browser / session ─────────────────────────────────────────────────────────

class BrowserError(AppException):
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    message = "Browser automation error."


class SessionExpiredError(AppException):
    status_code = status.HTTP_401_UNAUTHORIZED
    message = "Browser session has expired."


# ── Handlers ─────────────────────────────────────────────────────────────────

def _error_response(status_code: int, message: str, details: dict) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"success": False, "message": message, "details": details},
    )


async def app_exception_handler(request: Request, exc: AppException) -> JSONResponse:
    return _error_response(exc.status_code, exc.message, exc.details)


async def generic_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    return _error_response(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        "An unexpected internal error occurred.",
        {"type": type(exc).__name__},
    )
