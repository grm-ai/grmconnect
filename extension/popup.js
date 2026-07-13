const API_URL = 'http://localhost:8000';
const API_KEY = 'dev-secret-key-change-me';

let _cachedProfile = null;

function show(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const el = document.getElementById('panel-' + id);
  if (el) el.classList.add('active');
}

function getLinkedInCookies() {
  return new Promise(resolve => chrome.cookies.getAll({ domain: '.linkedin.com' }, resolve));
}

function getCsrfToken(cookies) {
  const c = cookies.find(c => c.name === 'JSESSIONID');
  return c ? c.value.replace(/"/g, '') : '';
}

async function getLinkedInProfile(cookies) {
  try {
    const csrf = getCsrfToken(cookies);
    if (!csrf) return null;
    const res = await fetch('https://www.linkedin.com/voyager/api/me', {
      credentials: 'include',
      headers: {
        'accept': 'application/vnd.linkedin.normalized+json+2.1',
        'csrf-token': csrf,
        'x-restli-protocol-version': '2.0.0',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const mini = data?.miniProfile || data?.data?.miniProfile || (data?.included || []).find(i => i.firstName || i.lastName) || data?.data || {};
    const str = v => (typeof v === 'object' ? v?.text ?? '' : v ?? '');
    const fn = str(mini.firstName), ln = str(mini.lastName);
    const name = `${fn} ${ln}`.trim() || null;
    const headline = str(mini.occupation || mini.headline) || null;
    return name ? { name, headline, publicId: mini.publicIdentifier ?? '' } : null;
  } catch (_) { return null; }
}

async function init() {
  show('checking');
  _cachedProfile = null;
  try {
    const cookies = await getLinkedInCookies();
    if (!cookies.find(c => c.name === 'li_at')?.value) { show('not-logged-in'); return; }
    const profile = await getLinkedInProfile(cookies);
    _cachedProfile = profile;
    document.getElementById('avatar').textContent = (profile?.name?.[0] ?? 'L').toUpperCase();
    document.getElementById('user-name').textContent = profile?.name || 'LinkedIn User';
    const hl = document.getElementById('user-headline');
    if (hl) { hl.textContent = profile?.headline || ''; hl.style.display = profile?.headline ? '' : 'none'; }
    show('ready');
  } catch (err) { showError('Error: ' + err.message); }
}

async function connectSession() {
  show('checking');
  try {
    const cookies = await getLinkedInCookies();
    if (!cookies.find(c => c.name === 'li_at')?.value) { show('not-logged-in'); return; }

    const storageState = {
      cookies: cookies.map(c => ({
        name: c.name, value: c.value,
        domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
        path: c.path || '/', expires: c.expirationDate ? Math.floor(c.expirationDate) : -1,
        httpOnly: c.httpOnly || false, secure: c.secure || false, sameSite: 'None',
      })),
      origins: [{ origin: 'https://www.linkedin.com', localStorage: [] }],
    };

    let response;
    try {
      response = await fetch(`${API_URL}/linkedin/save-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
        body: JSON.stringify({
          storage_state: storageState,
          account_name: 'default',
          profile_name: _cachedProfile?.name ?? null,
          profile_headline: _cachedProfile?.headline ?? null,
        }),
      });
    } catch (_) {
      showError('Cannot reach LeadPilot backend.\n\nRun: python backend/run_dev.py');
      return;
    }

    const result = await response.json();
    if (result.success) {
      const name = result.data?.linkedin_name || _cachedProfile?.name || 'LinkedIn User';
      document.getElementById('success-name').textContent = 'Connected as ' + name;
      show('success');
    } else {
      showError(result.message || 'Backend error.');
    }
  } catch (err) { showError(err.message); }
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  if (el) el.textContent = msg;
  show('error');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-connect')?.addEventListener('click', connectSession);
  document.getElementById('btn-open-linkedin')?.addEventListener('click', () => chrome.tabs.create({ url: 'https://www.linkedin.com/login' }));
  document.getElementById('btn-close')?.addEventListener('click', () => window.close());
  document.getElementById('btn-retry')?.addEventListener('click', init);
  init();
});
