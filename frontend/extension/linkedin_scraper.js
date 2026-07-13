/**
 * LeadPilot LinkedIn Scraper — Content Script
 *
 * Runs inside every linkedin.com page. Checks if there's an active scrape job
 * for this URL, extracts profiles, and reports back via the background worker.
 *
 * Why content script instead of service worker scripting:
 * - Content scripts live as long as the tab is open (no 30-second timeout)
 * - Can read the full DOM including dynamic React-rendered content
 * - Background sends data to backend (bypasses CORS since it's extension origin)
 */

(async function main() {
  const href = window.location.href;
  console.log('[LeadPilot] Content script running on:', href);

  // Only run on search result pages
  const isSearchPage =
    href.includes('/search/results/people') ||
    href.includes('/sales/search/');
  if (!isSearchPage) {
    console.log('[LeadPilot] Not a search page — skipping');
    return;
  }

  // Ask the background service worker for the current job.
  // Using sendMessage instead of chrome.storage.session.get directly,
  // because session storage can hang in content scripts when the SW is between states.
  await sleep(600);

  let job = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GET_JOB' });
      job = resp?.job ?? null;
      console.log(`[LeadPilot] Job (attempt ${attempt}):`, JSON.stringify(job));
      if (job && !job.done) break;
    } catch (e) {
      console.error(`[LeadPilot] GET_JOB attempt ${attempt} failed:`, e?.message ?? String(e));
    }
    if (attempt < 3) await sleep(1500);
  }

  if (!job) {
    console.warn('[LeadPilot] No active job found after 3 attempts — tab opened manually?');
    return;
  }
  if (job.done) {
    console.log('[LeadPilot] Job already done, skipping');
    return;
  }

  // Match current URL path against the job's URL path
  try {
    const jobPath = new URL(job.url).pathname.split('?')[0];
    const curPath = new URL(href).pathname.split('?')[0];
    console.log('[LeadPilot] URL match check — jobPath:', jobPath, 'curPath:', curPath);
    if (!curPath.startsWith(jobPath)) {
      console.warn('[LeadPilot] URL does not match job URL — skipping');
      return;
    }
  } catch (e) {
    console.error('[LeadPilot] URL parse error:', e);
    return;
  }

  const isSN = href.includes('/sales/');

  // ── Wait for page JS to render initial results ───────────────────────────────
  await sleep(isSN ? 5000 : 3000);

  // ── Click "Show X new results" button if present ──────────────────────────────
  const showNewBtn = [...document.querySelectorAll('button, [role="button"]')]
    .find(b => /show.*(new|updated).*result/i.test(b.innerText ?? ''));
  if (showNewBtn) {
    console.log('[LeadPilot] Clicking "Show new results"');
    showNewBtn.click();
    await sleep(3000);
  }

  // ── Extract profiles ─────────────────────────────────────────────────────────
  // Sales Navigator uses virtual scrolling: profiles are REMOVED from DOM when
  // scrolled past. We must extract incrementally while scrolling.
  const profiles = isSN
    ? await extractWhileScrolling(job.max_profiles)
    : extractProfiles();
  const newPage  = (job.page  || 0) + 1;
  const newTotal = (job.total || 0) + profiles.length;

  // ── Report to background (which POSTs to backend) ───────────────────────────
  let isDone = false;
  try {
    const resp = await chrome.runtime.sendMessage({
      type:     'PAGE_SCRAPED',
      job_id:   job.job_id,
      profiles,
      page:     newPage,
      total:    newTotal,
      max:      job.max_profiles,
    });
    isDone = resp?.done === true;
  } catch (e) {
    console.error('[LeadPilot] sendMessage failed:', e);
  }

  // ── Update stored state ───────────────────────────────────────────────────────
  const updatedJob = { ...job, page: newPage, total: newTotal };

  if (isDone || newTotal >= job.max_profiles || profiles.length === 0) {
    await chrome.storage.session.set({ lp_scrape_job: { ...updatedJob, done: true } });
    try {
      await chrome.runtime.sendMessage({ type: 'SCRAPE_DONE', job_id: job.job_id });
    } catch (_) {}
    window.close();
    return;
  }

  await chrome.storage.session.set({ lp_scrape_job: updatedJob });

  // ── Navigate to next page ────────────────────────────────────────────────────
  // Sales Navigator and LinkedIn use SPA navigation (pushState) — clicking "Next"
  // updates the URL but does NOT reload the page, so the content script won't re-run.
  // Fix: build the next-page URL and set location.href directly for a full reload.
  await sleep(1000 + rand(800));

  const hasNext = !!findNextBtn();

  if (hasNext) {
    // Construct next page URL by incrementing the ?page= param
    const nextUrl = new URL(location.href);
    const curPageNum = parseInt(nextUrl.searchParams.get('page') || '1');
    nextUrl.searchParams.set('page', String(curPageNum + 1));
    console.log('[LeadPilot] Navigating to page', curPageNum + 1, nextUrl.toString());
    // Full navigation → page reloads → content script re-runs automatically
    location.href = nextUrl.toString();
  } else {
    // No more pages
    await chrome.storage.session.set({ lp_scrape_job: { ...updatedJob, done: true } });
    try {
      await chrome.runtime.sendMessage({ type: 'SCRAPE_DONE', job_id: job.job_id });
    } catch (_) {}
    window.close();
  }
})();


// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(n)   { return Math.floor(Math.random() * n); }

// Wait for a CSS selector to match at least one element, using MutationObserver.
// Returns true if found within timeout, false if timed out.
function waitForSelector(selector, timeout = 10000) {
  return new Promise(resolve => {
    if (document.querySelector(selector)) { resolve(true); return; }
    const obs = new MutationObserver(() => {
      if (document.querySelector(selector)) { obs.disconnect(); resolve(true); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
  });
}

function humanScroll() {
  return new Promise(resolve => {
    let i = 0;
    const steps = 5 + Math.floor(Math.random() * 4);
    function tick() {
      if (i >= steps) { resolve(); return; }
      window.scrollBy({ top: Math.floor(Math.random() * 350 + 180), behavior: 'smooth' });
      i++;
      setTimeout(tick, Math.floor(Math.random() * 700 + 250));
    }
    tick();
  });
}

// Sales Navigator incremental extractor.
// Sales Nav uses virtual scrolling: DOM cards are added/removed as you scroll.
// Strategy: scroll a little → wait for Ember to render new cards → extract new ones → repeat.
async function extractWhileScrolling(maxProfiles) {
  const all  = [];
  const seen = new Set();

  function extractVisible() {
    const links = document.querySelectorAll('a[data-control-name="view_lead_panel_via_search_lead_name"]');
    const fresh = [];
    for (const a of links) {
      const href = a.href?.split('?')[0];
      if (!href || !href.includes('/sales/lead/') || seen.has(href)) continue;
      const card = a.closest('li');
      if (!card) continue;
      const t = el => (el?.innerText || '').trim();
      const name = t(a.querySelector('[data-anonymize="person-name"]') || a);
      if (!name || name.length < 2) continue;
      seen.add(href);
      fresh.push({
        name,
        title:    t(card.querySelector('[data-anonymize="title"]')),
        company:  t(card.querySelector('[data-anonymize="company-name"]')),
        location: t(card.querySelector('[data-anonymize="location"]')),
        linkedin_url: href,
        profile_id:   (href.split('/sales/lead/')[1] ?? '').split(',')[0],
        connection_degree: '', source: 'sales_navigator',
        mutual_connections: '', is_open_to_work: false, is_premium: false,
        company_size: t(card.querySelector('[data-anonymize="company-size"]')),
        industry:     t(card.querySelector('[data-anonymize="industry"]')),
        seniority:    t(card.querySelector('[data-anonymize="seniority"]')),
      });
    }
    return fresh;
  }

  // Wait until a new (unseen) link appears in DOM, or timeout.
  function waitForNewLink(timeout = 3000) {
    return new Promise(resolve => {
      const check = () => {
        const links = document.querySelectorAll('a[data-control-name="view_lead_panel_via_search_lead_name"]');
        for (const a of links) {
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

  // Extract initial batch
  await sleep(1500);
  const init = extractVisible();
  all.push(...init);
  console.log('[LeadPilot] Initial:', init.length);

  // Find the actual scrollable container (Sales Nav uses a div, not window)
  function getScroller() {
    // Try window first
    const bodyH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    if (bodyH > window.innerHeight + 100) return null; // window scrolls normally

    // Find div/main that actually scrolls
    for (const sel of [
      'main', '[role="main"]', '.scaffold-layout__main',
      '.search-results-container', '.application-outlet > div',
      'div[class*="results"]', 'div[class*="search"]',
    ]) {
      const el = document.querySelector(sel);
      if (el) {
        const s = getComputedStyle(el);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 100) {
          console.log('[LeadPilot] Scroll container:', sel, 'scrollHeight:', el.scrollHeight);
          return el;
        }
      }
    }
    // Generic: first div with overflow scroll that's tall enough
    for (const div of document.querySelectorAll('div')) {
      const s = getComputedStyle(div);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && div.scrollHeight > div.clientHeight + 200 && div.clientHeight > 400) {
        console.log('[LeadPilot] Scroll container (generic):', div.className?.slice(0, 60), 'h:', div.scrollHeight);
        return div;
      }
    }
    return null;
  }

  const scroller = getScroller();
  const getScrollTop  = () => scroller ? scroller.scrollTop  : (window.scrollY || document.documentElement.scrollTop);
  const getScrollH    = () => scroller ? scroller.scrollHeight : Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  const getClientH    = () => scroller ? scroller.clientHeight : window.innerHeight;
  const doScroll      = (px) => scroller
    ? (scroller.scrollTop += px)
    : window.scrollBy({ top: px, behavior: 'smooth' });

  console.log('[LeadPilot] Using scroller:', scroller ? scroller.tagName + '.' + (scroller.className?.slice(0, 40) ?? '') : 'window',
    '| scrollH:', getScrollH(), '| clientH:', getClientH());

  // Scroll loop
  let noNewCount = 0;
  while (all.length < maxProfiles) {
    const top      = getScrollTop();
    const clientH  = getClientH();
    const scrollH  = getScrollH();
    const atBottom = top + clientH >= scrollH - 200;

    if (atBottom) { console.log('[LeadPilot] Reached bottom'); break; }
    if (noNewCount >= 8) { console.log('[LeadPilot] No new profiles for 8 attempts, stopping'); break; }

    // Small scroll step: ~1 profile card height
    doScroll(Math.floor(Math.random() * 120 + 80));

    // Wait for Ember to render new profile links
    const appeared = await waitForNewLink(2500);
    const batch = extractVisible();
    if (batch.length) {
      all.push(...batch);
      noNewCount = 0;
      console.log('[LeadPilot] Batch:', batch.length, '| Total:', all.length);
    } else {
      noNewCount++;
      await sleep(300);
    }
  }

  console.log('[LeadPilot] extractWhileScrolling done:', all.length, 'profiles');
  return all;
}

// Scroll to the absolute bottom of the page so ALL lazy-loaded cards render.
// Does NOT stop early based on card count — only stops when truly at bottom.
function scrollToLoadAll() {
  return new Promise(resolve => {
    let prevScrollY = -1;
    let stuckTicks  = 0;

    const id = setInterval(() => {
      window.scrollBy({ top: Math.floor(Math.random() * 350 + 250), behavior: 'smooth' });

      const scrollY    = Math.round(window.scrollY);
      const atBottom   = scrollY + window.innerHeight >= document.body.scrollHeight - 200;
      const stuck      = scrollY === prevScrollY;

      if (stuck) stuckTicks++; else stuckTicks = 0;
      prevScrollY = scrollY;

      // Stop when we truly hit the bottom OR page stopped growing
      if (atBottom || stuckTicks >= 4) {
        clearInterval(id);
        const count = document.querySelectorAll(
          'a[data-control-name="view_lead_panel_via_search_lead_name"], ' +
          'li.reusable-search__result-container, div.entity-result'
        ).length;
        console.log('[LeadPilot] Scroll complete, cards loaded:', count);
        window.scrollTo({ top: 0, behavior: 'smooth' });
        setTimeout(resolve, 1200); // wait for scroll-back-to-top
      }
    }, 500);

    setTimeout(() => { clearInterval(id); resolve(); }, 25000); // 25s hard cap
  });
}

function findNextBtn() {
  const candidates = [
    document.querySelector('button[data-test-pagination-page-btn="next"]'),
    document.querySelector('button[aria-label="Next"]'),
    document.querySelector('button.artdeco-pagination__button--next'),
    document.querySelector('li.artdeco-pagination__indicator--number.active + li button'),
    [...document.querySelectorAll('button')].find(b => b.innerText?.trim() === 'Next'),
    // Sales Navigator specific: next page inside pagination
    document.querySelector('[data-test-pagination-page-btn="next"] button'),
    [...document.querySelectorAll('li[data-test-pagination-page-btn="next"] button')][0],
  ].filter(Boolean);
  return candidates.find(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true') ?? null;
}

function extractProfiles() {
  const results = [];
  const seen    = new Set();
  const isSN = window.location.href.includes('/sales/');

  function txt(el) { return (el?.innerText ?? el?.textContent ?? '').trim(); }

  function push(href, name, title, company, location, source, extra) {
    href = href.split('?')[0].replace(/\/$/, '');
    if (!href || !name || name.length < 2 || seen.has(href)) return;
    if (href.includes('/search/') || href.includes('/company/')) return; // skip non-profile links
    seen.add(href);
    const id = href.includes('/sales/lead/')
      ? (href.split('/sales/lead/')[1] ?? '').split('/')[0]
      : (href.split('/in/')[1] ?? '').split('/')[0];
    results.push({
      name, title, company, location,
      linkedin_url: href, profile_id: id,
      connection_degree: extra.degree ?? '',
      source,
      mutual_connections: extra.mutual ?? '',
      is_open_to_work: extra.otw  ?? false,
      is_premium:      extra.prem ?? false,
      company_size:    extra.size ?? '',
      industry:        extra.ind  ?? '',
      seniority:       extra.sen  ?? '',
    });
  }

  console.log('[LeadPilot] isSN:', isSN);

  // ── Sales Navigator ───────────────────────────────────────────────────────
  if (isSN) {
    // Use confirmed selector: profile name links have data-control-name="view_lead_panel_via_search_lead_name"
    const nameLinks = [...document.querySelectorAll('a[data-control-name="view_lead_panel_via_search_lead_name"]')];
    console.log('[LeadPilot] Name links found:', nameLinks.length);

    for (const a of nameLinks) {
      try {
        const href = a.href.split('?')[0];
        if (!href || !href.includes('/sales/lead/')) continue;

        // Get the card <li> ancestor
        const card = a.closest('li');
        if (!card) continue;

        const name = txt(a.querySelector('[data-anonymize="person-name"]') || a);
        if (!name || name.length < 2) continue;

        push(href, name,
          txt(card.querySelector('[data-anonymize="title"]')),
          txt(card.querySelector('[data-anonymize="company-name"]')),
          txt(card.querySelector('[data-anonymize="location"]')),
          'sales_navigator',
          {
            size: txt(card.querySelector('[data-anonymize="company-size"]')),
            ind:  txt(card.querySelector('[data-anonymize="industry"]')),
            sen:  txt(card.querySelector('[data-anonymize="seniority"]')),
          }
        );
      } catch (_) {}
    }

    // Fallback: any /sales/lead/ link (catches pagination/save buttons too but deduped)
    if (!results.length) {
      console.log('[LeadPilot] Trying fallback sales/lead links');
      for (const a of document.querySelectorAll('a[href*="/sales/lead/"]')) {
        try {
          const href = a.href.split('?')[0];
          const card = a.closest('li');
          if (!card) continue;
          const name = txt(card.querySelector('[data-anonymize="person-name"]'));
          if (!name || name.length < 2) continue;
          push(href, name,
            txt(card.querySelector('[data-anonymize="title"]')),
            txt(card.querySelector('[data-anonymize="company-name"]')),
            txt(card.querySelector('[data-anonymize="location"]')),
            'sales_navigator', {}
          );
        } catch (_) {}
      }
    }

    console.log('[LeadPilot] SN final:', results.length);
  }

  // ── LinkedIn People Search ────────────────────────────────────────────────
  if (!results.length && !isSN) {
    const LI_SELS = [
      'li.reusable-search__result-container',
      'li.search-results__result-item',
      '[data-view-name="search-results-result-item"]',
      'div.entity-result',
      'li[data-occludable-job-id]',
    ];
    let cards = [];
    for (const s of LI_SELS) {
      cards = [...document.querySelectorAll(s)];
      if (cards.length) { console.log('[LeadPilot] LI cards via:', s, cards.length); break; }
    }
    for (const c of cards) {
      try {
        const a = c.querySelector('a[href*="/in/"]');
        if (!a?.href) continue;
        const nameEl = c.querySelector('span[aria-hidden="true"]') ||
                       c.querySelector('.entity-result__title-text');
        const name = txt(nameEl);
        if (!name || name.toLowerCase().includes('linkedin member')) continue;
        push(a.href, name,
          txt(c.querySelector('.entity-result__primary-subtitle')),
          txt(c.querySelector('.entity-result__secondary-subtitle')),
          txt(c.querySelector('.entity-result__simple-insight-text')),
          'linkedin_search',
          {
            degree: txt(c.querySelector('.dist-value')),
            otw:  !!c.querySelector('.open-to-work-badge,[aria-label*="Open to Work"]'),
            prem: !!c.querySelector('li-icon[type="linkedin-premium"]'),
          }
        );
      } catch (_) {}
    }
  }

  // ── Universal fallback: grab ALL profile links on the page ────────────────
  if (!results.length) {
    console.log('[LeadPilot] Trying universal link fallback...');
    const allLinks = document.querySelectorAll('a[href*="/in/"], a[href*="/sales/lead/"]');
    console.log('[LeadPilot] Total links found:', allLinks.length);

    for (const a of allLinks) {
      try {
        const href = (a.href || '').split('?')[0];
        if (!href || seen.has(href)) continue;

        // Skip navigation/UI links (no meaningful name)
        let name = txt(a);
        if (!name || name.length < 3) {
          // Try parent elements for name
          name = txt(a.closest('li, article, [class*="result"]')?.querySelector('span') || a.parentElement);
        }
        if (!name || name.length < 3) continue;
        if (['home', 'feed', 'network', 'jobs', 'messaging', 'notifications'].includes(name.toLowerCase())) continue;

        const src = href.includes('/sales/lead/') ? 'sales_navigator' : 'linkedin_search';
        push(href, name, '', '', '', src, {});
      } catch (_) {}
    }
    console.log('[LeadPilot] Fallback found:', results.length);
  }

  console.log('[LeadPilot] Final extracted:', results.length, 'profiles');
  return results;
}
