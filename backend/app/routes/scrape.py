"""
Profile scraping routes.

POST /scrape/start     → start async scrape job, returns job_id immediately
GET  /scrape/status/{job_id} → poll job progress + partial results
POST /scrape/preview   → (sync, legacy) scrape and return results
POST /scrape/import    → bulk-import scraped profiles as leads
GET  /scrape/jobs      → list recent completed scrape jobs
"""
from __future__ import annotations

import asyncio
import random
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, require_auth
from app.security import get_current_user
from app.exceptions import BadRequestError
from app.models import BrowserSession, Lead, LeadStatus, ConnectionStatus, User
from app.schemas import ApiResponse
from app.logger import app_logger

router = APIRouter(prefix="/scrape", tags=["Scrape"])

# ── Extension-update schema ───────────────────────────────────────────────────

class ExtensionUpdate(BaseModel):
    job_id: str
    status: str | None = None
    progress_profiles: int | None = None
    progress_pages: int | None = None
    new_profiles: list[dict] | None = None
    error: str | None = None
    finished: bool = False

# In-memory stores
_scrape_log: list[dict] = []          # completed jobs summary (last 20)
_scrape_jobs: dict[str, dict] = {}    # live job state keyed by job_id


# ── Schemas ───────────────────────────────────────────────────────────────────

def _validate_linkedin_url(v: str) -> str:
    v = v.strip()
    allowed = (
        "linkedin.com/search/results/people",
        "linkedin.com/sales/search/people",
        "linkedin.com/sales/search/",
        "linkedin.com/recruiter/",
    )
    if not any(p in v for p in allowed):
        raise ValueError(
            "URL must be a LinkedIn people search URL "
            "(linkedin.com/search/results/people or linkedin.com/sales/search/people)"
        )
    return v


class ScrapeRequest(BaseModel):
    url: str
    max_profiles: int = 100
    campaign_id: int | None = None

    @field_validator("url")
    @classmethod
    def validate_linkedin_url(cls, v: str) -> str:
        return _validate_linkedin_url(v)


class StartScrapeRequest(BaseModel):
    url: str
    max_profiles: int = 100
    campaign_id: int | None = None

    @field_validator("url")
    @classmethod
    def validate_linkedin_url(cls, v: str) -> str:
        return _validate_linkedin_url(v)


class ScrapedProfile(BaseModel):
    name: str
    title: str
    company: str
    location: str
    linkedin_url: str
    profile_id: str
    connection_degree: str
    source: str
    # Enhanced fields
    mutual_connections: str = ""
    is_open_to_work: bool = False
    is_premium: bool = False
    company_size: str = ""
    industry: str = ""
    seniority: str = ""


class ScrapeResult(BaseModel):
    job_id: str
    url: str
    profiles_found: int
    pages_scraped: int
    profiles: list[ScrapedProfile]
    scraped_at: str
    error: str | None = None


class AsyncJobStatus(BaseModel):
    job_id: str
    status: Literal["pending", "running", "done", "error"]
    progress_profiles: int
    progress_pages: int
    profiles: list[ScrapedProfile]
    error: str | None = None
    url: str
    max_profiles: int
    started_at: str
    finished_at: str | None = None


class ImportRequest(BaseModel):
    profiles: list[ScrapedProfile]
    campaign_id: int | None = None
    skip_existing: bool = True


class ImportResult(BaseModel):
    imported: int
    updated: int
    skipped: int
    lead_ids: list[int]


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_session_storage(db: AsyncSession, user_id: int) -> dict | None:
    from app.services.session_manager import SessionManager
    result = await db.execute(
        select(BrowserSession)
        .where(BrowserSession.status == "ACTIVE", BrowserSession.user_id == user_id)
        .order_by(BrowserSession.last_used.desc())
        .limit(1)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return SessionManager().load_session(row.account_name)


async def _open_scrape_context(pw, storage_state: dict | None):
    """
    Open a FULLY HIDDEN browser for scraping — no window ever appears to the user.

    Approach:
    - Real Chrome binary (channel="chrome") — identical fingerprint to the user's browser
    - Persistent profile at ~/.leadpilot/browser_profile — same profile as login session
    - LinkedIn cookies from extension/popup injected for immediate authentication
    - Comprehensive stealth scripts to pass LinkedIn's bot detection
    - Falls back to Playwright's Chromium only if Chrome is not installed
    """
    from pathlib import Path
    from app.services.browser import _CHROME_ARGS, _STEALTH_SCRIPT, _USER_AGENT

    profile_dir = Path.home() / ".leadpilot" / "browser_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    base_kwargs: dict[str, Any] = {
        "user_data_dir": str(profile_dir),
        "headless": True,          # Completely hidden — no window shown to user
        "slow_mo": 60,
        "args": _CHROME_ARGS,
        "ignore_default_args": ["--enable-automation"],
        "viewport": {"width": 1280, "height": 800},
        "user_agent": _USER_AGENT,
        "locale": "en-US",
        "timezone_id": "Asia/Kolkata",
    }

    ctx = None
    for channel in ("chrome", None):
        try:
            kw = dict(base_kwargs)
            if channel:
                kw["channel"] = channel
            ctx = await pw.chromium.launch_persistent_context(**kw)
            app_logger.info("scrape context: channel=%s headless=True", channel or "chromium")
            break
        except Exception as exc:
            if channel:
                app_logger.warning("scrape context: channel=%s failed (%s), trying chromium", channel, exc)
            else:
                raise

    # Apply full stealth before any navigation
    await ctx.add_init_script(_STEALTH_SCRIPT)

    # Inject LinkedIn session cookies (from extension or popup login)
    if storage_state:
        li_cookies = [
            c for c in storage_state.get("cookies", [])
            if "linkedin.com" in c.get("domain", "")
        ]
        if li_cookies:
            try:
                await ctx.add_cookies(li_cookies)
                app_logger.info("scrape context: injected %d LinkedIn cookies", len(li_cookies))
            except Exception as exc:
                app_logger.warning("scrape context: cookie inject failed: %s", exc)

    return ctx


async def _run_scrape(url: str, max_profiles: int, storage_state: dict | None) -> dict:
    from playwright.async_api import async_playwright
    from app.services.browser import ProfileScraperHandler

    scraper = ProfileScraperHandler()
    async with async_playwright() as pw:
        context = await _open_scrape_context(pw, storage_state)
        page = await context.new_page()
        try:
            result = await scraper.scrape(page, url, max_profiles=max_profiles)
        finally:
            await context.close()
    return result


async def _run_scrape_with_progress(
    url: str,
    max_profiles: int,
    storage_state: dict | None,
    progress_callback,
) -> dict:
    from playwright.async_api import async_playwright
    from app.services.browser import ProfileScraperHandler

    scraper = ProfileScraperHandler()
    async with async_playwright() as pw:
        context = await _open_scrape_context(pw, storage_state)
        page = await context.new_page()
        try:
            result = await scraper.scrape(
                page, url,
                max_profiles=max_profiles,
                progress_callback=progress_callback,
            )
        finally:
            await context.close()
    return result


async def _run_scrape_job(job_id: str, url: str, max_profiles: int, storage_state: dict | None):
    """Background task: runs the scraper and updates _scrape_jobs[job_id] in real-time."""
    _scrape_jobs[job_id]["status"] = "running"

    def progress_cb(profiles_found: int, pages_scraped: int, new_profiles: list[dict]):
        job = _scrape_jobs.get(job_id)
        if not job:
            return
        # Append new partial results
        existing = {p["linkedin_url"] for p in job["profiles"]}
        for p in new_profiles:
            if p.get("linkedin_url") and p["linkedin_url"] not in existing:
                job["profiles"].append(p)
                existing.add(p["linkedin_url"])
        job["progress_profiles"] = profiles_found
        job["progress_pages"] = pages_scraped

    try:
        result = await _run_scrape_with_progress(url, max_profiles, storage_state, progress_cb)

        if result.get("success"):
            # Deduplicate final profile list
            seen: set[str] = set()
            final: list[dict] = []
            for p in result.get("profiles", []):
                url_key = p.get("linkedin_url", "")
                if url_key and url_key not in seen:
                    seen.add(url_key)
                    final.append(p)

            _scrape_jobs[job_id].update({
                "status": "done",
                "profiles": final,
                "progress_profiles": len(final),
                "progress_pages": result.get("pages_scraped", 0),
                "finished_at": datetime.now(timezone.utc).isoformat(),
            })

            # Add to summary log
            _scrape_log.insert(0, {
                "job_id": job_id,
                "user_id": _scrape_jobs[job_id].get("user_id"),
                "url": url,
                "profiles_found": len(final),
                "pages_scraped": result.get("pages_scraped", 0),
                "scraped_at": _scrape_jobs[job_id]["finished_at"],
            })
            if len(_scrape_log) > 20:
                _scrape_log.pop()
        else:
            _scrape_jobs[job_id].update({
                "status": "error",
                "error": result.get("error", "Scrape failed"),
                "finished_at": datetime.now(timezone.utc).isoformat(),
            })
    except Exception as exc:
        app_logger.exception("Async scrape job %s failed: %s", job_id, exc)
        _scrape_jobs[job_id].update({
            "status": "error",
            "error": str(exc),
            "finished_at": datetime.now(timezone.utc).isoformat(),
        })


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/start", response_model=ApiResponse[dict])
async def start_scrape_job(
    body: StartScrapeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Start an async scrape job. Returns job_id immediately.
    Poll GET /scrape/status/{job_id} for live progress and partial results.
    """
    job_id  = str(uuid.uuid4())[:8]
    started = datetime.now(timezone.utc).isoformat()

    _scrape_jobs[job_id] = {
        "job_id": job_id,
        "user_id": user.id,           # owner — other users can't read this job
        "status": "pending",
        "source": "extension",        # Processed by the Chrome extension, not a backend browser
        "progress_profiles": 0,
        "progress_pages": 0,
        "profiles": [],
        "error": None,
        "url": body.url,
        "max_profiles": body.max_profiles,
        "started_at": started,
        "finished_at": None,
    }

    app_logger.info("Extension scrape job %s queued: %s (max %d)", job_id, body.url, body.max_profiles)

    return ApiResponse(
        message=f"Job {job_id} queued — extension will process it in your Chrome.",
        data={"job_id": job_id, "status": "pending", "started_at": started},
    )


@router.get("/status/{job_id}", response_model=ApiResponse[AsyncJobStatus])
async def get_scrape_job_status(
    job_id: str,
    user: User = Depends(get_current_user),
) -> ApiResponse[AsyncJobStatus]:
    """Poll an async scrape job for current progress and partial profile list."""
    job = _scrape_jobs.get(job_id)
    if not job or job.get("user_id") not in (None, user.id):
        raise HTTPException(status_code=404, detail=f"Scrape job '{job_id}' not found.")

    # Safely convert raw dicts to ScrapedProfile (partial data may lack some fields)
    profiles: list[ScrapedProfile] = []
    for p in job["profiles"]:
        try:
            profiles.append(ScrapedProfile(**p) if isinstance(p, dict) else p)
        except Exception:
            pass

    status_obj = AsyncJobStatus(
        job_id=job_id,
        status=job["status"],
        progress_profiles=job["progress_profiles"],
        progress_pages=job["progress_pages"],
        profiles=profiles[: job["max_profiles"]],
        error=job.get("error"),
        url=job["url"],
        max_profiles=job["max_profiles"],
        started_at=job["started_at"],
        finished_at=job.get("finished_at"),
    )

    msg = {
        "pending": "Job queued, browser starting...",
        "running": f"Scraping... {job['progress_profiles']} profiles on {job['progress_pages']} page(s)",
        "done": f"Done! {job['progress_profiles']} profiles across {job['progress_pages']} page(s)",
        "error": f"Error: {job.get('error', 'unknown')}",
    }.get(job["status"], job["status"])

    return ApiResponse(message=msg, data=status_obj)


@router.post("/preview", response_model=ApiResponse[ScrapeResult])
async def preview_scrape(
    body: ScrapeRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[ScrapeResult]:
    """
    Sync scrape — waits for completion and returns the full result.
    For large scrapes prefer POST /scrape/start + polling /scrape/status/{id}.
    """
    storage_state = await _get_session_storage(db, user.id)
    if not storage_state:
        raise BadRequestError("No active LinkedIn session. Log in via Settings → LinkedIn first.")

    job_id = str(uuid.uuid4())[:8]
    app_logger.info("Sync scrape job %s started: %s", job_id, body.url)

    try:
        raw = await _run_scrape(body.url, body.max_profiles, storage_state)
    except Exception as exc:
        app_logger.exception("Sync scrape job %s failed: %s", job_id, exc)
        raise HTTPException(status_code=500, detail=str(exc))

    if not raw.get("success"):
        raise BadRequestError(raw.get("error", "Scrape failed"))

    profiles = [ScrapedProfile(**p) for p in raw.get("profiles", [])]
    result = ScrapeResult(
        job_id=job_id,
        url=body.url,
        profiles_found=len(profiles),
        pages_scraped=raw.get("pages_scraped", 0),
        profiles=profiles,
        scraped_at=datetime.now(timezone.utc).isoformat(),
    )

    _scrape_log.insert(0, {**result.model_dump(), "user_id": user.id})
    if len(_scrape_log) > 20:
        _scrape_log.pop()

    app_logger.info("Sync scrape job %s complete: %d profiles", job_id, len(profiles))
    return ApiResponse(
        message=f"Found {len(profiles)} profiles across {raw.get('pages_scraped', 0)} page(s).",
        data=result,
    )


@router.post("/import", response_model=ApiResponse[ImportResult])
async def import_profiles(
    body: ImportRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[ImportResult]:
    """Bulk-import scraped profiles as Leads. Upserts existing leads with fresh data.
    A Sales Navigator url (/sales/lead/<id>) is normalised to a normal LinkedIn /in/<id> url so the
    send model (which uses linkedin.com) can use it — the /in/<id> form resolves to the same person."""
    import re
    imported = 0
    updated  = 0
    skipped  = 0
    lead_ids: list[int] = []

    def _norm(u: str | None) -> str | None:
        if not u:
            return u
        m = re.search(r"/sales/lead/([A-Za-z0-9_-]+)", u)
        return f"https://www.linkedin.com/in/{m.group(1)}" if m else u

    for profile in body.profiles:
        url = _norm(profile.linkedin_url)
        if not url or not profile.name:
            skipped += 1
            continue

        existing_result = await db.execute(
            select(Lead).where(Lead.linkedin_url == url, Lead.user_id == user.id).limit(1)
        )
        existing = existing_result.scalar_one_or_none()

        if existing:
            # Upsert: refresh name/title/company/location with latest scraped data
            existing.name     = profile.name or existing.name
            existing.title    = profile.title or existing.title
            existing.company  = profile.company or existing.company
            existing.location = profile.location or existing.location
            lead_ids.append(existing.id)
            updated += 1
        else:
            lead = Lead(
                user_id=user.id,
                name=profile.name,
                title=profile.title or None,
                company=profile.company or None,
                location=profile.location or None,
                linkedin_url=url,
                status=LeadStatus.PENDING,
                connection_status=ConnectionStatus.NOT_SENT,
            )
            db.add(lead)
            await db.flush()
            await db.refresh(lead)
            lead_ids.append(lead.id)
            imported += 1

    app_logger.info("Import complete: %d imported, %d updated, %d skipped", imported, updated, skipped)

    parts = []
    if imported: parts.append(f"{imported} new lead{'s' if imported != 1 else ''} added")
    if updated:  parts.append(f"{updated} existing lead{'s' if updated != 1 else ''} refreshed")
    if skipped:  parts.append(f"{skipped} skipped (missing URL or name)")
    message = (", ".join(parts) + ".") if parts else "Nothing to import."

    return ApiResponse(
        message=message,
        data=ImportResult(imported=imported, updated=updated, skipped=skipped, lead_ids=lead_ids),
    )


@router.get("/jobs", response_model=ApiResponse[list[dict]])
async def list_scrape_jobs(
    user: User = Depends(get_current_user),
) -> ApiResponse[list[dict]]:
    """Return the current user's last 20 scrape job summaries."""
    summary = [
        {
            "job_id": j["job_id"],
            "url": j["url"][:80] + "..." if len(j["url"]) > 80 else j["url"],
            "profiles_found": j["profiles_found"],
            "pages_scraped": j.get("pages_scraped", 0),
            "scraped_at": j["scraped_at"],
        }
        for j in _scrape_log
        if j.get("user_id") == user.id
    ]
    return ApiResponse(data=summary, message=f"{len(summary)} recent scrape jobs")


# ── Connect-from-search jobs ──────────────────────────────────────────────────

_connect_jobs: dict[str, dict] = {}


class ConnectRequest(BaseModel):
    profiles: list[ScrapedProfile]
    limit: int = 10
    note_context: str = ""


class ConnectJobResult(BaseModel):
    name: str
    linkedin_url: str
    note: str
    success: bool
    error: str | None = None
    already_connected: bool = False
    already_pending:   bool = False


class ConnectJobStatusModel(BaseModel):
    job_id: str
    status: Literal["pending", "running", "done", "error"]
    total: int
    sent: int
    failed: int
    results: list[ConnectJobResult]
    error: str | None = None
    started_at: str
    finished_at: str | None = None


async def _run_connect_job(
    job_id: str,
    profiles: list[ScrapedProfile],
    note_context: str,
    storage_state: dict,
) -> None:
    from pathlib import Path
    from playwright.async_api import async_playwright
    from app.services.browser import ConnectHandler, _CHROME_ARGS, _STEALTH_SCRIPT, _USER_AGENT
    from app.services.ai_generator import AIGenerator

    job = _connect_jobs[job_id]
    job["status"] = "running"
    ai = AIGenerator()

    profile_dir = Path.home() / ".leadpilot" / "browser_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)

    try:
        async with async_playwright() as pw:
            browser_ctx = None
            for channel in ("chrome", None):
                try:
                    kw = dict(
                        user_data_dir=str(profile_dir),
                        headless=True,
                        slow_mo=60,
                        args=_CHROME_ARGS,
                        ignore_default_args=["--enable-automation"],
                        viewport={"width": 1280, "height": 800},
                        user_agent=_USER_AGENT,
                        locale="en-US",
                        timezone_id="Asia/Kolkata",
                    )
                    if channel:
                        kw["channel"] = channel
                    browser_ctx = await pw.chromium.launch_persistent_context(**kw)
                    await browser_ctx.add_init_script(_STEALTH_SCRIPT)
                    break
                except Exception as exc:
                    if channel:
                        app_logger.warning("connect_job: channel=%s failed (%s)", channel, exc)
                    else:
                        raise
            if storage_state and browser_ctx:
                li_cookies = [c for c in storage_state.get("cookies", []) if "linkedin.com" in c.get("domain", "")]
                if li_cookies:
                    try:
                        await browser_ctx.add_cookies(li_cookies)
                    except Exception:
                        pass
            page = await browser_ctx.new_page()
            handler = ConnectHandler()

            try:
                for profile in profiles:
                    first_name = profile.name.split()[0] if profile.name else "there"

                    try:
                        note = await ai.generate_connect_note(
                            lead_name=profile.name,
                            lead_company=profile.company or None,
                            context=note_context,
                        )
                    except Exception:
                        note = f"Hi {first_name}, I came across your profile and would love to connect!"

                    try:
                        result = await handler.execute(page, {"note": note}, profile.linkedin_url)
                    except Exception as exc:
                        result = {"success": False, "error": str(exc)}

                    success = result.get("success", False)
                    already_connected = result.get("already_connected", False)
                    already_pending   = result.get("already_pending", False)

                    # "already connected" counts as sent (not a failure)
                    effective_success = success or already_connected or already_pending
                    error_msg = None if effective_success else result.get("error")
                    display_note = note if success else ""

                    job["results"].append({
                        "name":              profile.name,
                        "linkedin_url":      profile.linkedin_url,
                        "note":              display_note,
                        "success":           effective_success,
                        "error":             error_msg,
                        "already_connected": already_connected,
                        "already_pending":   already_pending,
                    })
                    if effective_success:
                        job["sent"] += 1
                    else:
                        job["failed"] += 1

                    app_logger.info(
                        "connect_job %s | %s → %s",
                        job_id, profile.name,
                        "sent" if result.get("success") else result.get("error", "fail"),
                    )

                    # Human-like delay between invites
                    await asyncio.sleep(random.uniform(5, 15))

            finally:
                await browser_ctx.close()  # persistent context — no separate browser.close()

    except Exception as exc:
        app_logger.exception("connect_job %s failed: %s", job_id, exc)
        job["status"] = "error"
        job["error"] = str(exc)

    if job["status"] != "error":
        job["status"] = "done"
    job["finished_at"] = datetime.now(timezone.utc).isoformat()
    app_logger.info(
        "connect_job %s done: sent=%d failed=%d", job_id, job["sent"], job["failed"]
    )


@router.post("/connect", response_model=ApiResponse[dict])
async def start_connect_job(
    body: ConnectRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Start an async job that sends AI-personalized connection requests to the given profiles.
    Returns job_id immediately — poll GET /scrape/connect-status/{job_id} for live progress.
    """
    storage_state = await _get_session_storage(db, user.id)
    if not storage_state:
        raise BadRequestError("No active LinkedIn session. Log in via Settings → LinkedIn first.")

    profiles_to_connect = body.profiles[: body.limit]
    job_id = str(uuid.uuid4())[:8]
    started = datetime.now(timezone.utc).isoformat()

    _connect_jobs[job_id] = {
        "job_id": job_id,
        "user_id": user.id,
        "status": "pending",
        "total": len(profiles_to_connect),
        "sent": 0,
        "failed": 0,
        "results": [],
        "error": None,
        "started_at": started,
        "finished_at": None,
    }

    asyncio.create_task(
        _run_connect_job(job_id, profiles_to_connect, body.note_context, storage_state)
    )

    app_logger.info("connect_job %s queued: %d profiles", job_id, len(profiles_to_connect))
    return ApiResponse(
        message=f"Connection job started — sending {len(profiles_to_connect)} AI-personalized invites.",
        data={
            "job_id": job_id,
            "status": "pending",
            "started_at": started,
            "total": len(profiles_to_connect),
        },
    )


@router.get("/connect-status/{job_id}", response_model=ApiResponse[ConnectJobStatusModel])
async def get_connect_job_status(
    job_id: str,
    user: User = Depends(get_current_user),
) -> ApiResponse[ConnectJobStatusModel]:
    """Poll an active connection job for live progress and per-profile results."""
    job = _connect_jobs.get(job_id)
    if not job or job.get("user_id") not in (None, user.id):
        raise HTTPException(status_code=404, detail=f"Connect job '{job_id}' not found.")
    status_obj = ConnectJobStatusModel(
        job_id=job_id,
        status=job["status"],
        total=job["total"],
        sent=job["sent"],
        failed=job["failed"],
        results=[ConnectJobResult(**r) for r in job["results"]],
        error=job.get("error"),
        started_at=job["started_at"],
        finished_at=job.get("finished_at"),
    )

    msg = {
        "pending": "Job queued, opening browser...",
        "running": f"Sending... {job['sent']} sent, {job['failed']} failed of {job['total']}",
        "done": f"Done! {job['sent']} invites sent, {job['failed']} failed",
        "error": f"Error: {job.get('error', 'unknown')}",
    }.get(job["status"], job["status"])

    return ApiResponse(message=msg, data=status_obj)


# ── Extension-driven scraping endpoints ───────────────────────────────────────

@router.get("/next-job")
async def get_next_job() -> ApiResponse[dict | None]:
    """
    Called by the LeadPilot Chrome extension every 4 seconds.
    Returns the next pending job so the extension can process it in the user's real Chrome.
    No auth required — extension can't easily set headers in service worker fetch.
    """
    for job_id, job in _scrape_jobs.items():
        if job.get("status") == "pending" and job.get("source") == "extension":
            return ApiResponse(
                message="Job ready",
                data={
                    "job_id": job_id,
                    "url": job["url"],
                    "max_profiles": job["max_profiles"],
                },
            )
    return ApiResponse(message="No pending jobs", data=None)


@router.post("/extension-update")
async def extension_update(body: ExtensionUpdate) -> ApiResponse[dict]:
    """
    Called by the extension to report live progress and final results.
    No auth required — same reason as /next-job.
    """
    job = _scrape_jobs.get(body.job_id)
    if not job:
        return ApiResponse(message="Job not found", data={})

    if body.status:
        job["status"] = body.status
    if body.progress_profiles is not None:
        job["progress_profiles"] = body.progress_profiles
    if body.progress_pages is not None:
        job["progress_pages"] = body.progress_pages
    if body.error is not None:
        job["error"] = body.error

    # Merge new profiles (deduplicate)
    if body.new_profiles:
        seen = {p["linkedin_url"] for p in job["profiles"]}
        for p in body.new_profiles:
            url = p.get("linkedin_url", "")
            if url and url not in seen:
                job["profiles"].append(p)
                seen.add(url)
        job["progress_profiles"] = len(job["profiles"])

    if body.finished:
        job["finished_at"] = datetime.now(timezone.utc).isoformat()
        if job["status"] not in ("error",):
            job["status"] = "done"
        # Add to completed log
        _scrape_log.insert(0, {
            "job_id": body.job_id,
            "user_id": job.get("user_id"),
            "url": job["url"],
            "profiles_found": len(job["profiles"]),
            "pages_scraped": job.get("progress_pages", 0),
            "scraped_at": job["finished_at"],
        })
        if len(_scrape_log) > 20:
            _scrape_log.pop()
        app_logger.info(
            "Extension job %s finished: %d profiles across %d pages",
            body.job_id, len(job["profiles"]), job.get("progress_pages", 0)
        )

    return ApiResponse(message="Updated", data={"job_id": body.job_id})
