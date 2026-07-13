/**
 * LeadPilot LinkedIn Scraper — Content Script
 * Runs on linkedin.com pages. Finds active scrape job, extracts profiles, reports to backend.
 */
(async function main() {
  const href = window.location.href;
  console.log('[LeadPilot] Content script running on:', href);

  const isSearchPage = href.includes('/search/results/people') || href.includes('/sales/search/');
  if (!isSearchPage) { console.log('[LeadPilot] Not a search page — skipping'); return; }

  await sleep(600);

  // Get job from background (more reliable than direct session storage access)
  let job = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await Promise.race([
        chrome.runtime.sendMessage({ type: 'GET_JOB' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('GET_JOB timeout')), 5000)),
      ]);
      job = resp?.job ?? null;
      console.log(`[LeadPilot] Job (attempt ${attempt}):`, JSON.stringify(job));
      if (job && !job.done) break;
    } catch (e) {
      console.error(`[LeadPilot] GET_JOB attempt ${attempt} failed:`, e?.message ?? String(e));
    }
    if (attempt < 3) await sleep(1500);
  }

  if (!job) { console.warn('[LeadPilot] No active job — tab opened manually?'); return; }
  if (job.done) { console.log('[LeadPilot] Job done, skipping'); return; }

  // URL path match (ignores ?page= param so page 2+ still match)
  try {
    const jobPath = new URL(job.url).pathname.split('?')[0];
    const curPath = new URL(href).pathname.split('?')[0];
    console.log('[LeadPilot] URL match — jobPath:', jobPath, 'curPath:', curPath);
    if (!curPath.startsWith(jobPath)) { console.warn('[LeadPilot] URL mismatch — skipping'); return; }
  } catch (e) { console.error('[LeadPilot] URL parse error:', e); return; }

  const isSN = href.includes('/sales/');

  // Wait for page JS (Ember/React) to render
  await sleep(isSN ? 5000 : 3000);

  // Click "Show new results" if present (Sales Nav cached state)
  const showNewBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(b => /show.*(new|updated).*result/i.test(b.innerText ?? ''));
  if (showNewBtn) { console.log('[LeadPilot] Clicking show-new-results'); showNewBtn.click(); await sleep(3000); }

  // Extract profiles
  let profiles;
  if (isSN) {
    profiles = await extractWhileScrolling(job.max_profiles);
  } else {
    // Regular LinkedIn search lazy-renders result cards as you scroll — scroll the whole
    // page down a few times so all ~10 rows mount, then extract. Without this only the
    // first few visible cards are captured.
    for (let i = 0; i < 8; i++) { window.scrollBy(0, 900); await sleep(500); }
    window.scrollTo(0, 0); await sleep(400);
    profiles = extractProfiles();
  }
  const newPage  = (job.page  || 0) + 1;
  const newTotal = (job.total || 0) + profiles.length;
  console.log('[LeadPilot] Extracted', profiles.length, 'profiles. Page:', newPage, 'Total:', newTotal);

  // Send to background → backend (with 20s timeout — SW can be terminated mid-fetch)
  let isDone = false;
  try {
    const resp = await Promise.race([
      chrome.runtime.sendMessage({ type: 'PAGE_SCRAPED', job_id: job.job_id, profiles, page: newPage, total: newTotal, max: job.max_profiles }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PAGE_SCRAPED timeout')), 20000)),
    ]);
    isDone = resp?.done === true;
    console.log('[LeadPilot] PAGE_SCRAPED response: done=', isDone);
  } catch (e) {
    console.warn('[LeadPilot] PAGE_SCRAPED fallback (timeout or SW restart):', e?.message ?? e);
    isDone = false; // assume not done — continue to next page
  }

  // Background already updated session storage in handlePageScraped
  // Content script does NOT touch chrome.storage.session (unreliable from content scripts)

  if (isDone || newTotal >= job.max_profiles || profiles.length === 0) {
    console.log('[LeadPilot] All done. Total:', newTotal);
    try { await Promise.race([
      chrome.runtime.sendMessage({ type: 'SCRAPE_DONE', job_id: job.job_id }),
      new Promise((_, r) => setTimeout(r, 5000)),
    ]); } catch (_) {}
    window.close();
    return;
  }

  // Navigate to next page
  await sleep(1000 + rand(800));
  const nextBtn = findNextBtn();
  console.log('[LeadPilot] Next button found:', !!nextBtn, nextBtn?.innerText?.trim());

  if (nextBtn) {
    const prevUrl = location.href;
    nextBtn.click();  // Let Sales Nav / LinkedIn handle pagination (cursor/session params)
    console.log('[LeadPilot] Clicked Next, waiting for URL change...');

    // Wait up to 6s for SPA to update URL
    let urlChanged = false;
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      if (location.href !== prevUrl) { urlChanged = true; break; }
    }

    if (urlChanged) {
      console.log('[LeadPilot] URL changed to:', location.href.slice(0, 80));
      await sleep(500);
      location.reload();  // Force full reload so content script re-runs on new page
    } else {
      // URL didn't change — try incrementing ?page= param directly
      const nextUrl = new URL(location.href);
      const curPage = parseInt(nextUrl.searchParams.get('page') || '1');
      nextUrl.searchParams.set('page', String(curPage + 1));
      console.log('[LeadPilot] URL unchanged, forcing page', curPage + 1);
      location.href = nextUrl.toString();
    }
  } else {
    console.log('[LeadPilot] No Next button — all pages done');
    try { await Promise.race([
      chrome.runtime.sendMessage({ type: 'SCRAPE_DONE', job_id: job.job_id }),
      new Promise((_, r) => setTimeout(r, 5000)),
    ]); } catch (_) {}
    window.close();
  }
})();


// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(n)   { return Math.floor(Math.random() * n); }

function waitForSelector(selector, timeout = 10000) {
  return new Promise(resolve => {
    if (document.querySelector(selector)) { resolve(true); return; }
    const obs = new MutationObserver(() => { if (document.querySelector(selector)) { obs.disconnect(); resolve(true); } });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
  });
}

function findNextBtn() {
  const candidates = [
    document.querySelector('button[data-test-pagination-page-btn="next"]'),
    document.querySelector('button[aria-label="Next"]'),
    document.querySelector('button.artdeco-pagination__button--next'),
    [...document.querySelectorAll('button')].find(b => /^next/i.test(b.innerText?.trim())),
    [...document.querySelectorAll('li[data-test-pagination-page-btn="next"] button')][0],
  ].filter(Boolean);
  return candidates.find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true') ?? null;
}

// ── Sales Navigator: extract while scrolling (virtual DOM) ────────────────────

async function extractWhileScrolling(maxProfiles) {
  const all  = [];
  const seen = new Set();

  function extractVisible() {
    const fresh = [];
    for (const a of document.querySelectorAll('a[data-control-name="view_lead_panel_via_search_lead_name"]')) {
      const href = a.href?.split('?')[0];
      if (!href || !href.includes('/sales/lead/') || seen.has(href)) continue;
      const card = a.closest('li');
      if (!card) continue;
      const t = el => (el?.innerText || '').trim();
      const name = t(a.querySelector('[data-anonymize="person-name"]') || a);
      if (!name || name.length < 2) continue;
      seen.add(href);

      // Try to find the regular LinkedIn /in/ URL from the card DOM.
      // SN cards sometimes have a "View LinkedIn Profile" link or the picture links to /in/.
      let regularLinkedinUrl = null;

      // Check all <a> links in the card
      for (const lnk of card.querySelectorAll('a[href*="/in/"]')) {
        const lhref = (lnk.href || '').split('?')[0].replace(/\/$/, '');
        if (lhref.match(/linkedin\.com\/in\/[A-Za-z0-9_-]{3,}/) && !lhref.includes('/sales/')) {
          regularLinkedinUrl = lhref;
          break;
        }
      }

      // Also check data attributes for embedded profile URLs
      if (!regularLinkedinUrl) {
        const allText = card.innerHTML || '';
        const m = allText.match(/linkedin\.com\/in\/([A-Za-z0-9_-]{3,120})(?:['"?/])/);
        if (m) regularLinkedinUrl = `https://www.linkedin.com/in/${m[1]}`;
      }

      fresh.push({
        name,
        // Prefer the regular /in/ URL for invites; fall back to SN URL
        linkedin_url: regularLinkedinUrl || href,
        sales_nav_url: href,                              // always keep SN URL for reference
        profile_id:   regularLinkedinUrl
          ? (regularLinkedinUrl.split('/in/')[1] ?? '').split('/')[0]
          : (href.split('/sales/lead/')[1] ?? '').split(',')[0],
        title:        t(card.querySelector('[data-anonymize="title"]')),
        company:      t(card.querySelector('[data-anonymize="company-name"]')),
        location:     t(card.querySelector('[data-anonymize="location"]')),
        connection_degree: '', source: 'sales_navigator',
        mutual_connections: '', is_open_to_work: false, is_premium: false,
        company_size: t(card.querySelector('[data-anonymize="company-size"]')),
        industry:     t(card.querySelector('[data-anonymize="industry"]')),
        seniority:    t(card.querySelector('[data-anonymize="seniority"]')),
      });
    }
    return fresh;
  }

  function waitForNewLink(timeout = 2500) {
    return new Promise(resolve => {
      const check = () => {
        for (const a of document.querySelectorAll('a[data-control-name="view_lead_panel_via_search_lead_name"]')) {
          const href = a.href?.split('?')[0];
          if (href && href.includes('/sales/lead/') && !seen.has(href)) return true;
        }
        return false;
      };
      if (check()) { resolve(true); return; }
      const obs = new MutationObserver(() => { if (check()) { obs.disconnect(); resolve(true); } });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
    });
  }

  // Re-find scroller FRESH each call — Ember unmounts/remounts the container,
  // so a stored reference becomes stale (scrollHeight = 0 on detached element).
  function getLiveScroller() {
    const card = document.querySelector('a[data-control-name="view_lead_panel_via_search_lead_name"]');
    if (card) {
      let el = card.parentElement;
      while (el && el !== document.body) {
        const cs = getComputedStyle(el);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 30) return el;
        el = el.parentElement;
      }
    }
    // Fallback: scrollable div with clientHeight > 300
    for (const el of document.querySelectorAll('div, main')) {
      try {
        const cs = getComputedStyle(el);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.clientHeight > 300 && el.scrollHeight > el.clientHeight + 50) return el;
      } catch (_) {}
    }
    return null;
  }

  function doScroll(px) {
    // Scrolling the LAST rendered card into view is the most reliable way to make
    // Sales Navigator's virtual list mount the next batch of rows (plain scrollTop
    // often isn't enough and the list stops loading early → only ~12 of 25 captured).
    const links = document.querySelectorAll('a[data-control-name="view_lead_panel_via_search_lead_name"]');
    const last = links[links.length - 1];
    if (last) {
      try { last.scrollIntoView({ block: 'end' }); }
      catch (_) { try { last.scrollIntoView(false); } catch (_) {} }
    }
    const s = getLiveScroller();
    if (s) { s.scrollTop += px; return true; }
    window.scrollBy(0, px); return true;
  }

  function isAtBottom() {
    const s = getLiveScroller();
    if (s) return s.scrollTop + s.clientHeight >= s.scrollHeight - 80;
    return window.scrollY + window.innerHeight >= Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - 80;
  }

  // Initial extraction (don't reset scroll — resets cause Ember to unmount+remount)
  await sleep(1500);
  const init = extractVisible();
  all.push(...init);
  const liveS = getLiveScroller();
  console.log('[LeadPilot] Initial:', init.length, '| scroller scrollH:', liveS?.scrollHeight ?? 'window', '| clientH:', liveS?.clientHeight ?? window.innerHeight);

  let noNewCount   = 0;
  let atBottomWait = 0;

  while (all.length < maxProfiles) {
    // More patience than before: SN's virtual list can pause loading briefly, so don't
    // give up after only a few empty steps (that caused the ~12/25 under-fetch).
    if (noNewCount >= 22) { console.log('[LeadPilot] No new profiles for 22 steps'); break; }

    if (isAtBottom()) {
      atBottomWait++;
      if (atBottomWait >= 5) { console.log('[LeadPilot] Truly at bottom after', atBottomWait, 'waits'); break; }
      console.log('[LeadPilot] At bottom, waiting for virtual scroll...', atBottomWait);
      await sleep(2200);
    } else {
      atBottomWait = 0;
    }

    doScroll(Math.floor(Math.random() * 200 + 250));
    await waitForNewLink(2500);

    const batch = extractVisible();
    if (batch.length) {
      all.push(...batch);
      noNewCount = 0;
      atBottomWait = 0;
      console.log('[LeadPilot] Batch:', batch.length, '| Total:', all.length);
    } else {
      noNewCount++;
      await sleep(400);
    }
  }

  console.log('[LeadPilot] extractWhileScrolling done:', all.length);
  return all;
}

// ── LinkedIn People Search extractor ─────────────────────────────────────────

function extractProfiles() {
  const results = [];
  const seen    = new Set();

  function txt(el) { return (el?.innerText ?? el?.textContent ?? '').trim(); }

  function push(href, name, title, company, location, source, extra) {
    href = href.split('?')[0].replace(/\/$/, '');
    if (!href || !name || name.length < 2 || seen.has(href)) return;
    if (href.includes('/search/') || href.includes('/company/')) return;
    seen.add(href);
    const id = href.includes('/in/') ? (href.split('/in/')[1] ?? '').split('/')[0] : '';
    results.push({ name, title, company, location, linkedin_url: href, profile_id: id, connection_degree: extra.degree ?? '', source, mutual_connections: extra.mutual ?? '', is_open_to_work: extra.otw ?? false, is_premium: extra.prem ?? false, company_size: '', industry: '', seniority: '' });
  }

  const LI_SELS = [
    'li.reusable-search__result-container',
    'li.search-results__result-item',
    '[data-view-name="search-results-result-item"]',
    'div.entity-result',
  ];
  let cards = [];
  for (const s of LI_SELS) {
    cards = [...document.querySelectorAll(s)];
    if (cards.length) { console.log('[LeadPilot] LinkedIn cards via:', s, cards.length); break; }
  }

  for (const c of cards) {
    try {
      const a = c.querySelector('a[href*="/in/"]');
      if (!a?.href) continue;
      const nameEl = c.querySelector('span[aria-hidden="true"]') || c.querySelector('.entity-result__title-text');
      const name = txt(nameEl);
      if (!name || name.toLowerCase().includes('linkedin member')) continue;
      push(a.href, name,
        txt(c.querySelector('.entity-result__primary-subtitle')),
        txt(c.querySelector('.entity-result__secondary-subtitle')),
        txt(c.querySelector('.entity-result__simple-insight-text')),
        'linkedin_search',
        { degree: txt(c.querySelector('.dist-value')), otw: !!c.querySelector('.open-to-work-badge'), prem: !!c.querySelector('li-icon[type="linkedin-premium"]') }
      );
    } catch (_) {}
  }

  // Fallback
  if (!results.length) {
    for (const a of document.querySelectorAll('a[href*="/in/"]')) {
      try {
        const name = txt(a.querySelector('span') || a);
        if (!name || name.length < 3) continue;
        push(a.href, name, '', '', '', 'linkedin_search', {});
      } catch (_) {}
    }
  }

  console.log('[LeadPilot] LinkedIn extracted:', results.length);
  return results;
}
