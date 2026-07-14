"""
LinkedIn session management routes.

Connect flow (recommended — no credentials needed):
  POST /linkedin/open-browser          → opens a visible browser at linkedin.com, returns session_id
  GET  /linkedin/browser-status/{id}   → check if browser is still open + if user logged in
  POST /linkedin/capture/{id}          → capture session from open browser, save, close browser

Manual login flow (fallback):
  POST /linkedin/login                 → headful browser, enter credentials, returns session_id
  POST /linkedin/login/verify          → submit 2FA code

Session management:
  GET  /linkedin/session               → current active session info
  DELETE /linkedin/session             → revoke session

Limits:
  GET  /linkedin/limits                → today's send counts vs limits
  PATCH /linkedin/limits               → update limits at runtime
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, require_auth
from app.security import get_current_user
from app.exceptions import BadRequestError
from app.models import BrowserSession, SessionStatus, User
from app.schemas import ApiResponse
from app.services.session_manager import SessionManager
from app.logger import app_logger

router = APIRouter(prefix="/linkedin", tags=["LinkedIn"])

# Keyed by session_id — holds open Playwright browser contexts
_pending_sessions: dict[str, Any] = {}


# ── Schemas ───────────────────────────────────────────────────────────────────

class ChromeProfileOut(BaseModel):
    dir: str           # e.g. "Profile 6"
    name: str          # e.g. "Wittyadverts"
    email: str


class OpenBrowserRequest(BaseModel):
    profile_dir: str | None = None   # if None, auto-detected from Chrome cookies


class OpenBrowserOut(BaseModel):
    session_id: str
    status: str        # "browser_open"
    message: str

class BrowserStatusOut(BaseModel):
    session_id: str
    open: bool
    logged_in: bool
    linkedin_user: str | None

class CaptureRequest(BaseModel):
    account_name: str = "default"

class CaptureOut(BaseModel):
    account_name: str
    linkedin_user: str | None
    cookies_saved: int

class LimitsOut(BaseModel):
    connect_sent: int
    messages_sent: int
    connect_limit: int
    message_limit: int
    connect_remaining: int
    message_remaining: int
    date: str

class LimitsUpdate(BaseModel):
    daily_connect_limit: int | None = None
    daily_message_limit: int | None = None

class LoginRequest(BaseModel):
    email: str
    password: str
    account_name: str = "default"
    headless: bool = True

class VerifyRequest(BaseModel):
    session_id: str
    code: str

class SessionOut(BaseModel):
    account_name: str
    status: str
    last_used: str | None
    linkedin_name: str | None = None
    linkedin_headline: str | None = None
    linkedin_profile_url: str | None = None
    has_avatar: bool = False


# ── Chrome profile list ───────────────────────────────────────────────────────

@router.get("/chrome-profiles", response_model=ApiResponse[list[ChromeProfileOut]])
async def list_chrome_profiles(
    user: User = Depends(get_current_user),
) -> ApiResponse[list[ChromeProfileOut]]:
    """Return available Chrome profiles on this machine."""
    import json, os
    from pathlib import Path

    user_data = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"
    profiles: list[ChromeProfileOut] = []

    if not user_data.exists():
        return ApiResponse(data=[], message="Chrome not found on this machine.")

    for profile_path in sorted(user_data.iterdir()):
        if not profile_path.is_dir():
            continue
        name_lower = profile_path.name.lower()
        if not (name_lower == "default" or name_lower.startswith("profile")):
            continue
        pref_file = profile_path / "Preferences"
        if not pref_file.exists():
            continue
        try:
            prefs = json.loads(pref_file.read_text(encoding="utf-8", errors="ignore"))
            display_name = prefs.get("profile", {}).get("name", profile_path.name)
            account_info = prefs.get("account_info") or []
            email = account_info[0].get("email", "") if account_info else ""
            profiles.append(ChromeProfileOut(
                dir=profile_path.name,
                name=display_name,
                email=email,
            ))
        except Exception as exc:
            app_logger.debug("chrome-profiles: skip %s — %s", profile_path.name, exc)

    return ApiResponse(data=profiles, message=f"{len(profiles)} Chrome profiles found.")


# ── Helper: find which profile has LinkedIn ───────────────────────────────────

def _find_linkedin_profile(user_data_dir) -> str | None:
    """
    Scan Chrome profiles and return the one that has the most recent LinkedIn
    session (li_at cookie). Reads only SQLite metadata — no decryption needed.
    """
    import sqlite3, shutil, tempfile, os
    from pathlib import Path

    user_data_dir = Path(user_data_dir)
    best_profile: str | None = None
    best_ts: int = 0

    for profile_path in sorted(user_data_dir.iterdir()):
        if not profile_path.is_dir():
            continue
        pname = profile_path.name.lower()
        if not (pname == "default" or pname.startswith("profile")):
            continue

        # Try Network/Cookies first (Chrome 96+), then root Cookies
        for cookie_rel in ("Network/Cookies", "Cookies"):
            cookie_src = profile_path / cookie_rel
            if not cookie_src.exists():
                continue
            try:
                # Copy to temp — avoids locking the live DB
                tmp = tempfile.mktemp(suffix=".db")
                shutil.copy2(str(cookie_src), tmp)
                try:
                    conn = sqlite3.connect(f"file:{tmp}?mode=ro", uri=True)
                    row = conn.execute(
                        "SELECT MAX(creation_utc) FROM cookies "
                        "WHERE host_key LIKE '%.linkedin.com' AND name='li_at'"
                    ).fetchone()
                    conn.close()
                    if row and row[0] and int(row[0]) > best_ts:
                        best_ts = int(row[0])
                        best_profile = profile_path.name
                        app_logger.info(
                            "_find_linkedin_profile: %s has li_at (ts=%d)",
                            profile_path.name, best_ts
                        )
                finally:
                    try:
                        os.unlink(tmp)
                    except Exception:
                        pass
                break  # found cookies file for this profile
            except Exception as exc:
                app_logger.debug("_find_linkedin_profile: skip %s — %s", profile_path.name, exc)

    return best_profile


# ── Open-browser connect flow ─────────────────────────────────────────────────

@router.post("/open-browser", response_model=ApiResponse[OpenBrowserOut])
async def open_browser(
    body: OpenBrowserRequest,
    user: User = Depends(get_current_user),
) -> ApiResponse[OpenBrowserOut]:
    """
    Opens LinkedIn in a persistent LeadPilot browser profile.

    First time  → user sees LinkedIn login, logs in once (email/password or Continue with Google)
    After that  → already logged in, auto-captures and closes in 2 seconds
    """
    import asyncio, os
    from pathlib import Path
    from playwright.async_api import async_playwright

    session_id = str(uuid.uuid4())[:8]

    # Persistent profile dir — survives restarts, keeps LinkedIn session alive
    profile_dir = Path(os.path.expanduser("~")) / ".leadpilot" / "browser_profile"
    profile_dir.mkdir(parents=True, exist_ok=True)
    app_logger.info("open-browser: session=%s profile=%s", session_id, profile_dir)

    pw = await async_playwright().start()

    # Use real Chrome (channel="chrome") so LinkedIn can't detect the browser fingerprint.
    # Falls back to Playwright's Chromium only if Chrome is not installed.
    _persistent_kwargs: dict = {
        "user_data_dir": str(profile_dir),
        "headless": False,
        "slow_mo": 80,
        "args": [
            "--window-size=520,700",
            "--window-position=420,80",
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--disable-infobars",
            "--disable-notifications",
        ],
        "ignore_default_args": ["--enable-automation"],
        "viewport": {"width": 520, "height": 660},
        "user_agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
    }

    context = None
    for ch in ("chrome", None):
        try:
            kw = dict(_persistent_kwargs)
            if ch:
                kw["channel"] = ch
            context = await pw.chromium.launch_persistent_context(**kw)
            app_logger.info("open-browser: using channel=%s", ch or "playwright-chromium")
            break
        except Exception as exc:
            if ch:
                app_logger.warning("open-browser: Chrome channel failed (%s), falling back", exc)
            else:
                raise
    assert context is not None

    # Stealth: hide automation signals
    await context.add_init_script("""
        Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
        Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
        window.chrome = {runtime: {}};
    """)

    # Small banner injected on every page
    await context.add_init_script("""
        document.addEventListener('DOMContentLoaded', () => {
            if (document.getElementById('__lp_banner__')) return;
            const d = document.createElement('div');
            d.id = '__lp_banner__';
            d.style.cssText = `
                position:fixed;top:0;left:0;right:0;z-index:2147483647;
                background:linear-gradient(90deg,#6366f1,#8b5cf6);
                color:#fff;font-family:system-ui,sans-serif;font-size:12px;
                padding:6px 14px;display:flex;align-items:center;gap:6px;
                box-shadow:0 2px 8px rgba(0,0,0,.25);`;
            d.innerHTML = '<span>⚡</span><strong>LeadPilot</strong> — Sign in to LinkedIn to connect';
            document.body.style.paddingTop = '32px';
            document.body.prepend(d);
        });
    """)

    page = context.pages[0] if context.pages else await context.new_page()

    # Navigate to /feed — but if an account chooser appears, guide user to pick one.
    # We intentionally avoid /feed as the first nav target to reduce "already logged in"
    # false positives from the chooser. Go to login first, let LinkedIn redirect if already in.
    await page.goto("https://www.linkedin.com/login?fromSignIn=true&trk=guest_homepage-basic_nav-header-signin",
                    wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_timeout(1500)

    _pending_sessions[session_id] = {
        "pw": pw, "browser": None, "context": context, "page": page,
        "opened_at": datetime.now(timezone.utc), "type": "persistent_local",
        "account_name": "default",
    }

    # Check for account chooser — tell user to pick the right account
    try:
        chooser = await page.locator("h1:has-text('Choose an account'), h2:has-text('Choose an account')").count() > 0
    except Exception:
        chooser = False

    if chooser:
        msg = "Choose your LinkedIn account in the popup, then it saves automatically."
    elif "feed" in page.url or "mynetwork" in page.url:
        msg = "Already logged in! Capturing session…"
    else:
        msg = "Sign in to LinkedIn in the popup — session saves automatically."

    task = asyncio.create_task(_auto_capture_on_login(session_id, context, page))
    _pending_sessions[session_id]["auto_capture_task"] = task

    return ApiResponse(
        message=msg,
        data=OpenBrowserOut(
            session_id=session_id,
            status="browser_open",
            message=msg,
        ),
    )


async def _auto_capture_on_login(session_id: str, context, page) -> None:
    """
    Polls every 2 seconds. When the LinkedIn feed loads (= user is logged in),
    captures the session automatically, saves to DB, and closes the browser.
    """
    import asyncio, os
    from pathlib import Path
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from sqlalchemy import select

    app_logger.info("_auto_capture_on_login: watching session %s", session_id)

    for _ in range(150):   # up to 5 minutes
        await asyncio.sleep(2)

        pending = _pending_sessions.get(session_id)
        if not pending:
            return  # cancelled externally

        try:
            url = page.url
        except Exception:
            return

        # Skip the LinkedIn "Choose an account" picker — not actually logged in yet.
        # LinkedIn shows this at /mynetwork, /feed, etc. when multiple accounts exist.
        try:
            chooser_visible = await page.locator(
                "h1:has-text('Choose an account'), "
                "h2:has-text('Choose an account'), "
                "div[data-test-id='account-picker'], "
                "form[action*='account-picker']"
            ).count() > 0
        except Exception:
            chooser_visible = False

        if chooser_visible:
            app_logger.info("_auto_capture_on_login: account chooser visible — waiting for user to select account")
            continue

        # Only /feed is a reliable "logged in" indicator — /mynetwork can be the chooser
        if any(x in url for x in ("/feed", "/in/me", "/messaging", "/jobs/")):
            app_logger.info("_auto_capture_on_login: login detected on %s", url)

            # Fetch full profile data (name, headline, avatar)
            from app.services.browser import fetch_my_profile_data
            from app.config import get_settings as _get_settings
            _cfg = _get_settings()
            profile_data = await fetch_my_profile_data(page, context, _cfg.session_dir)
            linkedin_user: str | None = profile_data.get("name")
            linkedin_headline: str | None = profile_data.get("headline")
            profile_url_fetched: str | None = profile_data.get("profile_url")

            # Show success overlay in browser
            try:
                await page.evaluate(f"""
                    document.body.innerHTML = `
                      <div style="display:flex;flex-direction:column;align-items:center;
                        justify-content:center;height:100vh;font-family:system-ui,sans-serif;
                        background:linear-gradient(135deg,#667eea,#764ba2);color:white;gap:16px;">
                        <div style="font-size:56px">✅</div>
                        <h2 style="margin:0;font-size:22px">Connected!</h2>
                        <p style="margin:0;opacity:.85;font-size:15px">
                          {linkedin_user or 'LinkedIn'} is now linked to LeadPilot.
                        </p>
                        <p style="margin:0;opacity:.6;font-size:13px">This window will close automatically...</p>
                      </div>`;
                """)
                await asyncio.sleep(2)
            except Exception:
                pass

            # Capture + save session
            try:
                storage_state = await context.storage_state()
                account_name = pending.get("account_name", "default")

                from app.config import settings as s
                session_mgr = SessionManager()
                session_mgr.save_session(account_name, storage_state)

                # Save to DB using a fresh engine
                from app.config import get_settings
                cfg = get_settings()
                engine = create_async_engine(
                    cfg.database_url,
                    connect_args={"check_same_thread": False} if "sqlite" in cfg.database_url else {},
                )
                Sess = async_sessionmaker(engine, expire_on_commit=False)
                async with Sess() as db:
                    res = await db.execute(select(BrowserSession).where(BrowserSession.account_name == account_name))
                    row = res.scalar_one_or_none()
                    if row:
                        row.status = SessionStatus.ACTIVE
                        row.last_used = datetime.now(timezone.utc)
                        row.linkedin_name = linkedin_user or row.linkedin_name
                        row.linkedin_headline = linkedin_headline or row.linkedin_headline
                        row.linkedin_profile_url = profile_url_fetched or row.linkedin_profile_url
                    else:
                        db.add(BrowserSession(
                            account_name=account_name,
                            cookie_file=f"sessions/{account_name}.json",
                            status=SessionStatus.ACTIVE,
                            last_used=datetime.now(timezone.utc),
                            linkedin_name=linkedin_user,
                            linkedin_headline=linkedin_headline,
                            linkedin_profile_url=profile_url_fetched,
                        ))
                    await db.commit()
                await engine.dispose()

                app_logger.info(
                    "_auto_capture_on_login: saved session for %s (user=%s headline=%s cookies=%d)",
                    account_name, linkedin_user, linkedin_headline, len(storage_state.get("cookies", []))
                )

                # Mark as captured so browser-status returns logged_in=True
                if session_id in _pending_sessions:
                    _pending_sessions[session_id]["captured"] = True
                    _pending_sessions[session_id]["linkedin_user"] = linkedin_user

            except Exception as exc:
                app_logger.exception("_auto_capture_on_login: save failed: %s", exc)

            # Close browser (persistent context has no separate browser object)
            try:
                await context.close()
                if pending.get("browser"):
                    await pending["browser"].close()
                await pending["pw"].stop()
            except Exception:
                pass
            _pending_sessions.pop(session_id, None)
            return

    app_logger.warning("_auto_capture_on_login: timeout for session %s", session_id)


@router.get("/browser-status/{session_id}", response_model=ApiResponse[BrowserStatusOut])
async def browser_status(
    session_id: str,
    user: User = Depends(get_current_user),
) -> ApiResponse[BrowserStatusOut]:
    """Poll whether browser is open; if auto-captured, returns logged_in=True."""
    pending = _pending_sessions.get(session_id)

    # Auto-captured by background task
    if not pending:
        # Check if session was recently saved (means auto-capture succeeded)
        session_mgr = SessionManager()
        sessions = session_mgr.list_sessions()
        if "default" in sessions:
            return ApiResponse(data=BrowserStatusOut(
                session_id=session_id, open=False,
                logged_in=True, linkedin_user=None
            ))
        return ApiResponse(data=BrowserStatusOut(
            session_id=session_id, open=False, logged_in=False, linkedin_user=None
        ))

    # Already captured but pending entry still exists
    if pending.get("captured"):
        return ApiResponse(data=BrowserStatusOut(
            session_id=session_id, open=False,
            logged_in=True,
            linkedin_user=pending.get("linkedin_user"),
        ))

    try:
        url = pending["page"].url
        logged_in = any(x in url for x in ("/feed", "/mynetwork", "/in/me"))
        return ApiResponse(data=BrowserStatusOut(
            session_id=session_id, open=True,
            logged_in=logged_in, linkedin_user=None,
        ))
    except Exception:
        return ApiResponse(data=BrowserStatusOut(
            session_id=session_id, open=False, logged_in=False, linkedin_user=None
        ))


@router.post("/capture/{session_id}", response_model=ApiResponse[CaptureOut])
async def capture_session(
    session_id: str,
    body: CaptureRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[CaptureOut]:
    """
    Capture the current browser session from an open browser window.
    Verifies the user is logged in, saves the session, then closes the browser.
    """
    pending = _pending_sessions.get(session_id)
    if not pending:
        raise BadRequestError("Browser session not found or already closed. Click 'Open Browser' again.")

    page    = pending["page"]
    context = pending["context"]
    browser = pending["browser"]
    pw      = pending["pw"]

    try:
        # Check current URL
        current_url = page.url
        app_logger.info("capture: url=%s", current_url)

        if "login" in current_url or "authwall" in current_url or "checkpoint" in current_url:
            raise BadRequestError("You are not logged into LinkedIn yet. Please log in and try again.")

        # Navigate to feed to confirm and trigger final cookie write
        if "feed" not in current_url:
            await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=20000)
            await page.wait_for_timeout(2000)

        if "login" in page.url or "authwall" in page.url:
            raise BadRequestError("LinkedIn is not logged in. Please log in first.")

        # Extract name
        linkedin_user: str | None = None
        for sel in [
            "span.t-16.t-black.t-bold",
            ".feed-identity-module__actor-meta span.t-bold",
            "a[data-control-name='identity_profile_photo'] div",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                name = (await el.inner_text()).strip()
                if name:
                    linkedin_user = name
                    break

        # Capture storage state
        storage_state = await context.storage_state()
        cookie_count  = len(storage_state.get("cookies", []))

        # Save session
        session_mgr = SessionManager()
        session_mgr.save_session(body.account_name, storage_state)

        # Upsert DB record
        res = await db.execute(
            select(BrowserSession).where(BrowserSession.account_name == body.account_name)
        )
        row = res.scalar_one_or_none()
        if row:
            row.status    = SessionStatus.ACTIVE
            row.last_used = datetime.now(timezone.utc)
        else:
            db.add(BrowserSession(
                account_name=body.account_name,
                cookie_file=f"sessions/{body.account_name}.json",
                status=SessionStatus.ACTIVE,
                last_used=datetime.now(timezone.utc),
            ))
        await db.flush()

        app_logger.info(
            "capture: saved session for %s — %d cookies (user=%s)",
            body.account_name, cookie_count, linkedin_user
        )
        return ApiResponse(
            message=f"Session saved! Welcome, {linkedin_user or 'LinkedIn User'}.",
            data=CaptureOut(
                account_name=body.account_name,
                linkedin_user=linkedin_user,
                cookies_saved=cookie_count,
            ),
        )

    except BadRequestError:
        raise
    except Exception as exc:
        app_logger.exception("capture failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    finally:
        # Always close browser and clean up
        try:
            await context.close()
            await browser.close()
            await pw.stop()
        except Exception:
            pass
        _pending_sessions.pop(session_id, None)


@router.delete("/browser/{session_id}", response_model=ApiResponse[None])
async def close_browser(
    session_id: str,
    user: User = Depends(get_current_user),
) -> ApiResponse[None]:
    """Close an open browser without saving."""
    pending = _pending_sessions.pop(session_id, None)
    if pending:
        try:
            await pending["context"].close()
            await pending["browser"].close()
            await pending["pw"].stop()
        except Exception:
            pass
    return ApiResponse(message="Browser closed.")


# ── Lightweight LinkedIn profile via Voyager API (no browser) ────────────────

async def _voyager_profile(cookies: list[dict]) -> tuple[str | None, str | None, str | None]:
    """
    Call /voyager/api/me with the user's own cookies.
    Returns (name, headline, profile_url) or (None, None, None) on failure.

    This is far less suspicious than a headless browser because:
    - It's a single authenticated GET, identical to what the LinkedIn web app does
    - No automation fingerprints (no Playwright, no CDP, no unusual TLS stack)
    """
    import asyncio, random, httpx

    cookie_dict: dict[str, str] = {}
    for c in cookies:
        domain = c.get("domain", "")
        if "linkedin.com" in domain:
            cookie_dict[c["name"]] = c["value"]

    li_at = cookie_dict.get("li_at")
    if not li_at:
        return None, None, None

    jsessionid = cookie_dict.get("JSESSIONID", "").strip('"')
    cookie_header = "; ".join(f"{k}={v}" for k, v in cookie_dict.items())

    # Small human-like pause before the API call
    await asyncio.sleep(random.uniform(0.8, 2.2))

    headers = {
        "accept": "application/vnd.linkedin.normalized+json+2.1",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "csrf-token": jsessionid,
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "user-agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "origin": "https://www.linkedin.com",
        "referer": "https://www.linkedin.com/feed/",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "cookie": cookie_header,
    }

    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=12.0) as client:
            resp = await client.get("https://www.linkedin.com/voyager/api/me", headers=headers)
            if resp.status_code != 200:
                app_logger.debug("_voyager_profile: HTTP %s", resp.status_code)
                return None, None, None

            data = resp.json()

            def _str(val):
                if isinstance(val, dict):
                    return val.get("text", "") or ""
                return str(val) if val else ""

            # Try three known response shapes
            mini = (
                data.get("miniProfile")
                or data.get("data", {}).get("miniProfile")
                or next(
                    (i for i in data.get("included", []) if i.get("firstName") or i.get("lastName")),
                    None,
                )
                or data.get("data")
                or {}
            )

            fn = _str(mini.get("firstName"))
            ln = _str(mini.get("lastName"))
            hl = _str(mini.get("occupation") or mini.get("headline"))
            pub = mini.get("publicIdentifier", "")

            name = f"{fn} {ln}".strip() or None
            headline = hl or None
            url = f"https://www.linkedin.com/in/{pub}" if pub else None

            app_logger.info("_voyager_profile: name=%s headline=%s", name, headline)
            return name, headline, url

    except Exception as exc:
        app_logger.debug("_voyager_profile: %s", exc)
        return None, None, None


# ── Extension: receive session directly ──────────────────────────────────────

class SaveSessionRequest(BaseModel):
    storage_state: dict
    account_name: str = "default"
    # All profile fields come from the extension (runs in the user's own browser, same IP).
    # The backend never calls LinkedIn's API with these cookies — that would cause LinkedIn
    # to flag the session as used from two IPs and force a logout.
    profile_name: str | None = None
    profile_headline: str | None = None
    profile_url: str | None = None


@router.post("/save-session", response_model=ApiResponse[dict])
async def save_session(
    body: SaveSessionRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Called by the LeadPilot Chrome extension.
    Receives a Playwright-compatible storage_state (cookies + localStorage)
    read directly from the user's Chrome profile via chrome.cookies API.
    """
    cookies = body.storage_state.get("cookies", [])
    li_at = next((c for c in cookies if c.get("name") == "li_at"), None)

    if not li_at:
        raise BadRequestError(
            "No li_at cookie found. Make sure you are logged into LinkedIn in this browser."
        )

    # Ensure fields are correct for Playwright's storage_state format
    for cookie in cookies:
        domain = cookie.get("domain", "")
        if domain and not domain.startswith(".") and "linkedin" in domain:
            cookie["domain"] = f".{domain}"
        if not cookie.get("path"):
            cookie["path"] = "/"
        # Preserve sameSite from the extension; fall back to "None" only if missing
        if "sameSite" not in cookie or cookie["sameSite"] not in ("None", "Lax", "Strict"):
            cookie["sameSite"] = "None"
        # sameSite=None requires Secure; ensure consistency
        if cookie.get("sameSite") == "None":
            cookie["secure"] = True

    session_mgr = SessionManager()
    session_mgr.save_session(body.account_name, body.storage_state)

    # Upsert BrowserSession record (scoped to this user — each user has their own LinkedIn)
    res = await db.execute(
        select(BrowserSession).where(
            BrowserSession.account_name == body.account_name, BrowserSession.user_id == user.id
        )
    )
    row = res.scalar_one_or_none()
    if row:
        row.status    = SessionStatus.ACTIVE
        row.last_used = datetime.now(timezone.utc)
    else:
        db.add(BrowserSession(
            user_id=user.id,
            account_name=body.account_name,
            cookie_file=f"sessions/{body.account_name}.json",
            status=SessionStatus.ACTIVE,
            last_used=datetime.now(timezone.utc),
        ))
    await db.flush()

    # ── Profile data — extension only, never server-side ─────────────────────
    # The backend must NOT call LinkedIn's Voyager API with the user's cookies.
    # Doing so makes the same session active from two IPs (user's browser + server),
    # which LinkedIn detects as session hijacking and forces an immediate logout.
    # All profile fields are captured by the extension inside the user's Chrome.
    linkedin_name: str | None     = body.profile_name    or None
    linkedin_headline: str | None = body.profile_headline or None
    profile_url: str | None       = body.profile_url      or None

    # Update record with profile data
    target_row = row
    if target_row is None:
        res2 = await db.execute(
            select(BrowserSession).where(
                BrowserSession.account_name == body.account_name, BrowserSession.user_id == user.id
            )
        )
        target_row = res2.scalar_one_or_none()

    if target_row:
        if linkedin_name:
            target_row.linkedin_name = linkedin_name
        if linkedin_headline:
            target_row.linkedin_headline = linkedin_headline
        if profile_url:
            target_row.linkedin_profile_url = profile_url
    await db.flush()

    app_logger.info(
        "save-session: saved %d cookies for %s (name=%s headline=%s)",
        len(cookies), body.account_name, linkedin_name, linkedin_headline
    )
    return ApiResponse(
        message=f"LinkedIn connected{f' as {linkedin_name}' if linkedin_name else ''}!",
        data={
            "cookies_saved": len(cookies),
            "account_name": body.account_name,
            "linkedin_name": linkedin_name,
            "linkedin_headline": linkedin_headline,
            "profile_url": profile_url,
        },
    )


# ── Limits ────────────────────────────────────────────────────────────────────

@router.get("/limits", response_model=ApiResponse[LimitsOut])
async def get_limits(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[LimitsOut]:
    from app.services.rate_limiter import RateLimiter
    stats = await RateLimiter().get_today_stats(db, user_id=user.id)
    return ApiResponse(data=LimitsOut(**stats))


@router.patch("/limits", response_model=ApiResponse[dict])
async def update_limits(
    body: LimitsUpdate,
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    from app.config import settings as s
    updated: dict = {}
    if body.daily_connect_limit is not None:
        if not (1 <= body.daily_connect_limit <= 200):
            raise BadRequestError("daily_connect_limit must be 1–200")
        object.__setattr__(s, "daily_connect_limit", body.daily_connect_limit)
        updated["daily_connect_limit"] = body.daily_connect_limit
    if body.daily_message_limit is not None:
        if not (1 <= body.daily_message_limit <= 500):
            raise BadRequestError("daily_message_limit must be 1–500")
        object.__setattr__(s, "daily_message_limit", body.daily_message_limit)
        updated["daily_message_limit"] = body.daily_message_limit
    return ApiResponse(message="Limits updated.", data=updated)


# ── Manual login (fallback) ───────────────────────────────────────────────────

@router.post("/login", response_model=ApiResponse[dict])
async def start_login(
    body: LoginRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    from playwright.async_api import async_playwright
    from app.services.browser import LinkedInLoginHandler

    app_logger.info("LinkedIn login attempt for: %s", body.account_name)
    handler = LinkedInLoginHandler()

    try:
        pw      = await async_playwright().start()
        browser = await pw.chromium.launch(headless=body.headless, slow_mo=80)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
        )
        page   = await context.new_page()
        result = await handler.login(page, body.email, body.password)

        if result.get("success"):
            session_mgr = SessionManager()
            session_mgr.save_session(body.account_name, result["storage_state"])
            res = await db.execute(select(BrowserSession).where(BrowserSession.account_name == body.account_name))
            row = res.scalar_one_or_none()
            if row:
                row.status = SessionStatus.ACTIVE
                row.last_used = datetime.now(timezone.utc)
            else:
                db.add(BrowserSession(
                    account_name=body.account_name,
                    cookie_file=f"sessions/{body.account_name}.json",
                    status=SessionStatus.ACTIVE,
                    last_used=datetime.now(timezone.utc),
                ))
            await db.flush()
            await context.close(); await browser.close(); await pw.stop()
            return ApiResponse(message="Login successful.", data={"status": "authenticated"})

        elif result.get("requires_2fa"):
            sid = str(uuid.uuid4())
            _pending_sessions[sid] = {
                "pw": pw, "browser": browser, "context": context, "page": page,
                "account_name": body.account_name,
                "opened_at": datetime.now(timezone.utc),
                "type": "2fa",
            }
            return ApiResponse(
                message="2FA required.",
                data={"requires_2fa": True, "session_id": sid},
            )

        else:
            await context.close(); await browser.close(); await pw.stop()
            raise BadRequestError(result.get("error", "Login failed"))

    except BadRequestError:
        raise
    except Exception as exc:
        app_logger.exception("LinkedIn login error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/login/verify", response_model=ApiResponse[dict])
async def verify_2fa(
    body: VerifyRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    from app.services.browser import LinkedInLoginHandler

    pending = _pending_sessions.get(body.session_id)
    if not pending:
        raise BadRequestError("session_id not found or expired.")

    handler = LinkedInLoginHandler()
    try:
        result = await handler.submit_2fa(pending["page"], body.code)
        if result.get("success"):
            account_name = pending["account_name"]
            session_mgr  = SessionManager()
            session_mgr.save_session(account_name, result["storage_state"])
            res = await db.execute(select(BrowserSession).where(BrowserSession.account_name == account_name))
            row = res.scalar_one_or_none()
            if row:
                row.status = SessionStatus.ACTIVE; row.last_used = datetime.now(timezone.utc)
            else:
                db.add(BrowserSession(
                    account_name=account_name,
                    cookie_file=f"sessions/{account_name}.json",
                    status=SessionStatus.ACTIVE,
                    last_used=datetime.now(timezone.utc),
                ))
            await db.flush()
            _pending_sessions.pop(body.session_id, None)
            return ApiResponse(message="2FA verified. Session saved.", data={"status": "authenticated"})
        else:
            raise BadRequestError(result.get("error", "2FA failed"))
    except BadRequestError:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if body.session_id in _pending_sessions:
            try:
                p = _pending_sessions.pop(body.session_id)
                await p["context"].close(); await p["browser"].close(); await p["pw"].stop()
            except Exception:
                pass


# ── Session info ──────────────────────────────────────────────────────────────

@router.get("/session", response_model=ApiResponse[SessionOut | None])
async def get_session(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[SessionOut | None]:
    res = await db.execute(
        select(BrowserSession)
        .where(BrowserSession.user_id == user.id, BrowserSession.status.in_([SessionStatus.ACTIVE, SessionStatus.EXPIRED]))
        .order_by(BrowserSession.last_used.desc())
        .limit(1)
    )
    row = res.scalar_one_or_none()
    if not row:
        return ApiResponse(data=None, message="No active session.")

    from pathlib import Path
    from app.config import get_settings as _gs2
    _cfg2 = _gs2()
    avatar_exists = (Path(_cfg2.session_dir) / "default_avatar.jpg").exists()

    return ApiResponse(data=SessionOut(
        account_name=row.account_name,
        status=row.status.value,
        last_used=row.last_used.isoformat() if row.last_used else None,
        linkedin_name=row.linkedin_name,
        linkedin_headline=row.linkedin_headline,
        linkedin_profile_url=row.linkedin_profile_url,
        has_avatar=avatar_exists,
    ))


@router.post("/profile/refresh", response_model=ApiResponse[SessionOut])
async def refresh_profile(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[SessionOut]:
    """
    Return the cached LinkedIn profile data stored in the DB.

    This endpoint intentionally does NOT call LinkedIn's Voyager API.
    Making server-side requests with the user's cookies causes LinkedIn to
    detect the same session active from two IP addresses simultaneously and
    forces an immediate logout — the exact bug this avoids.

    Profile data (name, headline, URL) is captured by the Chrome extension
    directly inside the user's browser and stored on save-session.
    """
    res = await db.execute(
        select(BrowserSession)
        .where(BrowserSession.user_id == user.id, BrowserSession.status.in_(["ACTIVE", "EXPIRED"]))
        .order_by(BrowserSession.last_used.desc())
        .limit(1)
    )
    row = res.scalar_one_or_none()
    if not row:
        raise BadRequestError("No LinkedIn session found. Please connect via Settings → LinkedIn.")

    row.last_used = datetime.now(timezone.utc)
    await db.flush()

    from pathlib import Path
    from app.config import get_settings as _get_cfg
    _session_dir = _get_cfg().session_dir
    avatar_exists = (Path(_session_dir) / "default_avatar.jpg").exists()

    name = row.linkedin_name
    return ApiResponse(
        message=f"Session active{f' — {name}' if name else ''}.",
        data=SessionOut(
            account_name=row.account_name,
            status=row.status.value,
            last_used=row.last_used.isoformat() if row.last_used else None,
            linkedin_name=name,
            linkedin_headline=row.linkedin_headline,
            linkedin_profile_url=row.linkedin_profile_url,
            has_avatar=avatar_exists,
        ),
    )


@router.get("/avatar")
async def get_avatar() -> object:
    """
    Returns the saved LinkedIn profile avatar image.
    No auth required — it's just a local photo, not sensitive.
    """
    from fastapi.responses import FileResponse, Response
    from pathlib import Path
    from app.config import get_settings as _gs3
    _cfg3 = _gs3()
    avatar_path = Path(_cfg3.session_dir) / "default_avatar.jpg"
    if not avatar_path.exists():
        return Response(status_code=404)
    return FileResponse(str(avatar_path), media_type="image/jpeg")


@router.delete("/session", response_model=ApiResponse[None])
async def revoke_session(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[None]:
    res  = await db.execute(select(BrowserSession).where(
        BrowserSession.status.in_([SessionStatus.ACTIVE, SessionStatus.EXPIRED])
    ))
    rows = res.scalars().all()
    mgr  = SessionManager()
    for row in rows:
        mgr.delete_session(row.account_name)
        row.status = SessionStatus.INVALID
    return ApiResponse(message=f"Revoked {len(rows)} session(s).")
