from __future__ import annotations

import asyncio
import random
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.dependencies import get_db, require_auth
from app.security import get_current_user
from app.exceptions import BadRequestError, LeadNotFoundError
from app.models import Action, ActionStatus, ActionType, BrowserSession, ConnectionStatus, Lead, SessionStatus, User
from app.schemas import ApiResponse, LeadCreate, LeadOut, LeadUpdate, PaginatedResponse
from app.logger import app_logger

router = APIRouter(prefix="/leads", tags=["Leads"])

# In-memory store for single-lead connect jobs
_lead_connect_jobs: dict[str, dict] = {}


async def _voyager_send_invite(
    linkedin_url: str,
    note: str,
    storage_state: dict,
) -> dict:
    """
    Send a LinkedIn connection request via the Voyager REST API.
    No browser, no headless Chrome, no bot detection, no session invalidation.

    Returns: {"success": True} | {"success": False, "error": str, "session_expired": bool}
    """
    import httpx, base64, os, re, json as _json

    _UA = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )

    cookies_list = storage_state.get("cookies", [])
    cookie_dict: dict[str, str] = {
        c["name"]: c["value"]
        for c in cookies_list
        if "linkedin.com" in c.get("domain", "")
    }
    li_at = cookie_dict.get("li_at")
    if not li_at:
        return {"success": False, "error": "No li_at cookie — save session via Settings → LinkedIn", "session_expired": True}

    # ── PhantomBuster pre-flight: refresh JSESSIONID + activate SN session ────
    # Step 1: GET /feed/ → fresh JSESSIONID (CSRF token rotates; stale = 301)
    # Step 2: GET /sales/search/people → activates SN session context so that
    #         SN Voyager API endpoints (/salesApiProfiles/) accept our cookies.
    #         Without this, SN APIs return 403 even with a valid li_at.
    is_sn_url = bool(re.search(r"/sales/lead/", linkedin_url))

    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as _pre:
        def _nav_headers(referer: str = "https://www.linkedin.com/") -> dict:
            return {
                "user-agent": _UA,
                "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "accept-language": "en-US,en;q=0.9",
                "sec-fetch-dest": "document",
                "sec-fetch-mode": "navigate",
                "sec-fetch-site": "same-origin",
                "upgrade-insecure-requests": "1",
                "referer": referer,
            }

        def _update_cookies(resp) -> None:
            for _n, _v in _pre.cookies.items():
                cookie_dict[_n] = _v
            raw_sc = getattr(resp.headers, "get_list", None)
            for _sc in (raw_sc("set-cookie") if raw_sc else []):
                _m = re.search(r'([A-Za-z][A-Za-z0-9_-]*)="?([^";,\s]+)', _sc)
                if _m:
                    cookie_dict[_m.group(1)] = _m.group(2).strip('"')

        # Step 1 — always refresh JSESSIONID via /feed/
        _pre_cookie = "; ".join(
            f"{k}={v}" for k, v in cookie_dict.items()
            if k in ("li_at", "lidc", "bscookie", "bcookie", "lang", "li_mc", "li_gc")
        )
        try:
            _r = await _pre.get(
                "https://www.linkedin.com/feed/",
                headers={**_nav_headers(), "cookie": _pre_cookie, "sec-fetch-site": "none"},
            )
            app_logger.info("voyager: pre-flight /feed/ → HTTP %s url=%s", _r.status_code, str(_r.url)[:60])
            if "login" in str(_r.url) or _r.status_code in (401, 403):
                return {"success": False, "error": "LinkedIn session expired — save session again from Settings", "session_expired": True}
            _update_cookies(_r)
        except Exception as _e:
            app_logger.warning("voyager: /feed/ pre-flight failed: %s", _e)

        # Step 2 — for SN URLs, also hit the SN search page to activate SN session
        if is_sn_url:
            _full_cookie = "; ".join(f"{k}={v}" for k, v in cookie_dict.items())
            try:
                _sn_r = await _pre.get(
                    "https://www.linkedin.com/sales/search/people",
                    headers={**_nav_headers("https://www.linkedin.com/feed/"), "cookie": _full_cookie},
                )
                app_logger.info("voyager: SN session activation /sales/search/people → HTTP %s", _sn_r.status_code)
                _update_cookies(_sn_r)
            except Exception as _e:
                app_logger.warning("voyager: SN activation pre-flight failed: %s", _e)

    _fresh_js = cookie_dict.get("JSESSIONID", "").strip('"')
    app_logger.info("voyager: fresh JSESSIONID = %s...", _fresh_js[:16] if _fresh_js else "NONE")

    # Build final cookie string and headers with fresh JSESSIONID
    jsessionid = cookie_dict.get("JSESSIONID", "").strip('"')
    cookie_header = "; ".join(f"{k}={v}" for k, v in cookie_dict.items())

    headers = {
        "accept": "application/vnd.linkedin.normalized+json+2.1",
        "accept-language": "en-US,en;q=0.9",
        "content-type": "application/json",
        "csrf-token": jsessionid,          # ← always fresh now
        "x-restli-protocol-version": "2.0.0",
        "x-li-lang": "en_US",
        "x-li-track": _json.dumps({
            "clientVersion": "1.15.16532",
            "mpVersion": "1.15.16532",
            "osName": "web",
            "timezoneOffset": 5.5,
            "timezone": "Asia/Kolkata",
            "deviceFormFactor": "DESKTOP",
            "mpName": "voyager-web",
        }),
        "x-li-page-instance": "urn:li:page:d_flagship3_feed;AAAAAA==",
        "user-agent": _UA,
        "origin": "https://www.linkedin.com",
        "referer": "https://www.linkedin.com/feed/",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
        "cookie": cookie_header,
    }

    # Extract vanity name — handle both regular (/in/VANITY) and Sales Navigator URLs
    m_regular   = re.search(r"/in/([^/?#]+)", linkedin_url)
    # Capture the FULL Sales Nav segment including context (e.g. ACo...,NAME_SEARCH,xyz)
    m_sales_full = re.search(r"/sales/lead/([^/?#]+)", linkedin_url)

    if m_regular:
        vanity = m_regular.group(1).rstrip("/")
        sales_nav_full = None
        sales_nav_id   = None
    elif m_sales_full:
        sales_nav_full = m_sales_full.group(1)          # "ACo...,NAME_SEARCH,64lV"
        sales_nav_id   = sales_nav_full.split(",")[0]   # "ACo..."  (encoded member ID)
        vanity = None
    else:
        return {"success": False, "error": f"Cannot parse LinkedIn URL: {linkedin_url}"}

    async with httpx.AsyncClient(follow_redirects=True, timeout=20.0) as client:
        # Step 1 — Resolve profile → fsd_profile ID
        profile_urn: str | None = None
        profile_id: str | None = None

        def _extract_profile_id(data: dict) -> str | None:
            """Search any JSON structure for a LinkedIn fsd_profile or member URN."""
            import re as _re
            text = str(data)
            # Prefer fsd_profile URN (works with invite API)
            m = _re.search(r'urn:li:fsd_profile:[A-Za-z0-9+/=_-]{10,}', text)
            if m:
                return m.group(0).split(":")[-1]
            # Fall back to member URN
            m2 = _re.search(r'urn:li:(?:member|fs_miniProfile|fs_normalized_profile|person):[A-Za-z0-9+/=_-]{10,}', text)
            if m2:
                return m2.group(0).split(":")[-1]
            return None

        if sales_nav_id:
            # ── Sales Navigator URL ──────────────────────────────────────────
            # PhantomBuster approach: call SN's Voyager JSON API directly.
            # SN lead pages are React SPAs — the initial HTML response is an
            # empty shell with no data. We MUST use the JSON API endpoints.
            import urllib.parse as _up
            app_logger.info("voyager: resolving SN ID %s", sales_nav_id[:16])

            sn_full = sales_nav_full or sales_nav_id
            sn_urn_raw = f"urn:li:fs_salesProfile:({sn_full})"
            sn_urn_enc = _up.quote(sn_urn_raw, safe="()")

            async def _resolve_via_vanity(vanity: str) -> str | None:
                """Resolve a vanity name to fsd_profile ID using identity API."""
                for ep in [
                    f"https://www.linkedin.com/voyager/api/identity/profiles/{vanity}",
                    f"https://www.linkedin.com/voyager/api/identity/memberByVanityName?memberVanityName={vanity}",
                ]:
                    try:
                        rv = await client.get(ep, headers=headers)
                        if rv.status_code == 200:
                            pid = _extract_profile_id(rv.json())
                            if pid:
                                app_logger.info("voyager: vanity %s → %s", vanity, pid)
                                return pid
                    except Exception:
                        pass
                return None

            # ── Method 1: SN Voyager JSON API ────────────────────────────────
            # Critical: SN API checks Referer — must be an SN page, not /feed/.
            # Using wrong Referer causes 403 even with valid li_at + JSESSIONID.
            sn_page_referer = f"https://www.linkedin.com/sales/lead/{sn_full}"
            sn_headers = {
                **headers,
                "referer":  sn_page_referer,
                "x-li-page-instance": f"urn:li:page:d_sales2_leadpage;{sn_full[:20]}",
                "x-li-lang": "en_US",
            }

            sn_api_endpoints = [
                f"https://www.linkedin.com/voyager/api/salesApiProfiles/{sn_urn_enc}",
                f"https://www.linkedin.com/voyager/api/sales/leads/{_up.quote(sales_nav_id)}",
                f"https://www.linkedin.com/voyager/api/salesApiPeopleSearch?q=member&memberIds=List({_up.quote(sales_nav_id)})",
                # Also try with full SN URN encoded differently
                f"https://www.linkedin.com/voyager/api/salesApiProfiles/{_up.quote(sn_urn_raw)}",
            ]
            for sn_ep in sn_api_endpoints:
                try:
                    rv = await client.get(sn_ep, headers=sn_headers)
                    app_logger.info(
                        "voyager: SN API %s → HTTP %s (url=%s)",
                        sn_ep.split("/")[-1][:40], rv.status_code, str(rv.url)[:80],
                    )
                    if rv.status_code in (401, 403):
                        return {"success": False, "error": "LinkedIn session expired", "session_expired": True}
                    if rv.status_code == 429:
                        return {"success": False, "error": "LinkedIn rate limit hit"}
                    if rv.status_code != 200:
                        app_logger.debug("voyager: SN API non-200 body: %s", rv.text[:300])
                        continue

                    try:
                        data = rv.json()
                    except Exception:
                        app_logger.debug("voyager: SN API returned non-JSON: %s", rv.text[:200])
                        continue
                    data_text = rv.text
                    app_logger.debug("voyager: SN API response keys: %s", list(data.keys())[:10])

                    # Direct fsd_profile URN in JSON
                    profile_id = _extract_profile_id(data)
                    if profile_id:
                        app_logger.info("voyager: SN JSON API → fsd_profile %s", profile_id)
                        break

                    # publicProfileUrl → resolve vanity to fsd_profile
                    pub_m = re.search(r'"publicProfileUrl"\s*:\s*"(https?:[^"\\]+/in/[^"\\]+)"', data_text)
                    if pub_m:
                        sn_vanity = pub_m.group(1).replace("\\", "").rstrip("/").split("/in/")[-1]
                        profile_id = await _resolve_via_vanity(sn_vanity)
                        if profile_id:
                            break

                except Exception as e:
                    app_logger.warning("voyager: SN API error %s: %s", sn_ep.split("/")[-1][:30], e)
                    continue

            # ── Method 2: SN lead page HTML (fallback — sometimes has embedded JSON) ─
            # SN is a React SPA so the HTML shell usually has NO data, but
            # occasionally LinkedIn embeds bootstrap JSON in <script> tags.
            if not profile_id:
                try:
                    r_page = await client.get(
                        f"https://www.linkedin.com/sales/lead/{sn_full}",
                        headers={
                            **headers,
                            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                            "sec-fetch-dest": "document",
                            "sec-fetch-mode": "navigate",
                        },
                    )
                    if r_page.status_code == 200:
                        html = r_page.text
                        m_fsd = re.search(r'fsd_profile:([A-Za-z0-9+/=_-]{10,})', html)
                        if m_fsd:
                            profile_id = m_fsd.group(1).strip('"\\')
                            app_logger.info("voyager: SN HTML → fsd_profile %s", profile_id)
                        if not profile_id:
                            m_pub = re.search(r'linkedin\.com/in/([A-Za-z0-9_%-]{3,120}?)(?:["\\/]|\\u002F)', html)
                            if m_pub:
                                profile_id = await _resolve_via_vanity(m_pub.group(1).rstrip("-"))
                    elif r_page.status_code in (401, 403):
                        return {"success": False, "error": "LinkedIn session expired", "session_expired": True}
                except Exception as e:
                    app_logger.debug("voyager: SN HTML fallback failed: %s", e)

            # ── Method 3: base64-decode the SN ID → member int ───────────────
            if not profile_id:
                try:
                    import base64 as _b64
                    pad = (4 - len(sales_nav_id) % 4) % 4
                    raw = _b64.urlsafe_b64decode(sales_nav_id + "=" * pad)
                    for offset in (4, 0, 8):
                        if len(raw) < offset + 4:
                            continue
                        member_id = int.from_bytes(raw[offset:offset + 4], "big")
                        if member_id <= 10_000:
                            continue
                        app_logger.info("voyager: SN b64 → member %d", member_id)
                        for ep in [
                            f"https://www.linkedin.com/voyager/api/identity/profiles/urn%3Ali%3Amember%3A{member_id}",
                        ]:
                            try:
                                rv = await client.get(ep, headers=headers)
                                if rv.status_code == 200:
                                    pid = _extract_profile_id(rv.json())
                                    if not pid:
                                        m2 = re.search(r'fsd_profile:([A-Za-z0-9+/=_-]{10,})', rv.text)
                                        if m2:
                                            pid = m2.group(1)
                                    if pid:
                                        profile_id = pid
                                        app_logger.info("voyager: SN b64 → fsd_profile %s", pid)
                                        break
                            except Exception:
                                pass
                        if profile_id:
                            break
                except Exception as e:
                    app_logger.debug("voyager: SN b64 decode failed: %s", e)

            if not profile_id:
                return {
                    "success": False,
                    "error": (
                        "Could not resolve this Sales Navigator profile. "
                        "Edit the lead and replace the SN URL with the person's regular LinkedIn /in/ URL."
                    ),
                }
        else:
            # Regular /in/ URL — resolve vanity → profile ID
            # Try same 3 endpoints the Chrome extension uses, then fall back to HTML scrape
            lookup_endpoints = [
                f"https://www.linkedin.com/voyager/api/identity/profiles/{vanity}",
                f"https://www.linkedin.com/voyager/api/identity/profiles/{vanity}/profileView",
                f"https://www.linkedin.com/voyager/api/identity/memberByVanityName?memberVanityName={vanity}",
            ]
            for endpoint in lookup_endpoints:
                try:
                    r = await client.get(endpoint, headers=headers)
                except Exception as e:
                    app_logger.debug("voyager profile lookup error %s: %s", endpoint, e)
                    continue
                if r.status_code in (401, 403) or "login" in str(r.url):
                    return {"success": False, "error": "LinkedIn session expired", "session_expired": True}
                if r.status_code not in (200, 201):
                    app_logger.debug("voyager profile lookup %s → HTTP %s", endpoint, r.status_code)
                    continue
                try:
                    profile_id = _extract_profile_id(r.json())
                except Exception:
                    pass
                if profile_id:
                    app_logger.info("voyager: resolved %s → %s via %s", vanity, profile_id, endpoint)
                    break

            # Fallback: fetch the profile HTML page — LinkedIn embeds the URN in every profile page
            # even when Voyager API returns 403/404 due to privacy or rate-limiting
            if not profile_id:
                import re as _re
                app_logger.info("voyager: falling back to HTML scrape for %s", vanity)
                try:
                    html_headers = {
                        "accept": "text/html,application/xhtml+xml",
                        "accept-language": "en-US,en;q=0.9",
                        "user-agent": headers["user-agent"],
                        "cookie": cookie_header,
                        "sec-fetch-site": "same-origin",
                        "sec-fetch-mode": "navigate",
                        "sec-fetch-dest": "document",
                    }
                    r_html = await client.get(
                        f"https://www.linkedin.com/in/{vanity}/",
                        headers=html_headers,
                    )
                    if r_html.status_code in (401, 403) or "login" in str(r_html.url):
                        return {"success": False, "error": "LinkedIn session expired", "session_expired": True}
                    if r_html.status_code == 200:
                        m = _re.search(
                            r'urn:li:(?:fsd_profile|member|fs_miniProfile|person):[A-Za-z0-9+/=_-]{10,}',
                            r_html.text
                        )
                        if m:
                            profile_id = m.group(0).split(":")[-1]
                            app_logger.info("voyager: resolved %s → %s via HTML scrape", vanity, profile_id)
                except Exception as e:
                    app_logger.warning("voyager: HTML fallback failed for %s: %s", vanity, e)

            if not profile_id:
                return {
                    "success": False,
                    "error": f"Could not resolve LinkedIn profile for '{vanity}' — profile may be private or URL is wrong",
                }

        # Step 2 — Send the connection invitation
        tracking_id = base64.b64encode(os.urandom(16)).decode()
        payload: dict = {
            "emberEntityName": "growth/invitation",
            "invitee": {
                "com.linkedin.voyager.growth.invitation.InviteeProfile": {
                    "profileId": profile_id
                }
            },
            "trackingId": tracking_id,
        }
        if note and note.strip():
            payload["message"] = note.strip()[:300]

        # Try both the current and the older endpoint (LinkedIn sometimes 301-redirects between them)
        invite_endpoints = [
            "https://www.linkedin.com/voyager/api/growth/normInvitations",
            "https://www.linkedin.com/voyager/api/relationships/normInvitations",
        ]
        r2 = None
        for inv_url in invite_endpoints:
            try:
                r2 = await client.post(inv_url, headers=headers, json=payload)
                app_logger.info("voyager invite: %s → HTTP %s", inv_url, r2.status_code)
                # If we get a redirect (301/302), try the next endpoint
                if r2.status_code in (301, 302):
                    location = r2.headers.get("location", "")
                    app_logger.info("voyager invite: 301 redirect to %s", location)
                    if location:
                        try:
                            r2 = await client.post(location, headers=headers, json=payload)
                            app_logger.info("voyager invite: followed redirect → HTTP %s", r2.status_code)
                        except Exception:
                            pass
                    continue
                break  # Got a non-301 response
            except Exception as e:
                app_logger.warning("voyager invite endpoint %s failed: %s", inv_url, e)
                continue

        if r2 is None:
            return {"success": False, "error": "All invite endpoints failed"}

        if r2.status_code in (301, 302):
            return {"success": False, "error": "session_expired (LinkedIn redirecting — save session again via Settings)", "session_expired": True}
        if r2.status_code in (401, 403):
            return {"success": False, "error": "LinkedIn session expired — save session again via Settings", "session_expired": True}
        if r2.status_code == 429:
            return {"success": False, "error": "LinkedIn rate limit hit — too many requests today"}
        if r2.status_code in (200, 201):
            # Check if response is HTML (redirect followed to login page)
            ct = r2.headers.get("content-type", "")
            if "html" in ct or "text/" in ct:
                return {"success": False, "error": "session_expired (redirected to login)", "session_expired": True}
            return {"success": True}

        # Handle known LinkedIn error messages
        try:
            err_data = r2.json()
            msg = (err_data.get("message") or err_data.get("errorDetailType") or str(r2.status_code))
            if "InvitationAlreadySentException" in msg or "alreadySent" in msg:
                return {"success": False, "already_pending": True, "error": "Connection request already pending"}
            if "AlreadyConnectedException" in msg:
                return {"success": False, "already_connected": True, "error": "Already connected (1st degree)"}
            if msg:
                return {"success": False, "error": msg}
        except Exception:
            pass

        return {"success": False, "error": f"Invite API returned HTTP {r2.status_code}: {r2.text[:200]}"}


async def _run_lead_connect(job_id: str, lead: dict, storage_state: dict) -> None:
    """
    Generate an AI note, then delegate the actual send to the Chrome extension.

    Backend-only httpx invite-sending (_voyager_send_invite) is confirmed dead: LinkedIn's
    growth/normInvitations and relationships/normInvitations endpoints return a 301 with no
    Location header, then a flat 404, on every single attempt — zero successful sends were
    ever recorded across 40 logged attempts. The extension instead clicks the real, rendered
    "Connect" button via a CDP-trusted click (see clickConnectButton() in background.js),
    which is the only mechanism proven this session to actually work. storage_state is kept
    in the signature for caller compatibility but is unused now that sending is extension-only.
    """
    from app.services.ai_generator import AIGenerator

    job = _lead_connect_jobs[job_id]
    job["status"] = "running"
    ai = AIGenerator()

    try:
        note = await ai.generate_connect_note(
            lead_name=lead["name"],
            lead_company=lead.get("company"),
            lead_title=lead.get("title"),
        )
        job["note"] = note
        job["linkedin_url"] = lead["linkedin_url"]
        job["status"] = "waiting_extension"
        app_logger.info("lead_connect %s: note ready, delegating to extension", job_id)

    except Exception as exc:
        app_logger.exception("_run_lead_connect %s failed: %s", job_id, exc)
        job["status"] = "error"
        job["error"] = str(exc)
        job["success"] = False
        job["finished_at"] = datetime.now(timezone.utc).isoformat()


@router.get("/connect-job/{job_id}", response_model=ApiResponse[dict])
async def get_lead_connect_job(
    job_id: str,
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Poll a single-lead connect job."""
    job = _lead_connect_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Connect job '{job_id}' not found.")
    msg = {
        "pending":            "Generating personalised note…",
        "running":            "Generating personalised note…",
        "waiting_extension":  "Sending via extension…",
        "done":               f"Connection request sent to {job.get('lead_name', 'lead')}!",
        "error":              f"Failed: {job.get('error', 'unknown')}",
    }.get(job["status"], job["status"])
    return ApiResponse(message=msg, data=job)


@router.post("/connect-job/{job_id}/extension-result", response_model=ApiResponse[dict])
async def extension_connect_result(
    job_id: str,
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Called by the Chrome extension (via background.js) to report invite result."""
    job = _lead_connect_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Connect job '{job_id}' not found.")

    success = body.get("success", False)
    error = body.get("error", "")
    note = body.get("note", "")
    session_expired = body.get("session_expired", False)

    async with AsyncSessionLocal() as session:
        lead_obj = await session.get(Lead, job["lead_id"])
        if lead_obj:
            if success:
                lead_obj.connection_status = ConnectionStatus.PENDING
                lead_obj.connection_sent_at = datetime.now(timezone.utc)
                job["success"] = True
                job["status"] = "done"
                if note:
                    job["note"] = note
            elif error == "already_pending":
                lead_obj.connection_status = ConnectionStatus.PENDING
                job["success"] = False
                job["error"] = "Connection request already pending"
                job["status"] = "done"
                job["already_pending"] = True
            elif error == "already_connected":
                lead_obj.connection_status = ConnectionStatus.ACCEPTED
                job["success"] = False
                job["error"] = "Already connected (1st degree)"
                job["status"] = "done"
                job["already_connected"] = True
            else:
                job["success"] = False
                job["error"] = error or "Unknown error from extension"
                job["status"] = "error"
                if session_expired:
                    job["session_expired"] = True
                    expired_res = await session.execute(
                        select(BrowserSession)
                        .where(BrowserSession.status == SessionStatus.ACTIVE, BrowserSession.user_id == user.id)
                        .order_by(BrowserSession.last_used.desc())
                        .limit(1)
                    )
                    expired_row = expired_res.scalar_one_or_none()
                    if expired_row:
                        expired_row.status = SessionStatus.EXPIRED
            await session.commit()

    job["finished_at"] = datetime.now(timezone.utc).isoformat()
    app_logger.info("lead_connect %s extension-result: success=%s error=%s", job_id, success, error)
    return ApiResponse(message="Result recorded.", data=job)


@router.post("/update-linkedin-url", response_model=ApiResponse[dict])
async def update_linkedin_url(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """Update a lead's LinkedIn URL — find by lead_id OR by current SN URL."""
    new_url = (body.get("linkedin_url") or "").strip()
    if not new_url:
        raise BadRequestError("linkedin_url is required")

    lead = None

    # Find by lead_id if provided
    if body.get("lead_id"):
        lead = await db.get(Lead, int(body["lead_id"]))

    # Find by current SN URL if lead_id not given or not found
    if not lead and body.get("lead_sn_url"):
        sn_url = body["lead_sn_url"].strip()
        res = await db.execute(select(Lead).where(Lead.linkedin_url == sn_url, Lead.user_id == user.id).limit(1))
        lead = res.scalar_one_or_none()

    if not lead or lead.user_id != user.id:
        return ApiResponse(message="Lead not found — URL not updated", data={})

    old_url = lead.linkedin_url
    lead.linkedin_url = new_url

    # Also upgrade the name when the send flow captured the real full name from the profile page —
    # Sales Navigator abbreviates last names ("Adam S."), so a longer real name ("Adam Spector")
    # replaces it so the lead is recognisable and matchable by name later.
    new_name = (body.get("name") or "").strip()
    if new_name and len(new_name) > len(lead.name or "") and not new_name.rstrip(".").endswith((" S", " S")):
        # Prefer a name that isn't itself an abbreviation (doesn't end in a single-letter last name).
        parts = new_name.split()
        if len(parts) >= 2 and len(parts[-1].rstrip(".")) > 1:
            lead.name = new_name

    await db.commit()
    app_logger.info("Updated lead %d URL: %s → %s (name=%s)", lead.id, old_url, new_url, lead.name)
    return ApiResponse(message="LinkedIn URL updated", data={"lead_id": lead.id, "linkedin_url": new_url, "name": lead.name})


@router.post("/reconcile-status", response_model=ApiResponse[dict])
async def reconcile_status(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Set REAL connection status from LinkedIn's actual "Sent invitations" list (sent by the
    extension). A lead whose /in/<vanity> is in `pending_vanities` is genuinely PENDING; any lead
    currently marked PENDING but NOT in that set was a false positive (from the old UI-modal
    attempts) and is reset to NOT_SENT. ACCEPTED leads are never touched.
    """
    import re as _re
    pending = {str(v).strip().lower() for v in body.get("pending_vanities", []) if v}
    connected = {str(v).strip().lower() for v in body.get("connected_vanities", []) if v}
    # fsd_profile URN ids are case-sensitive (e.g. ACoAAB...) — keep original case, don't lowercase.
    connected_ids = {str(v).strip() for v in body.get("connected_ids", []) if v}

    def _norm_name(s: str | None) -> str:
        return _re.sub(r"\s+", " ", _re.sub(r"[^a-z0-9 ]", "", (s or "").lower())).strip()

    # Sales-Navigator leads have no matchable vanity/id, so also match them by NAME against the
    # real connections list. (Name collisions can cause a rare false "connected" — acceptable
    # tradeoff so SN leads aren't stuck showing "failed".)
    connected_names = {_norm_name(n) for n in body.get("connected_names", []) if n and _norm_name(n)}
    pending_names = {_norm_name(n) for n in body.get("pending_names", []) if n and _norm_name(n)}

    def seg_of(url: str | None) -> str | None:
        """The /in/<segment> — a real vanity for normal leads, or an fsd_profile id for SN-imported ones."""
        if not url or "/in/" not in url:
            return None
        return (url.split("/in/")[1].split("/")[0].split("?")[0].strip()) or None

    leads = (await db.execute(select(Lead).where(Lead.user_id == user.id))).scalars().all()

    # Leads we ACTUALLY tried to invite (a CONNECT action that succeeded). Only these may be kept
    # "pending" by a loose name match — a freshly-fetched lead (no attempt) must never be flipped to
    # "sent" just because its name collides with someone in the account's global pending list.
    from app.models import Action, ActionType, ActionStatus
    attempted_rows = (await db.execute(
        select(Action.lead_id).where(
            Action.user_id == user.id,
            Action.action_type == ActionType.CONNECT,
            Action.status == ActionStatus.SUCCESS,
        )
    )).scalars().all()
    attempted_lead_ids = {lid for lid in attempted_rows if lid is not None}

    marked_pending = 0
    marked_connected = 0
    cleared = 0
    for lead in leads:
        seg = seg_of(lead.linkedin_url)
        v = seg.lower() if seg else None
        ln = _norm_name(lead.name)
        # Reliable match: by /in/ vanity (normal leads) or fsd_profile id.
        vanity_connected = (v and v in connected) or (seg and seg in connected_ids)
        vanity_pending   = (v and v in pending)
        # Name match is a LOOSE fallback for SN leads (broken vanity). To avoid false "sent" when
        # merely fetching, only let a name match MAINTAIN/UPGRADE a lead we already attempted
        # (already PENDING) — NEVER flip a fresh NOT_SENT lead to sent/connected on a name alone.
        already_attempted = lead.id in attempted_lead_ids
        name_connected = already_attempted and ln and ln in connected_names
        name_pending   = already_attempted and ln and ln in pending_names

        if vanity_connected or name_connected:
            if lead.connection_status != ConnectionStatus.ACCEPTED:
                marked_connected += 1
            lead.connection_status = ConnectionStatus.ACCEPTED
        elif vanity_pending or name_pending:
            if lead.connection_status != ConnectionStatus.PENDING:
                marked_pending += 1
            lead.connection_status = ConnectionStatus.PENDING
        elif lead.connection_status == ConnectionStatus.PENDING:
            # Was marked pending but is neither pending nor connected on LinkedIn → false positive.
            lead.connection_status = ConnectionStatus.NOT_SENT
            cleared += 1
        # ACCEPTED leads not in the connected list are left untouched (the list may be paginated).
    await db.commit()
    # Current TOTALS (not just what changed) — clearer for the UI than deltas.
    now_connected = sum(1 for l in leads if l.connection_status == ConnectionStatus.ACCEPTED)
    now_pending = sum(1 for l in leads if l.connection_status == ConnectionStatus.PENDING)
    now_to_send = sum(1 for l in leads if l.connection_status in (ConnectionStatus.NOT_SENT, ConnectionStatus.IGNORED))
    app_logger.info("reconcile-status: now %d connected, %d pending, %d to-send (changed: +%dC +%dP -%d) (LI pending=%d connected=%d ids=%d)",
                    now_connected, now_pending, now_to_send, marked_connected, marked_pending, cleared, len(pending), len(connected), len(connected_ids))
    return ApiResponse(
        message=f"Status synced — {now_connected} connected, {now_pending} pending, {now_to_send} to send.",
        data={"connected": now_connected, "pending": now_pending, "to_send": now_to_send,
              "marked_connected": marked_connected, "marked_pending": marked_pending, "cleared": cleared,
              "linkedin_pending_total": len(pending), "linkedin_connected_total": len(connected)},
    )


@router.post("/schedule-invites", response_model=ApiResponse[dict])
async def schedule_invites(
    body: dict,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Queue CONNECT actions for selected leads, distributed at daily_limit per day.
    The background scheduler (run_dev.py) picks these up automatically — no login needed.
    """
    from datetime import timedelta
    from pydantic import BaseModel

    lead_ids: list[int] = body.get("lead_ids", [])
    daily_limit: int = min(int(body.get("daily_limit", 20)), 50)  # hard cap 50/day

    if not lead_ids:
        raise BadRequestError("No lead IDs provided.")

    queued = 0
    skipped = 0
    now = datetime.now(timezone.utc)

    # Figure out how many actions are already scheduled for today so we don't exceed the limit
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_count_res = await db.execute(
        select(func.count()).where(
            Action.action_type == ActionType.CONNECT,
            Action.status.in_([ActionStatus.PENDING, ActionStatus.QUEUED]),
            Action.scheduled_at >= today_start,
        )
    )
    today_count = today_count_res.scalar() or 0

    # Schedule across days at `daily_limit` per day, spread across business hours (9 AM – 6 PM).
    # First slot starts from now (so the background loop picks them up immediately).
    slot_index = today_count  # how many already queued today

    for lead_id in lead_ids:
        lead = await db.get(Lead, lead_id)
        if not lead or lead.user_id != user.id or not lead.linkedin_url:
            skipped += 1
            continue
        if lead.connection_status in (ConnectionStatus.PENDING, ConnectionStatus.ACCEPTED):
            skipped += 1
            continue

        # Spread slots across 9 AM – 6 PM (9 hours = 540 minutes)
        day_offset = slot_index // daily_limit
        slot_in_day = slot_index % daily_limit
        window_minutes = 540  # 9 AM to 6 PM
        minutes_per_slot = window_minutes // max(daily_limit, 1)
        base_time = now.replace(hour=9, minute=0, second=0, microsecond=0) + timedelta(days=day_offset)
        jitter = random.randint(-5, 5)  # ±5 min jitter so sends look human
        schedule_time = base_time + timedelta(minutes=slot_in_day * minutes_per_slot + jitter)
        # If this slot is already in the past (e.g. it's 2 PM and we filled the morning slots),
        # stagger from now with a small random delay so they send today
        if schedule_time < now:
            schedule_time = now + timedelta(minutes=random.randint(2, 8) * (slot_in_day + 1))

        action = Action(
            user_id=user.id,
            lead_id=lead_id,
            action_type=ActionType.CONNECT,
            status=ActionStatus.PENDING,
            scheduled_at=schedule_time,
            payload={"source": "bulk_schedule"},
        )
        db.add(action)
        queued += 1
        slot_index += 1

    await db.commit()

    days_needed = (slot_index) // daily_limit + (1 if (slot_index % daily_limit) > 0 else 0)
    return ApiResponse(
        message=f"Queued {queued} invites at {daily_limit}/day — done in ~{days_needed} day(s).",
        data={"queued": queued, "skipped": skipped, "daily_limit": daily_limit, "days": days_needed},
    )


@router.post("/{lead_id}/connect", response_model=ApiResponse[dict])
async def connect_to_lead(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[dict]:
    """
    Send an AI-personalized LinkedIn connection request to a lead.
    Returns immediately with a job_id — poll GET /leads/connect-job/{job_id} for progress.
    If already sent or accepted, returns the current status without opening a browser.
    """
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise LeadNotFoundError()

    # Guard: already sent / connected
    if lead.connection_status == ConnectionStatus.PENDING:
        return ApiResponse(
            message="Connection request already sent.",
            data={"status": "PENDING", "already_sent": True},
        )
    if lead.connection_status == ConnectionStatus.ACCEPTED:
        return ApiResponse(
            message="Already connected.",
            data={"status": "ACCEPTED", "already_connected": True},
        )
    if not lead.linkedin_url:
        raise BadRequestError("Lead has no LinkedIn URL — cannot send connection request.")

    # PhantomBuster approach: load stored li_at cookie and send directly from backend.
    # No browser extension needed — same machine = same IP = LinkedIn trusts it.
    from app.models import BrowserSession
    from app.services.session_manager import SessionManager

    # Extension uses live browser cookies (credentials: 'include') — not the stored file.
    # So ACTIVE or EXPIRED status both work; we just need the session row to exist.
    session_row = (await db.execute(
        select(BrowserSession).where(
            BrowserSession.user_id == user.id, BrowserSession.status.in_(["ACTIVE", "EXPIRED"])
        ).limit(1)
    )).scalar_one_or_none()
    if not session_row:
        raise BadRequestError(
            "No LinkedIn session found. Go to Settings → LinkedIn, make sure you're logged in, and click 'Connect LinkedIn' once."
        )

    storage_state = SessionManager().load_session(session_row.account_name) or {}

    job_id = str(uuid.uuid4())[:8]
    _lead_connect_jobs[job_id] = {
        "job_id":    job_id,
        "lead_id":   lead_id,
        "lead_name": lead.name,
        "status":    "pending",
        "note":      None,
        "success":   None,
        "error":     None,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": None,
    }

    lead_snapshot = {
        "id":          lead.id,
        "name":        lead.name,
        "company":     lead.company,
        "title":       lead.title,
        "linkedin_url": lead.linkedin_url,
    }
    asyncio.create_task(_run_lead_connect(job_id, lead_snapshot, storage_state))

    app_logger.info("lead_connect job %s queued for lead %d (%s)", job_id, lead_id, lead.name)
    return ApiResponse(
        message=f"Sending AI-personalised request to {lead.name}...",
        data={"job_id": job_id, "status": "pending", "lead_id": lead_id},
    )


@router.post("", response_model=ApiResponse[LeadOut], status_code=status.HTTP_201_CREATED)
async def create_lead(
    body: LeadCreate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[LeadOut]:
    lead = Lead(**body.model_dump(), user_id=user.id)
    db.add(lead)
    await db.flush()
    await db.refresh(lead)
    return ApiResponse(message="Lead created.", data=LeadOut.model_validate(lead))


@router.get("", response_model=PaginatedResponse[LeadOut])
async def list_leads(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    status_filter: str | None = Query(None, alias="status"),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> PaginatedResponse[LeadOut]:
    q = select(Lead).where(Lead.user_id == user.id)
    if status_filter:
        q = q.where(Lead.status == status_filter)

    total_q = select(func.count()).select_from(q.subquery())
    total = (await db.execute(total_q)).scalar_one()

    rows = (await db.execute(q.offset((page - 1) * page_size).limit(page_size))).scalars().all()
    return PaginatedResponse(
        data=[LeadOut.model_validate(r) for r in rows],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{lead_id}", response_model=ApiResponse[LeadOut])
async def get_lead(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[LeadOut]:
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise LeadNotFoundError()
    return ApiResponse(data=LeadOut.model_validate(lead))


@router.patch("/{lead_id}", response_model=ApiResponse[LeadOut])
async def update_lead(
    lead_id: int,
    body: LeadUpdate,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[LeadOut]:
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise LeadNotFoundError()
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(lead, field, value)
    await db.flush()
    await db.refresh(lead)
    return ApiResponse(message="Lead updated.", data=LeadOut.model_validate(lead))


@router.delete("/{lead_id}", response_model=ApiResponse[None], status_code=status.HTTP_200_OK)
async def delete_lead(
    lead_id: int,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ApiResponse[None]:
    lead = await db.get(Lead, lead_id)
    if not lead or lead.user_id != user.id:
        raise LeadNotFoundError()
    await db.delete(lead)
    return ApiResponse(message="Lead deleted.")
