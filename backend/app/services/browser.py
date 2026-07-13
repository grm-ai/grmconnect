"""
Human-like LinkedIn browser automation.

Every action simulates realistic human behaviour:
- Variable reading delays (3–8 s on a profile before acting)
- Incremental scrolling (not instant jump to bottom)
- Random mouse movement pauses
- Typing character-by-character with natural speed variance
- Random delays BETWEEN successive profiles (5–15 s)
"""
from __future__ import annotations

import asyncio
import random
from typing import Any

from app.logger import browser_logger
from app.models import ActionType


# ── Stealth config ────────────────────────────────────────────────────────────

_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)

_CHROME_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--disable-infobars",
    "--disable-notifications",
    "--no-default-browser-check",
    "--disable-extensions-except=",
    "--disable-component-extensions-with-background-pages",
    "--window-size=1280,800",
]

# Comprehensive stealth — patches every known webdriver detection vector
_STEALTH_SCRIPT = """
(function() {
  // Remove webdriver flag
  delete Object.getPrototypeOf(navigator).webdriver;
  Object.defineProperty(navigator, 'webdriver', {get: () => undefined});

  // Realistic plugin list
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const p = {
        0: {name:'Chrome PDF Plugin', filename:'internal-pdf-viewer', description:'Portable Document Format', length:1},
        1: {name:'Chrome PDF Viewer', filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai', description:'', length:1},
        2: {name:'Native Client', filename:'internal-nacl-plugin', description:'', length:2},
        length: 3,
        item: (i) => [p[0],p[1],p[2]][i],
        namedItem: (n) => [p[0],p[1],p[2]].find(x=>x.name===n)||null,
        refresh: () => {},
        [Symbol.iterator]: function*() {yield p[0]; yield p[1]; yield p[2];}
      };
      return p;
    }
  });

  // Languages
  Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
  Object.defineProperty(navigator, 'language',  {get: () => 'en-US'});

  // Chrome runtime — timestamps captured once at injection so they don't keep moving
  window.chrome = {
    app: {isInstalled: false},
    runtime: {
      id: undefined,
      connect: () => {},
      sendMessage: () => {},
    },
    loadTimes: (() => {
      const _n = Date.now() / 1000;
      const _lt = {
        commitLoadTime: _n - 0.38,
        connectionInfo: 'h2',
        finishDocumentLoadTime: _n - 0.09,
        finishLoadTime: _n - 0.07,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: _n - 0.11,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: _n - 0.55,
        startLoadTime: _n - 0.55,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
      return () => Object.assign({}, _lt);
    })(),
    csi: (() => {
      const _s = Date.now() - 480 - Math.floor(Math.random()*120);
      return () => ({startE: _s, onloadT: _s + 390, pageT: 1180 + Math.floor(Math.random()*250), tran: 15});
    })(),
  };

  // Permissions
  const origQuery = window.navigator.permissions.query.bind(navigator.permissions);
  window.navigator.permissions.query = (p) =>
    p.name === 'notifications'
      ? Promise.resolve({state: Notification.permission, onchange: null})
      : origQuery(p);

  // Screen — realistic values
  Object.defineProperty(screen, 'width',  {get: () => 1920});
  Object.defineProperty(screen, 'height', {get: () => 1080});
  Object.defineProperty(screen, 'availWidth',  {get: () => 1920});
  Object.defineProperty(screen, 'availHeight', {get: () => 1040});
  Object.defineProperty(screen, 'colorDepth',  {get: () => 24});
  Object.defineProperty(screen, 'pixelDepth',  {get: () => 24});
})();
"""


async def launch_real_browser(pw, storage_state: dict | None = None, headless: bool = True):
    """
    Launch Google Chrome (real binary, not Playwright's bundled Chromium).
    Falls back to Playwright's Chromium only if Chrome is not installed.

    Using real Chrome is critical: LinkedIn's bot detection checks the browser
    fingerprint (TLS stack, JS engine, WebGL, canvas) — Playwright's Chromium
    fails these checks within seconds. Real Chrome passes them.
    """
    launch_kwargs: dict = {
        "slow_mo": 80,
        "args": _CHROME_ARGS,
        "ignore_default_args": ["--enable-automation"],
    }
    ctx_kwargs: dict = {
        "viewport": {"width": 1280, "height": 900},
        "user_agent": _USER_AGENT,
        "locale": "en-US",
        "timezone_id": "America/New_York",
        "extra_http_headers": {
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    }
    if storage_state:
        ctx_kwargs["storage_state"] = storage_state

    # Try real Chrome first; fall back to Playwright Chromium
    for channel in ("chrome", None):
        try:
            kw = dict(launch_kwargs)
            if channel:
                kw["channel"] = channel
                kw["headless"] = headless
            else:
                kw["headless"] = headless
            browser = await pw.chromium.launch(**kw)
            context = await browser.new_context(**ctx_kwargs)
            await context.add_init_script(_STEALTH_SCRIPT)
            browser_logger.info(
                "launch_real_browser: using %s (headless=%s)",
                channel or "playwright-chromium", headless
            )
            return browser, context
        except Exception as exc:
            if channel:
                browser_logger.warning(
                    "launch_real_browser: Chrome channel failed (%s), falling back to Chromium", exc
                )
            else:
                raise


# ── Human-behaviour helpers ───────────────────────────────────────────────────

async def human_delay(lo: float = 1.5, hi: float = 4.0) -> None:
    """Random pause that mimics human reaction time."""
    await asyncio.sleep(random.uniform(lo, hi))


async def human_scroll(page, steps: int = 4) -> None:
    """Scroll down incrementally, pausing between steps."""
    for _ in range(steps):
        delta = random.randint(280, 520)
        await page.evaluate(f"window.scrollBy(0, {delta})")
        await asyncio.sleep(random.uniform(0.4, 0.9))


async def human_type(element, text: str) -> None:
    """Type text with natural character-by-character speed."""
    await element.click()
    await asyncio.sleep(random.uniform(0.3, 0.7))
    for char in text:
        await element.type(char)
        await asyncio.sleep(random.uniform(0.05, 0.18))


async def check_session_alive(page) -> bool:
    """Return True if LinkedIn session is still valid."""
    try:
        await page.goto("https://www.linkedin.com/feed/",
                        wait_until="domcontentloaded", timeout=20000)
        await asyncio.sleep(2)
        url = page.url
        return "feed" in url and "login" not in url and "authwall" not in url
    except Exception:
        return False


# ── Profile data extraction ───────────────────────────────────────────────────

async def fetch_my_profile_data(page, context, session_dir: str = "sessions") -> dict:
    """
    Visit the logged-in user's own LinkedIn profile page (human-like) and extract
    name, headline, profile URL, and avatar image. Avatar is saved to disk.
    Returns a dict with keys: name, headline, profile_url, avatar_path.
    """
    import os
    from pathlib import Path

    result: dict = {"name": None, "headline": None, "profile_url": None, "avatar_path": None}

    try:
        await page.goto("https://www.linkedin.com/in/me/",
                        wait_until="domcontentloaded", timeout=25000)
        await human_delay(2.0, 3.5)  # reading pause — looks human

        # Actual profile URL (redirect resolves /in/me/ → /in/username/)
        result["profile_url"] = page.url.split("?")[0].rstrip("/")

        # Name
        for sel in ["h1.text-heading-xlarge", "h1[data-generated-suggestion-target]", "h1"]:
            el = page.locator(sel).first
            if await el.count() > 0:
                n = (await el.inner_text()).strip()
                if n and len(n) > 1:
                    result["name"] = n
                    break

        # Headline / occupation
        for sel in [
            "div.text-body-medium.break-words",
            "div[data-field='headline']",
            ".pv-text-details__left-panel .text-body-medium",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                h = (await el.inner_text()).strip()
                if h and len(h) > 3:
                    result["headline"] = h
                    break

        # Avatar: try several selectors that LinkedIn has used across versions
        avatar_src: str | None = None
        for sel in [
            "button.pv-top-card__photo-wrapper img",
            "img.pv-top-card-profile-picture__image--show",
            "img.pv-top-card-profile-picture__image",
            "button[aria-label*='photo'] img",
            ".pv-top-card__photo img",
            ".presence-entity__image",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                src = await el.get_attribute("src")
                if src and "media.licdn.com" in src:
                    avatar_src = src
                    break

        # Download avatar using the browser context (carries LinkedIn cookies)
        if avatar_src:
            try:
                resp = await context.request.get(avatar_src)
                if resp.ok:
                    img_bytes = await resp.body()
                    Path(session_dir).mkdir(parents=True, exist_ok=True)
                    avatar_path = Path(session_dir) / "default_avatar.jpg"
                    avatar_path.write_bytes(img_bytes)
                    result["avatar_path"] = str(avatar_path)
                    browser_logger.info("fetch_my_profile_data: avatar saved (%d bytes)", len(img_bytes))
            except Exception as exc:
                browser_logger.warning("fetch_my_profile_data: avatar download failed: %s", exc)

        browser_logger.info(
            "fetch_my_profile_data: name=%s headline=%s url=%s",
            result["name"], result["headline"], result["profile_url"],
        )
    except Exception as exc:
        browser_logger.warning("fetch_my_profile_data: %s", exc)

    return result


async def extract_profile_data(page, profile_url: str) -> dict:
    """
    Navigate to a LinkedIn profile and extract:
    name, title, company, location, about, recent post snippet.
    Used to build a hyper-personalized AI invite message.
    """
    data: dict[str, str] = {
        "name": "", "title": "", "company": "",
        "location": "", "about": "", "recent_post": "",
        "profile_url": profile_url,
    }

    try:
        await page.goto(profile_url, wait_until="domcontentloaded", timeout=30000)
        await human_delay(2.0, 4.0)   # reading time

        # Scroll slowly through the profile like a human reading it
        await human_scroll(page, steps=5)
        await human_delay(1.0, 2.5)

        # Name
        for sel in ["h1.text-heading-xlarge", "h1[data-generated-suggestion-target]", "h1"]:
            el = page.locator(sel).first
            if await el.count() > 0:
                data["name"] = (await el.inner_text()).strip()
                break

        # Title / headline
        for sel in [
            "div.text-body-medium.break-words",
            "div[data-field='headline']",
            ".pv-text-details__left-panel .text-body-medium",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                t = (await el.inner_text()).strip()
                if t and len(t) > 3:
                    data["title"] = t
                    break

        # Company (from experience section)
        for sel in [
            "span[aria-label*='Current company'] span",
            ".pv-text-details__right-panel .hoverable-link-text span",
            "li.pv-position-v2:first-child span.mr1 span[aria-hidden='true']",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                c = (await el.inner_text()).strip()
                if c and len(c) > 1:
                    data["company"] = c
                    break

        # Location
        for sel in [
            "span.text-body-small.inline.t-black--light.break-words",
            ".pv-text-details__left-panel .pb2 span",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                data["location"] = (await el.inner_text()).strip()
                break

        # About section
        for sel in [
            "div[data-generated-suggestion-target*='about'] span[aria-hidden='true']",
            "#about ~ div span[aria-hidden='true']",
            ".pv-shared-text-with-see-more span[aria-hidden='true']",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                about = (await el.inner_text()).strip()
                if len(about) > 20:
                    data["about"] = about[:300]
                    break

        # Recent post / activity (scroll to find it)
        for sel in [
            ".feed-shared-update-v2__description span[dir='ltr']",
            ".occludable-update span[dir='ltr']",
        ]:
            el = page.locator(sel).first
            if await el.count() > 0:
                post = (await el.inner_text()).strip()
                if len(post) > 20:
                    data["recent_post"] = post[:200]
                    break

    except Exception as exc:
        browser_logger.warning("extract_profile_data error: %s", exc)

    return data


# ── AI message generation ─────────────────────────────────────────────────────

def build_personalized_invite(profile_data: dict, template: str | None) -> str:
    """
    Build a personalized LinkedIn connection invite note (max 300 chars).
    Uses the extracted profile data to personalise.
    """
    name    = profile_data.get("name", "").split()[0] if profile_data.get("name") else "there"
    title   = profile_data.get("title", "")
    company = profile_data.get("company", "")
    about   = profile_data.get("about", "")
    post    = profile_data.get("recent_post", "")

    if template:
        msg = (template
               .replace("{{first_name}}", name)
               .replace("{{name}}", profile_data.get("name", name))
               .replace("{{title}}", title)
               .replace("{{company}}", company))
        return msg[:295]

    # Auto-generate based on available data
    if post:
        msg = (f"Hi {name}, I came across your recent post and found it really insightful. "
               f"I work with {title.split()[-1] if title else 'leaders'} like yourself "
               f"and would love to connect!")
    elif company:
        msg = (f"Hi {name}, I noticed your work at {company} and it caught my attention. "
               f"Would love to connect and exchange ideas!")
    elif title:
        msg = (f"Hi {name}, as a fellow {title.split()[0] if title else 'professional'} "
               f"I'd love to connect and learn from your experience!")
    else:
        msg = (f"Hi {name}, I came across your profile and thought we'd have valuable "
               f"things to share. Would love to connect!")

    return msg[:295]


# ── Connect handler (human-like) ──────────────────────────────────────────────

class ConnectHandler:
    async def execute(self, page, payload: dict, lead_url: str | None) -> dict:
        if not lead_url:
            return {"success": False, "error": "lead_url required"}

        note = payload.get("note") or payload.get("message", "")

        browser_logger.info("ConnectHandler | %s", lead_url)

        # ── Warm up session: navigate to feed first so injected cookies activate ──
        # Navigating directly to a profile URL sometimes bypasses cookie activation.
        # The scraper always does this warm-up and never has session issues.
        try:
            await page.goto("https://www.linkedin.com/feed/",
                            wait_until="domcontentloaded", timeout=25000)
            await asyncio.sleep(2.0)
        except Exception:
            pass

        # Quick login check before doing anything else
        current_url = page.url
        if "login" in current_url or "authwall" in current_url or "checkpoint" in current_url:
            browser_logger.warning("ConnectHandler | session expired on feed warmup: %s", current_url)
            return {
                "success": False,
                "session_expired": True,
                "error": "LinkedIn session expired — please reconnect in Settings → LinkedIn",
                "profile": {},
            }

        # Extract live profile data for personalization
        profile_data = await extract_profile_data(page, lead_url)
        browser_logger.info("ConnectHandler | extracted: %s @ %s",
                            profile_data.get("name"), profile_data.get("company"))

        # If no note provided, auto-generate from profile data
        if not note:
            note = build_personalized_invite(profile_data, payload.get("template"))

        # ── Pure JS helpers — zero Playwright locator clicks, zero retries ─────

        async def _js(script: str):
            return await page.evaluate(script)

        async def _btn_exists(text: str) -> bool:
            safe = text.lower().replace("'", "\\'")
            return await _js(f"""() => {{
                const t = '{safe}';
                return [...document.querySelectorAll('button,[role="button"]')].some(
                    b => b.textContent.trim().toLowerCase().includes(t)
                      || (b.getAttribute('aria-label') || '').toLowerCase().includes(t)
                );
            }}""")

        async def _click_btn(text: str) -> bool:
            safe = text.lower().replace("'", "\\'")
            return await _js(f"""() => {{
                const t = '{safe}';
                const btn = [...document.querySelectorAll('button,[role="button"],li,span,[role="option"]')]
                    .find(b => b.textContent.trim().toLowerCase().includes(t)
                             || (b.getAttribute('aria-label') || '').toLowerCase().includes(t));
                if (!btn) return false;
                btn.dispatchEvent(new MouseEvent('mousedown', {{bubbles:true}}));
                btn.dispatchEvent(new MouseEvent('mouseup',   {{bubbles:true}}));
                btn.dispatchEvent(new MouseEvent('click',     {{bubbles:true, cancelable:true}}));
                return true;
            }}""")

        async def _click_sel(selector: str) -> bool:
            sel = selector.replace("'", "\\'")
            return await _js(f"""() => {{
                const el = document.querySelector('{sel}');
                if (!el) return false;
                el.dispatchEvent(new MouseEvent('click', {{bubbles:true, cancelable:true}}));
                return true;
            }}""")

        # ── 1. Dismiss any stray modals / overlays ───────────────────────────
        await page.keyboard.press("Escape")
        await asyncio.sleep(0.4)
        # Dismiss any visible overlay (e.g. LinkedIn's contextual sign-in modal
        # for "See mutual connections") that would intercept clicks on the page.
        await _js("""() => {
            const overlay = document.querySelector(
                '.modal__overlay--visible, .contextual-sign-in, [data-test-modal-id]'
            );
            if (overlay) {
                // Try clicking the close button inside
                const closeBtn = overlay.querySelector(
                    'button[aria-label*="Dismiss"], button[aria-label*="Close"], '
                    + 'button[aria-label*="close"], .modal__dismiss'
                );
                if (closeBtn) closeBtn.click();
            }
        }""")
        await asyncio.sleep(0.3)

        # ── 2. Detect profile status ─────────────────────────────────────────
        page_state = await _js("""() => {
            const btns = [...document.querySelectorAll('button,[role="button"]')];
            const btnTexts = btns.map(b => b.textContent.trim());
            // Authwall detection — LinkedIn shows these when session is expired/not logged in
            const isAuthwall = btnTexts.some(t =>
                t === 'Sign in with Email' || t === 'Sign in' || t === 'Join now'
            ) || !!document.querySelector('.authwall-join-form, #join-form, .join-form__form');
            // Exact-match Connect to avoid partial matches like "See your mutual connections"
            const connectAriaLabels = ['Connect', 'Invite to connect', 'Invite to Connect'];
            return {
                isAuthwall,
                hasConnect:  btns.some(b =>
                    b.textContent.trim() === 'Connect' ||
                    connectAriaLabels.includes(b.getAttribute('aria-label') || '')
                ),
                hasMessage:  btns.some(b => b.textContent.trim() === 'Message'
                                         || (b.getAttribute('aria-label')||'') === 'Message'),
                hasPending:  btns.some(b => ['Pending','Withdraw'].includes(b.textContent.trim())),
                hasFollow:   btns.some(b => b.textContent.trim() === 'Follow'),
                hasMore:     btns.some(b => b.textContent.trim() === 'More'),
            };
        }""")

        # ── 2a. Authwall — session expired ───────────────────────────────────
        if page_state.get("isAuthwall"):
            browser_logger.warning("ConnectHandler | LinkedIn session expired on %s", lead_url)
            return {
                "success": False,
                "session_expired": True,
                "error": "LinkedIn session expired — please reconnect in Settings → LinkedIn",
                "profile": profile_data,
            }

        has_connect = page_state.get("hasConnect", False)

        # Check "More" dropdown for hidden Connect
        if not has_connect and page_state.get("hasMore"):
            await _click_btn("More")
            await asyncio.sleep(0.8)
            # Use exact text match to avoid partial hits like "See your mutual connections"
            has_connect = await _js("""() => {
                return [...document.querySelectorAll('button,[role="button"],li,[role="option"]')]
                    .some(b => b.textContent.trim() === 'Connect');
            }""")

        if not has_connect:
            if page_state.get("hasMessage"):
                browser_logger.info("ConnectHandler | already 1st-degree: %s", lead_url)
                return {"success": False, "already_connected": True,
                        "error": "Already connected (1st degree)", "profile": profile_data}
            if page_state.get("hasPending"):
                return {"success": False, "already_pending": True,
                        "error": "Connection request already pending", "profile": profile_data}
            if page_state.get("hasFollow"):
                return {"success": False, "follow_only": True,
                        "error": "Follow-only profile — connection requests disabled", "profile": profile_data}
            return {"success": False,
                    "error": "Connect button not found — profile may have restricted connections",
                    "profile": profile_data}

        # ── 3. Click Connect via Playwright CDP (trusted event, opens modal) ────
        # Use exact aria-label / role matches — avoid partial :has-text() which
        # case-insensitively matches "See your mutual connections" as a Connect button.
        connect_btn = page.get_by_role("button", name="Connect", exact=True).first
        if await connect_btn.count() == 0:
            connect_btn = page.get_by_role("button", name="Invite to connect", exact=True).first
        if await connect_btn.count() == 0:
            connect_btn = page.locator("button[aria-label='Connect']").first
        if await connect_btn.count() == 0:
            connect_btn = page.locator("button[aria-label='Invite to connect']").first

        if await connect_btn.count() == 0:
            return {"success": False, "error": "Connect button not found (locator)", "profile": profile_data}

        try:
            await connect_btn.click(timeout=8000)
        except Exception as exc:
            # Overlay may still be intercepting — try force click as fallback
            browser_logger.warning("ConnectHandler | Connect click intercepted (%s), retrying force", exc)
            try:
                await connect_btn.click(timeout=5000, force=True)
            except Exception as exc2:
                browser_logger.warning("ConnectHandler | Connect force-click also failed: %s", exc2)
                return {"success": False, "error": f"Connect click failed: {exc2}", "profile": profile_data}

        await asyncio.sleep(3.0)  # wait for modal animation

        # ── 4. Find the modal (any visible dialog) ────────────────────────────
        async def _find_modal():
            return await _js("""() => {
                const candidates = [
                    ...document.querySelectorAll(
                        '.artdeco-modal, [role="dialog"], [role="alertdialog"], [data-test-modal], .connect-button-send-invite, .send-invite'
                    )
                ];
                const modal = candidates.find(el => {
                    const r = el.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
                if (!modal) return null;
                return {
                    hasTextarea: !!modal.querySelector('textarea, [contenteditable="true"]'),
                    btns: [...modal.querySelectorAll('button')].map(b => ({
                        text:  b.textContent.trim(),
                        label: b.getAttribute('aria-label') || '',
                        cls:   b.className.substring(0, 60),
                    })),
                };
            }""")

        modal_info = await _find_modal()
        if not modal_info:
            await asyncio.sleep(2.0)   # one more wait and retry
            modal_info = await _find_modal()

        browser_logger.info("ConnectHandler | modal=%s", modal_info)

        if not modal_info:
            # LinkedIn sometimes sends the request immediately (no-note flow) without
            # showing a modal. Detect this by checking if the button state changed.
            silent_state = await _js("""() => {
                const btns = [...document.querySelectorAll('button,[role="button"]')];
                return {
                    hasPending: btns.some(b => ['Pending','Withdraw'].includes(b.textContent.trim())),
                    hasMessage: btns.some(b => b.textContent.trim() === 'Message'),
                    hasSentToast: !!document.querySelector('[data-test-artdeco-toast-item]'),
                };
            }""")
            if silent_state and (silent_state.get("hasPending") or silent_state.get("hasSentToast")):
                browser_logger.info("ConnectHandler | silent send detected for %s", lead_url)
                return {"success": True, "action": "CONNECT",
                        "lead_url": lead_url, "note_sent": "", "profile": profile_data}
            return {"success": False, "error": "Modal did not open after clicking Connect", "profile": profile_data}

        # ── 5. Add a note ────────────────────────────────────────────────────
        note_sent = ""
        if note:
            if not modal_info.get("hasTextarea"):
                await _click_btn("Add a note")
                await asyncio.sleep(1.0)

            # Focus textarea via JS, then type via Playwright keyboard
            # (keyboard events are React-compatible and don't need pointer-event access)
            focused = await _js("""() => {
                const ta = document.querySelector(
                    '.artdeco-modal textarea, [role="dialog"] textarea, textarea'
                );
                if (!ta) return false;
                ta.focus();
                return true;
            }""")

            if focused:
                await page.keyboard.press("Control+a")
                await page.keyboard.press("Delete")
                await asyncio.sleep(0.2)
                for char in note[:295]:
                    await page.keyboard.type(char, delay=random.randint(65, 175))
                await asyncio.sleep(0.5)
                note_sent = note

        # ── 6. Find and click Send — search whole page, return debug info ────────
        send_result = await _js("""() => {
            const allBtns = [...document.querySelectorAll('button')];
            // Candidates: visible, enabled, text/label contains 'send'
            const candidates = allBtns.filter(b => {
                if (b.disabled) return false;
                const rect = b.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const t = (b.textContent || '').trim().toLowerCase();
                const l = (b.getAttribute('aria-label') || '').toLowerCase();
                return t.includes('send') || l.includes('send');
            });
            if (candidates.length > 0) {
                candidates[0].dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}));
                return { clicked: true, text: candidates[0].textContent.trim() };
            }
            // Debug: list every visible button text
            const visibleTexts = allBtns
                .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !b.disabled; })
                .map(b => (b.textContent.trim() || b.getAttribute('aria-label') || '').substring(0, 30))
                .filter(t => t.length > 0);
            return { clicked: false, buttons: visibleTexts };
        }""")

        browser_logger.info("ConnectHandler | send_result=%s", send_result)

        if send_result and send_result.get("clicked"):
            await asyncio.sleep(2.0)
            browser_logger.info("ConnectHandler | sent to %s via '%s'",
                                 profile_data.get("name"), send_result.get("text"))
            return {"success": True, "action": "CONNECT",
                    "lead_url": lead_url, "note_sent": note_sent, "profile": profile_data}

        visible = (send_result or {}).get("buttons", [])
        btn_summary = " | ".join(visible[:12]) if visible else "none"
        browser_logger.warning("ConnectHandler | Send failed. Visible buttons: %s", btn_summary)
        return {"success": False,
                "error": f"No Send button. Page buttons: {btn_summary[:180]}",
                "profile": profile_data}


class MessageHandler:
    async def execute(self, page, payload: dict, lead_url: str | None) -> dict:
        if not lead_url:
            return {"success": False, "error": "lead_url required for MESSAGE"}

        message = payload.get("message", "")
        if not message:
            return {"success": False, "error": "message body required"}

        browser_logger.info("MessageHandler | %s", lead_url)
        await page.goto(lead_url, wait_until="domcontentloaded", timeout=30000)
        await human_delay(2.0, 4.0)

        msg_btn = page.locator("button:has-text('Message'), a:has-text('Message')").first
        if await msg_btn.count() == 0:
            return {"success": False, "error": "Message button not found"}

        await msg_btn.click()
        await human_delay(1.5, 3.0)

        for sel in ["div.msg-form__contenteditable", "div[role='textbox']", "div[contenteditable='true']"]:
            box = page.locator(sel).first
            if await box.count() > 0:
                await human_type(box, message)
                await human_delay(0.8, 2.0)
                break

        for sel in ["button.msg-form__send-button", "button[type='submit']", "button:has-text('Send')"]:
            send = page.locator(sel).first
            if await send.count() > 0:
                await send.click()
                await human_delay(1.0, 2.5)
                return {"success": True, "action": "MESSAGE"}

        return {"success": False, "error": "Send button not found"}


class FollowUpHandler:
    async def execute(self, page, payload: dict, lead_url: str | None) -> dict:
        return await MessageHandler().execute(page, payload, lead_url)


class ViewProfileHandler:
    async def execute(self, page, payload: dict, lead_url: str | None) -> dict:
        if not lead_url:
            return {"success": False, "error": "lead_url required"}
        profile_data = await extract_profile_data(page, lead_url)
        return {"success": True, "action": "VIEW_PROFILE", "profile": profile_data}


# ── Profile Scraper (human-like, unlimited pages) ─────────────────────────────

class ProfileScraperHandler:
    """
    Scrapes LinkedIn people search / Sales Navigator results.
    Scrolls naturally, no artificial page limit (fetches everything visible).
    """

    async def _ensure_logged_in(self, page) -> bool:
        """
        If LinkedIn shows the login page, auto-click 'Continue as [Name]' (Google SSO)
        or 'Sign in as [Name]' so scraping can proceed without manual interaction.
        Returns True if we're logged in (or already were), False if login failed.
        """
        await asyncio.sleep(2)

        url = page.url
        is_login_page = (
            "login" in url or "authwall" in url or "checkpoint" in url
            or await page.locator("text=Welcome to your professional network").count() > 0
            or await page.locator("input#username").count() > 0
        )
        if not is_login_page:
            return True

        browser_logger.info("_ensure_logged_in: login page detected, trying auto-login")

        # Try Google SSO "Continue as [Name]" — works if Google account is signed in Chrome
        for sel in [
            "a[data-litms-control-urn*='continue-google']",
            "a[href*='uas/login-utils/csrf']",
            "button:has-text('Continue as')",
            "a:has-text('Continue as')",
        ]:
            btn = page.locator(sel).first
            if await btn.count() > 0:
                browser_logger.info("_ensure_logged_in: clicking Google SSO button")
                await btn.click()
                await asyncio.sleep(6)
                if "feed" in page.url or "mynetwork" in page.url or "checkpoint" not in page.url:
                    browser_logger.info("_ensure_logged_in: Google SSO success → %s", page.url)
                    return True
                break

        # Try email "Sign in as [Name]" button
        for sel in ["button:has-text('Sign in as')", "a:has-text('Sign in as')"]:
            btn = page.locator(sel).first
            if await btn.count() > 0:
                browser_logger.info("_ensure_logged_in: clicking email sign-in button")
                await btn.click()
                await asyncio.sleep(6)
                if "feed" in page.url or "mynetwork" in page.url:
                    return True
                break

        browser_logger.warning("_ensure_logged_in: could not auto-login")
        return False

    async def scrape(
        self,
        page,
        search_url: str,
        max_profiles: int = 500,
        progress_callback=None,
    ) -> dict:
        browser_logger.info("ProfileScraperHandler | url=%s max=%d", search_url, max_profiles)

        is_sales_nav = "/sales/search/" in search_url

        # Navigate to LinkedIn feed first — lets injected cookies activate
        # before loading a search/Sales Nav URL
        await page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=30000)
        await human_delay(2.0, 3.5)

        # If not logged in, try Google SSO auto-login (uses saved Chrome account)
        logged_in = await self._ensure_logged_in(page)
        if not logged_in:
            return {
                "success": False,
                "error": (
                    "LinkedIn session not found. Please connect LinkedIn via "
                    "Settings → LinkedIn (use the extension or popup login), then try again."
                ),
                "profiles": [],
            }

        # Now navigate to the actual search URL
        await page.goto(search_url, wait_until="domcontentloaded", timeout=35000)
        await human_delay(3.0, 5.0)

        if "login" in page.url or "authwall" in page.url or "checkpoint" in page.url:
            return {"success": False, "error": "LinkedIn session expired. Please reconnect via Settings → LinkedIn.", "profiles": []}

        # Detect account chooser
        try:
            chooser = await page.locator(
                "h1:has-text('Choose an account'), h2:has-text('Choose an account')"
            ).count() > 0
        except Exception:
            chooser = False
        if chooser:
            return {
                "success": False,
                "error": "LinkedIn is showing the account chooser. Go to Settings → LinkedIn → Disconnect, then reconnect with a single account.",
                "profiles": [],
            }

        profiles: list[dict] = []
        page_num = 0

        while len(profiles) < max_profiles:
            page_num += 1
            browser_logger.info("Scraper | page %d | total so far: %d", page_num, len(profiles))

            # Human scroll through results
            await human_scroll(page, steps=6)
            await human_delay(1.5, 3.0)

            if is_sales_nav:
                page_profiles = await self._extract_sales_nav(page)
            else:
                page_profiles = await self._extract_people_search(page)

            seen = {p["linkedin_url"] for p in profiles}
            new_profiles = [p for p in page_profiles if p.get("linkedin_url") and p["linkedin_url"] not in seen]
            new_profiles = new_profiles[:max_profiles - len(profiles)]
            profiles.extend(new_profiles)

            browser_logger.info("Scraper | page %d extracted %d new profiles", page_num, len(new_profiles))

            # Fire progress callback so callers get partial results live
            if progress_callback and new_profiles:
                try:
                    progress_callback(len(profiles), page_num, new_profiles)
                except Exception:
                    pass

            if not new_profiles:
                browser_logger.info("Scraper | no new profiles on page %d, stopping", page_num)
                break

            if len(profiles) >= max_profiles:
                break

            # Go to next page
            went = await self._next_page(page, is_sales_nav)
            if not went:
                browser_logger.info("Scraper | no more pages after page %d", page_num)
                break

            await human_delay(3.0, 6.0)  # human pause between pages

        browser_logger.info("Scraper | done. %d profiles across %d pages", len(profiles), page_num)
        return {"success": True, "profiles": profiles, "pages_scraped": page_num}

    async def _extract_people_search(self, page) -> list[dict]:
        profiles = []
        # LinkedIn changes class names frequently — try many selectors
        selectors = [
            "li.reusable-search__result-container",
            "li.search-results__result-item",
            "div.entity-result",
            "li[data-view-name='search-results-result-item']",
            "[data-view-name='search-results'] li",
            "ul.reusable-search__entity-result-list > li",
            "div[data-chameleon-result-urn] ",
        ]
        cards = []
        for sel in selectors:
            found = await page.locator(sel).all()
            if found:
                cards = found
                browser_logger.info("people search: %d cards via '%s'", len(cards), sel)
                break

        for card in cards:
            try:
                p = await self._parse_person_card(card)
                if p and p.get("linkedin_url"):
                    profiles.append(p)
            except Exception as e:
                browser_logger.debug("card parse error: %s", e)

        # Fallback: extract from raw profile links on the page
        if not profiles:
            browser_logger.warning("people search: no cards matched, trying link fallback")
            profiles = await self._fallback_link_extract(page, "linkedin_search")

        return profiles

    async def _parse_person_card(self, card) -> dict | None:
        # Profile URL
        href = ""
        for sel in ["a[href*='/in/']", "a.app-aware-link[href*='/in/']"]:
            link = card.locator(sel).first
            if await link.count() > 0:
                href = (await link.get_attribute("href") or "").split("?")[0].rstrip("/")
                if "/in/" in href:
                    break
        if not href or "/in/" not in href:
            return None

        # Name
        name = ""
        for sel in [
            "span.entity-result__title-text > a > span[aria-hidden='true']",
            "span[aria-hidden='true']",
            ".entity-result__title-text",
        ]:
            el = card.locator(sel).first
            if await el.count() > 0:
                n = (await el.inner_text()).strip()
                if n and len(n) > 1 and not n.startswith("LinkedIn"):
                    name = n
                    break
        if not name:
            return None

        # Title
        title = ""
        for sel in ["div.entity-result__primary-subtitle", ".entity-result__summary"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                title = (await el.inner_text()).strip()
                if title:
                    break

        # Company
        company = ""
        el = card.locator("div.entity-result__secondary-subtitle").first
        if await el.count() > 0:
            company = (await el.inner_text()).strip()

        # Location
        location = ""
        for sel in ["div.entity-result__simple-insight-text", ".entity-result__simple-insight span"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                location = (await el.inner_text()).strip()
                if location:
                    break

        # Connection degree (1st, 2nd, 3rd)
        connection_degree = ""
        for sel in [
            "span.dist-value",
            "span[aria-label*='degree connection']",
            ".entity-result__badge span",
        ]:
            el = card.locator(sel).first
            if await el.count() > 0:
                deg = (await el.inner_text()).strip()
                if deg and ("1st" in deg or "2nd" in deg or "3rd" in deg or "st" in deg or "nd" in deg or "rd" in deg):
                    connection_degree = deg
                    break

        # Mutual connections
        mutual_connections = ""
        for sel in [
            "button.entity-result__badge-action",
            "span[aria-label*='mutual connection']",
            ".entity-result__badge-text",
            "button[aria-label*='mutual']",
        ]:
            el = card.locator(sel).first
            if await el.count() > 0:
                mc = (await el.inner_text()).strip()
                if mc and "mutual" in mc.lower():
                    mutual_connections = mc
                    break

        # Open to work
        is_open_to_work = False
        for sel in [".open-to-work-badge", "img[alt*='Open to Work']", "span.artdeco-entity-lockup__badge"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                badge_text = (await el.inner_text()).strip()
                if "open" in badge_text.lower():
                    is_open_to_work = True
                    break

        # Premium member
        is_premium = False
        for sel in ["li-icon[type='linkedin-premium']", ".member-badge--premium", "img[alt*='Premium']"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                is_premium = True
                break

        return {
            "name": name, "title": title, "company": company,
            "location": location, "linkedin_url": href,
            "profile_id": href.split("/in/")[-1].rstrip("/"),
            "connection_degree": connection_degree,
            "source": "linkedin_search",
            "mutual_connections": mutual_connections,
            "is_open_to_work": is_open_to_work,
            "is_premium": is_premium,
            "company_size": "",
            "industry": "",
            "seniority": "",
        }

    async def _extract_sales_nav(self, page) -> list[dict]:
        profiles = []

        # Check for Sales Navigator access gate (needs premium)
        gate = await page.locator(
            "h1:has-text('Upgrade'), button:has-text('Try for free'), "
            "div:has-text('Sales Navigator is available')"
        ).count() > 0
        if gate:
            browser_logger.warning("Sales Navigator: premium/upgrade gate detected")
            return []

        selectors = [
            "li[data-view-name='search-result-entity-result-item']",
            "li[class*='ember-view'][class*='artdeco']",
            "li.artdeco-list__item",
            "ol.artdeco-list > li",
            "ul[class*='list'] > li",
            "[data-anonymize='person-name']",
        ]
        cards = []
        for sel in selectors:
            found = await page.locator(sel).all()
            if found:
                cards = found
                browser_logger.info("Sales Nav: %d cards via '%s'", len(cards), sel)
                break

        for card in cards:
            try:
                p = await self._parse_sales_nav_card(card)
                if p and p.get("linkedin_url"):
                    profiles.append(p)
            except Exception as e:
                browser_logger.debug("SalesNav card error: %s", e)

        # Fallback if nothing matched
        if not profiles:
            browser_logger.warning("Sales Nav: no cards matched, trying link fallback")
            profiles = await self._fallback_link_extract(page, "sales_navigator")

        return profiles

    async def _parse_sales_nav_card(self, card) -> dict | None:
        href = ""
        for sel in [
            "a[data-anonymize='person-name']",
            "a[href*='/sales/lead/']",
            "a[href*='/in/']",
        ]:
            link = card.locator(sel).first
            if await link.count() > 0:
                href = (await link.get_attribute("href") or "").split("?")[0].rstrip("/")
                if href:
                    break
        if not href:
            return None

        name = ""
        for sel in ["span[data-anonymize='person-name']", ".artdeco-entity-lockup__title span"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                name = (await el.inner_text()).strip()
                if name:
                    break
        if not name:
            return None

        title = ""
        for sel in ["span[data-anonymize='title']", ".artdeco-entity-lockup__subtitle span"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                title = (await el.inner_text()).strip()
                if title:
                    break

        company = ""
        for sel in ["span[data-anonymize='company-name']", ".artdeco-entity-lockup__caption span"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                company = (await el.inner_text()).strip()
                if company:
                    break

        location = ""
        el = card.locator("span[data-anonymize='location']").first
        if await el.count() > 0:
            location = (await el.inner_text()).strip()

        # Company size (employees)
        company_size = ""
        for sel in ["span[data-anonymize='company-size']", ".artdeco-entity-lockup__badge"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                cs = (await el.inner_text()).strip()
                if cs:
                    company_size = cs
                    break

        # Industry
        industry = ""
        for sel in ["span[data-anonymize='industry']", "[data-test-search-result-insight] span"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                ind = (await el.inner_text()).strip()
                if ind:
                    industry = ind
                    break

        # Seniority level
        seniority = ""
        el = card.locator("span[data-anonymize='seniority']").first
        if await el.count() > 0:
            seniority = (await el.inner_text()).strip()

        # Mutual connections
        mutual_connections = ""
        for sel in ["a[data-anonymize='person-name'][aria-label*='mutual']", "span[aria-label*='mutual']"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                mc = (await el.inner_text()).strip()
                if mc:
                    mutual_connections = mc
                    break

        # Connection degree
        connection_degree = ""
        for sel in ["span[data-anonymize='degree']", ".degree-badge"]:
            el = card.locator(sel).first
            if await el.count() > 0:
                deg = (await el.inner_text()).strip()
                if deg:
                    connection_degree = deg
                    break

        # Profile ID from URL
        profile_id = ""
        if "/sales/lead/" in href:
            profile_id = href.split("/sales/lead/")[-1].rstrip("/")
        elif "/in/" in href:
            profile_id = href.split("/in/")[-1].rstrip("/")

        return {
            "name": name, "title": title, "company": company,
            "location": location, "linkedin_url": href,
            "profile_id": profile_id,
            "connection_degree": connection_degree,
            "source": "sales_navigator",
            "mutual_connections": mutual_connections,
            "is_open_to_work": False,
            "is_premium": False,
            "company_size": company_size,
            "industry": industry,
            "seniority": seniority,
        }

    async def _fallback_link_extract(self, page, source: str) -> list[dict]:
        """
        Last-resort extractor: find ALL LinkedIn profile links visible on the page
        and pull name/title from surrounding text. Used when card selectors don't match.
        """
        profiles = []
        seen: set[str] = set()

        link_sel = "a[href*='/in/']" if source == "linkedin_search" else "a[href*='/in/'], a[href*='/sales/lead/']"
        links = await page.locator(link_sel).all()
        browser_logger.info("_fallback_link_extract: found %d raw links", len(links))

        for link in links:
            try:
                href = (await link.get_attribute("href") or "").split("?")[0].rstrip("/")
                if not href or href in seen:
                    continue
                if "/in/" not in href and "/sales/lead/" not in href:
                    continue
                # Skip nav/sidebar links
                if any(x in href for x in ["/in/me", "linkedin.com/in/rahul", "mynetwork"]):
                    continue

                name = (await link.inner_text()).strip()
                if not name or len(name) < 2 or name.lower() in ("linkedin", "you", ""):
                    continue

                seen.add(href)

                # Try to grab title/company from nearby siblings
                title = company = location = ""
                try:
                    parent_text = (await link.locator("xpath=../../../..").inner_text()).strip()
                    lines = [l.strip() for l in parent_text.split("\n") if l.strip() and l.strip() != name]
                    if lines:
                        title = lines[0] if len(lines) > 0 else ""
                        company = lines[1] if len(lines) > 1 else ""
                        location = lines[2] if len(lines) > 2 else ""
                except Exception:
                    pass

                profile_id = href.split("/in/")[-1].rstrip("/") if "/in/" in href else href.split("/sales/lead/")[-1].rstrip("/")
                profiles.append({
                    "name": name, "title": title, "company": company,
                    "location": location, "linkedin_url": href,
                    "profile_id": profile_id, "connection_degree": "",
                    "source": source,
                    "mutual_connections": "", "is_open_to_work": False,
                    "is_premium": False, "company_size": "", "industry": "", "seniority": "",
                })
            except Exception as e:
                browser_logger.debug("fallback_link_extract error: %s", e)

        browser_logger.info("_fallback_link_extract: extracted %d profiles", len(profiles))
        return profiles

    async def _next_page(self, page, is_sales_nav: bool) -> bool:
        selectors = [
            "button[aria-label='Next']",
            "button.artdeco-pagination__button--next",
            "button[aria-label*='next' i]",
        ]
        if is_sales_nav:
            selectors.insert(0, "button[data-test-pagination-page-btn='next']")

        for sel in selectors:
            btn = page.locator(sel).first
            if await btn.count() == 0:
                continue
            disabled = await btn.get_attribute("disabled")
            aria_disabled = await btn.get_attribute("aria-disabled")
            if disabled is not None or aria_disabled == "true":
                return False
            try:
                await btn.click()
                await page.wait_for_load_state("domcontentloaded", timeout=15000)
                await human_delay(2.0, 4.0)
                return True
            except Exception as e:
                browser_logger.debug("next page error: %s", e)

        return False


# ── Inbox poller ──────────────────────────────────────────────────────────────

class InboxPollerHandler:
    async def poll(self, page) -> dict:
        browser_logger.info("InboxPollerHandler | polling inbox")
        result = {"accepted_profiles": [], "new_messages": []}

        # Check accepted connections
        try:
            await page.goto(
                "https://www.linkedin.com/mynetwork/invitation-manager/sent/",
                wait_until="domcontentloaded", timeout=30000
            )
            await human_delay(2.0, 4.0)
            await human_scroll(page, steps=3)

            cards = await page.locator(
                "li.invitation-card, li[data-test-invitation-id]"
            ).all()

            for card in cards:
                try:
                    status_el = card.locator("span:has-text('Connected'), span:has-text('Connections')")
                    if await status_el.count() > 0:
                        link = card.locator("a[href*='/in/']").first
                        if await link.count() > 0:
                            href = (await link.get_attribute("href") or "").split("?")[0].rstrip("/")
                            if href and href not in result["accepted_profiles"]:
                                result["accepted_profiles"].append(href)
                except Exception:
                    pass
        except Exception as exc:
            browser_logger.warning("InboxPoller | invitations error: %s", exc)

        # Check inbox for new messages
        try:
            await page.goto("https://www.linkedin.com/messaging/",
                            wait_until="domcontentloaded", timeout=30000)
            await human_delay(2.0, 4.0)

            conv_items = await page.locator(
                "li.msg-conversation-listitem, li[data-test-conversation-id]"
            ).all()

            for item in conv_items[:20]:
                try:
                    unread = item.locator(
                        ".notification-badge, [data-test-unread-count], "
                        "span.msg-conversation-card__unread-count"
                    )
                    if await unread.count() == 0:
                        continue

                    name_el = item.locator(
                        ".msg-conversation-listitem__participant-names, "
                        "h3.msg-conversation-card__row"
                    ).first
                    sender_name = (await name_el.inner_text()).strip() if await name_el.count() > 0 else ""

                    preview_el = item.locator(".msg-conversation-card__message-snippet").first
                    preview = (await preview_el.inner_text()).strip() if await preview_el.count() > 0 else ""

                    link_el = item.locator("a[href*='/messaging/thread/']").first
                    thread_id = ""
                    if await link_el.count() > 0:
                        thread_url = await link_el.get_attribute("href") or ""
                        thread_id = thread_url.rstrip("/").split("/")[-1]

                    if sender_name and preview:
                        await item.click()
                        await human_delay(1.5, 3.0)

                        full_body = preview
                        msg_els = await page.locator(
                            ".msg-s-message-list__event, .msg-s-event-listitem--other"
                        ).all()
                        if msg_els:
                            body_el = msg_els[-1].locator(".msg-s-event__content, p").first
                            if await body_el.count() > 0:
                                full_body = (await body_el.inner_text()).strip()

                        profile_link = page.locator("a.msg-thread__link-to-profile").first
                        profile_url = ""
                        if await profile_link.count() > 0:
                            profile_url = (await profile_link.get_attribute("href") or "").split("?")[0]

                        result["new_messages"].append({
                            "profile_url": profile_url,
                            "thread_id": thread_id,
                            "sender_name": sender_name,
                            "body": full_body,
                        })
                except Exception:
                    pass
        except Exception as exc:
            browser_logger.warning("InboxPoller | messaging error: %s", exc)

        browser_logger.info(
            "InboxPoller | done: %d accepts, %d messages",
            len(result["accepted_profiles"]), len(result["new_messages"])
        )
        return result


# ── LinkedIn login handler ────────────────────────────────────────────────────

class LinkedInLoginHandler:
    async def login(self, page, email: str, password: str) -> dict:
        await page.goto("https://www.linkedin.com/login", wait_until="domcontentloaded", timeout=30000)
        await human_delay(1.5, 3.0)
        await page.fill("#username", email)
        await human_delay(0.5, 1.0)
        await page.fill("#password", password)
        await human_delay(0.8, 1.5)
        await page.click("button[type='submit']")
        await human_delay(3.0, 5.0)

        url = page.url
        if "checkpoint" in url or "challenge" in url:
            return {"success": False, "requires_2fa": True, "url": url}
        if "feed" in url or "mynetwork" in url:
            return {"success": True, "storage_state": await page.context.storage_state()}

        try:
            await page.wait_for_selector("nav.global-nav, div.feed-identity-module", timeout=8000)
            return {"success": True, "storage_state": await page.context.storage_state()}
        except Exception:
            pass

        return {"success": False, "error": "Login failed", "url": url}

    async def submit_2fa(self, page, code: str) -> dict:
        try:
            inp = page.locator("input[name='pin'], input#input__email_verification_pin, input[type='text']").first
            await human_type(inp, code)
            btn = page.locator("button[type='submit'], button:has-text('Verify'), button:has-text('Submit')").first
            await btn.click()
            await human_delay(3.0, 5.0)

            if "feed" in page.url:
                return {"success": True, "storage_state": await page.context.storage_state()}
            return {"success": False, "error": "2FA failed", "url": page.url}
        except Exception as exc:
            return {"success": False, "error": str(exc)}


# ── Browser service ───────────────────────────────────────────────────────────

class BrowserService:
    def __init__(self, headless: bool = True, slow_mo: int = 0) -> None:
        self.headless = headless
        self.slow_mo  = slow_mo

    async def run_action(
        self,
        action_type: ActionType,
        payload: dict[str, Any],
        lead_url: str | None = None,
        storage_state: dict | None = None,
    ) -> dict[str, Any]:
        from playwright.async_api import async_playwright

        handlers = {
            ActionType.CONNECT:      ConnectHandler(),
            ActionType.MESSAGE:      MessageHandler(),
            ActionType.FOLLOWUP:     FollowUpHandler(),
            ActionType.VIEW_PROFILE: ViewProfileHandler(),
        }
        handler = handlers.get(action_type)
        if not handler:
            return {"success": False, "error": f"No handler for {action_type}"}

        async with async_playwright() as pw:
            browser, context = await launch_real_browser(
                pw, storage_state=storage_state, headless=self.headless
            )
            page = await context.new_page()
            try:
                result = await handler.execute(page, payload, lead_url)
            except Exception as exc:
                browser_logger.exception("Handler %s raised: %s", action_type, exc)
                result = {"success": False, "error": str(exc)}
            finally:
                await context.close()
                await browser.close()
        return result

    def run_action_sync(self, action_type, payload, lead_url=None, storage_state=None):
        return asyncio.run(self.run_action(action_type, payload, lead_url, storage_state))
