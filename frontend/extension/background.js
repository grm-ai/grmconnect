/**
 * LeadPilot Background Service Worker
 *
 * Responsibilities (minimal by design):
 * 1. Receive START_SCRAPE from content.js (localhost page) → store job, open tab
 * 2. Receive PAGE_SCRAPED from linkedin_scraper.js → POST to backend → reply done/continue
 * 3. Receive SCRAPE_DONE → mark job finished in backend
 *
 * The actual scraping is done by linkedin_scraper.js (content script) which lives
 * as long as the LinkedIn tab is open — no 30-second service worker timeout issue.
 */

const API = 'http://localhost:8000';
const KEY = 'dev-secret-key-change-me';
const HDR = { 'Content-Type': 'application/json', 'X-API-Key': KEY };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  // ── Content script asking for current job data ────────────────────────────
  if (msg.type === 'GET_JOB') {
    chrome.storage.session.get('lp_scrape_job')
      .then(data => sendResponse({ job: data?.lp_scrape_job ?? null }))
      .catch(() => sendResponse({ job: null }));
    return true;
  }

  // ── From localhost content.js: user clicked "Start Search" ─────────────────
  if (msg.type === 'START_SCRAPE') {
    handleStart(msg).then(() => sendResponse({ ok: true })).catch(e => {
      console.error('[LeadPilot BG] START_SCRAPE error:', e);
      sendResponse({ ok: false });
    });
    return true;
  }

  // ── From linkedin_scraper.js: one page has been scraped ───────────────────
  if (msg.type === 'PAGE_SCRAPED') {
    handlePageScraped(msg).then(res => sendResponse(res)).catch(e => {
      console.error('[LeadPilot BG] PAGE_SCRAPED error:', e);
      sendResponse({ done: true }); // Fail safe: close tab
    });
    return true;
  }

  // ── From linkedin_scraper.js: all pages done ──────────────────────────────
  if (msg.type === 'SCRAPE_DONE') {
    handleDone(msg.job_id).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});


// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleStart(job) {
  const { job_id, url, max_profiles = 100 } = job;
  console.log('[LeadPilot BG] Starting job', job_id, url);

  // Close any old LinkedIn/SalesNav scraper tabs from previous runs
  try {
    const existingTabs = await chrome.tabs.query({ url: ['https://*.linkedin.com/*'] });
    for (const t of existingTabs) {
      if (t.url?.includes('/search/') || t.url?.includes('/sales/search/')) {
        await chrome.tabs.remove(t.id);
        console.log('[LeadPilot BG] Closed old tab:', t.url);
      }
    }
  } catch (_) {}

  // Store job BEFORE opening tab to avoid race condition
  await chrome.storage.session.set({
    lp_scrape_job: {
      job_id,
      url,
      max_profiles,
      page:  0,
      total: 0,
      done:  false,
    }
  });
  console.log('[LeadPilot BG] Job stored in session:', job_id);

  // Report "running" to backend
  await post('/scrape/extension-update', {
    job_id,
    status: 'running',
    progress_profiles: 0,
    progress_pages: 0,
  });

  // Small delay to ensure storage write completes before tab loads
  await new Promise(r => setTimeout(r, 200));

  // Open the LinkedIn tab — linkedin_scraper.js will run automatically
  const tab = await chrome.tabs.create({ url, active: true }); // active=true so page fully loads
  console.log('[LeadPilot BG] Tab opened:', tab.id, url);
}


async function handlePageScraped(msg) {
  const { job_id, profiles, page, total, max } = msg;
  console.log('[LeadPilot BG] Page', page, '—', profiles.length, 'profiles,', total, 'total');

  const isDone = total >= max || profiles.length === 0;

  await post('/scrape/extension-update', {
    job_id,
    status:            'running',
    new_profiles:      profiles,
    progress_profiles: total,
    progress_pages:    page,
    finished:          isDone,
    ...(isDone ? { status: 'done' } : {}),
  });

  if (isDone) {
    await chrome.storage.session.remove('lp_scrape_job');
    console.log('[LeadPilot BG] Job', job_id, 'done. Total:', total);
  }

  return { done: isDone };
}


async function handleDone(job_id) {
  console.log('[LeadPilot BG] SCRAPE_DONE for', job_id);
  await chrome.storage.session.remove('lp_scrape_job');
  await post('/scrape/extension-update', {
    job_id,
    status: 'done',
    finished: true,
  });
}


// ── Backend fetch ─────────────────────────────────────────────────────────────

async function post(path, body) {
  try {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: HDR,
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn('[LeadPilot BG] POST', path, 'returned', res.status);
  } catch (e) {
    console.error('[LeadPilot BG] POST', path, 'failed:', e.message);
  }
}
