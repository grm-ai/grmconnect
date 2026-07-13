const API_URL = 'http://localhost:8000';
const API_KEY = 'dev-secret-key-change-me';

// Cached after init() so connectSession() reuses it without a second API call
let _cachedProfile = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function show(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const el = document.getElementById('panel-' + id);
  if (el) el.classList.add('active');
}

function randomDelay(lo = 400, hi = 1200) {
  return new Promise(r => setTimeout(r, Math.floor(Math.random() * (hi - lo)) + lo));
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

function getLinkedInCookies() {
  return new Promise(resolve =>
    chrome.cookies.getAll({ domain: '.linkedin.com' }, resolve)
  );
}

function getCsrfToken(cookies) {
  const c = cookies.find(c => c.name === 'JSESSIONID');
  return c ? c.value.replace(/"/g, '') : '';
}

function buildCookieHeader(cookies) {
  return cookies
    .filter(c => c.domain && c.domain.includes('linkedin.com'))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

// ── LinkedIn profile via Voyager API ──────────────────────────────────────────
// Called from the user's own browser (same IP as the LinkedIn session) so it
// looks indistinguishable from a normal page load.

function _extractName(data) {
  // Format A: data.miniProfile.firstName.text  (older normalized)
  const mini = data?.miniProfile;
  if (mini) {
    const fn = typeof mini.firstName === 'object' ? (mini.firstName?.text ?? '') : (mini.firstName ?? '');
    const ln = typeof mini.lastName  === 'object' ? (mini.lastName?.text  ?? '') : (mini.lastName  ?? '');
    const hl = typeof mini.occupation === 'object' ? (mini.occupation?.text ?? '') : (mini.occupation ?? '');
    if (fn || ln) return { name: `${fn} ${ln}`.trim(), headline: hl, publicId: mini.publicIdentifier ?? '' };
  }

  // Format B: data.data.firstName  (newer direct-string format)
  const d = data?.data;
  if (d && (d.firstName || d.lastName)) {
    const fn = typeof d.firstName === 'object' ? (d.firstName?.text ?? '') : (d.firstName ?? '');
    const ln = typeof d.lastName  === 'object' ? (d.lastName?.text  ?? '') : (d.lastName  ?? '');
    const hl = d.headline ?? d.occupation ?? '';
    return { name: `${fn} ${ln}`.trim(), headline: hl, publicId: d.publicIdentifier ?? '' };
  }

  // Format C: first item in data.included that has firstName
  const items = data?.included ?? [];
  for (const item of items) {
    if (!item.firstName && !item.lastName) continue;
    const fn = typeof item.firstName === 'object' ? (item.firstName?.text ?? '') : (item.firstName ?? '');
    const ln = typeof item.lastName  === 'object' ? (item.lastName?.text  ?? '') : (item.lastName  ?? '');
    const hl = item.occupation ?? item.headline ?? '';
    if (fn || ln) return { name: `${fn} ${ln}`.trim(), headline: hl, publicId: item.publicIdentifier ?? '' };
  }

  return null;
}

async function getLinkedInProfile(cookies) {
  try {
    const csrf = getCsrfToken(cookies);
    if (!csrf) return null;

    const res = await fetch('https://www.linkedin.com/voyager/api/me', {
      credentials: 'include',
      headers: {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'accept-language': 'en-US,en;q=0.9',
        'csrf-token': csrf,
        'x-restli-protocol-version': '2.0.0',
        'x-li-lang': 'en_US',
        'x-li-track': JSON.stringify({
          clientVersion: '1.13.1575',
          osName: 'web',
          timezoneOffset: -(new Date().getTimezoneOffset() / 60),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          deviceFormFactor: 'DESKTOP',
          mpName: 'voyager-web',
        }),
      },
    });

    if (!res.ok) return null;
    const data = await res.json();
    return _extractName(data);
  } catch (_) {
    return null;
  }
}

// ── Init: check session + prefetch profile ────────────────────────────────────

async function init() {
  show('checking');
  _cachedProfile = null;

  try {
    const cookies = await getLinkedInCookies();
    const liAt = cookies.find(c => c.name === 'li_at');

    if (!liAt?.value) {
      show('not-logged-in');
      return;
    }

    // Fetch profile from LinkedIn in the user's own browser — same IP, fully safe
    const profile = await getLinkedInProfile(cookies);
    _cachedProfile = profile;

    const displayName = profile?.name || 'LinkedIn User';
    const headline    = profile?.headline || '';

    document.getElementById('avatar').textContent   = displayName[0]?.toUpperCase() ?? 'L';
    document.getElementById('user-name').textContent = displayName;

    const headlineEl = document.getElementById('user-headline');
    if (headlineEl) {
      headlineEl.textContent = headline;
      headlineEl.style.display = headline ? '' : 'none';
    }

    show('ready');
  } catch (err) {
    showError('Error checking session: ' + err.message);
  }
}

// ── Connect: send cookies + pre-fetched profile to backend ───────────────────
// The profile was already verified in the user's browser above, so the backend
// doesn't need to launch any browser or make any LinkedIn calls itself.

async function connectSession() {
  show('checking');
  try {
    const cookies = await getLinkedInCookies();
    const liAt = cookies.find(c => c.name === 'li_at');
    if (!liAt?.value) { show('not-logged-in'); return; }

    // Small random pause — mimics the time a human takes to think before clicking
    await randomDelay(600, 1800);

    const storageState = {
      cookies: cookies.map(c => ({
        name:     c.name,
        value:    c.value,
        domain:   c.domain.startsWith('.') ? c.domain : '.' + c.domain,
        path:     c.path || '/',
        expires:  c.expirationDate ? Math.floor(c.expirationDate) : -1,
        httpOnly: c.httpOnly  || false,
        secure:   c.secure    || false,
        sameSite: 'None',
      })),
      origins: [{ origin: 'https://www.linkedin.com', localStorage: [] }],
    };

    let response;
    try {
      response = await fetch(`${API_URL}/linkedin/save-session`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key':    API_KEY,
        },
        body: JSON.stringify({
          storage_state:    storageState,
          account_name:     'default',
          // Pre-verified profile from the user's own browser — no server-side
          // LinkedIn calls needed, avoids bot detection from IP mismatch
          profile_name:     _cachedProfile?.name     ?? null,
          profile_headline: _cachedProfile?.headline ?? null,
        }),
      });
    } catch (_) {
      showError(
        'Cannot reach LeadPilot backend.\n\n' +
        'Run this command first:\ncd backend\npython run_dev.py'
      );
      return;
    }

    const result = await response.json();

    if (result.success) {
      const name     = result.data?.linkedin_name     || _cachedProfile?.name || 'LinkedIn User';
      const headline = result.data?.linkedin_headline || _cachedProfile?.headline || '';

      const textEl = document.querySelector('#panel-success .status-text');
      if (textEl) {
        textEl.innerHTML =
          `<strong>Connected as ${escHtml(name)}!</strong><br/>` +
          (headline ? `<span style="font-size:11px;color:#888">${escHtml(headline)}</span><br/><br/>` : '') +
          'Session saved. LeadPilot can now automate LinkedIn on your behalf.';
      }
      show('success');
    } else {
      showError(result.message || 'Backend error.');
    }

  } catch (err) {
    showError(err.message);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  if (el) el.textContent = msg;
  show('error');
}

// ── Wire buttons ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-connect')?.addEventListener('click', connectSession);
  document.getElementById('btn-open-linkedin')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.linkedin.com/login' });
  });
  document.getElementById('btn-close')?.addEventListener('click', () => window.close());
  document.getElementById('btn-retry')?.addEventListener('click', init);

  init();
});
