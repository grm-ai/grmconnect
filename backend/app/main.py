from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.exceptions import AppException, app_exception_handler, generic_exception_handler
from app.logger import app_logger
from app.routes import health, leads, campaigns, actions, runner, webhook
from app.routes import linkedin, inbox, scrape, analytics, ai, settings_route, meetings, auth_route
from app.scheduler import start_scheduler, stop_scheduler


@asynccontextmanager
async def lifespan(app: FastAPI):
    app_logger.info("Starting %s v%s", settings.app_name, settings.app_version)
    start_scheduler()
    yield
    stop_scheduler()
    app_logger.info("Shutdown complete")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
    lifespan=lifespan,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Allow: configured origins + all Chrome extension origins (chrome-extension://*)

_origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    # allow any Chrome extension + any Vercel deployment + the grmconnect.com domain
    allow_origin_regex=r"chrome-extension://.*|https://[a-z0-9-]+\.vercel\.app|https://(www\.)?grmconnect\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Exception handlers ────────────────────────────────────────────────────────

app.add_exception_handler(AppException, app_exception_handler)
app.add_exception_handler(Exception, generic_exception_handler)

# ── Routers ───────────────────────────────────────────────────────────────────

app.include_router(health.router)
app.include_router(leads.router)
app.include_router(campaigns.router)
app.include_router(actions.router)
app.include_router(runner.router)
app.include_router(webhook.router)
app.include_router(linkedin.router)
app.include_router(inbox.router)
app.include_router(scrape.router)
app.include_router(analytics.router)
app.include_router(ai.router)
app.include_router(settings_route.router)
app.include_router(meetings.router)
app.include_router(auth_route.router)

# ── Request logging middleware ────────────────────────────────────────────────

@app.middleware("http")
async def log_requests(request: Request, call_next):
    app_logger.info("-> %s %s", request.method, request.url.path)
    response = await call_next(request)
    app_logger.info("<- %s %s %s", request.method, request.url.path, response.status_code)
    return response
