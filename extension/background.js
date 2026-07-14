const API = 'https://grmconnect-production.up.railway.app';
const KEY = 'dev-secret-key-change-me';

// ── Per-user auth ──────────────────────────────────────────────────────────────
// The web app passes the logged-in user's JWT (read from its localStorage) via the content
// script. We send it as a Bearer token so the extension acts as THAT user — its invites,
// scraped leads, inbox sync, etc. get scoped to the right account (not the shared owner).
let _userToken = null;
try { chrome.storage.local.get(['lp_token'], (r) => { if (r && r.lp_token) _userToken = r.lp_token; }); } catch (_) {}
function setUserToken(t) {
  _userToken = t || null;
  try { chrome.storage.local.set({ lp_token: _userToken }); } catch (_) {}
}
function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (_userToken) h['Authorization'] = 'Bearer ' + _userToken;
  else h['X-API-Key'] = KEY;   // fallback until the web app hands us a user token
  return h;
}

// chrome.scripting.executeScript can fail with "Frame with ID 0 was removed" when a
// LinkedIn SPA does an internal re-render/navigation at the exact moment we're scripting
// it — transient, not a logic error. Retry a couple times before giving up.
async function safeExecuteScript(opts, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.scripting.executeScript(opts);
    } catch (e) {
      const msg = e.message || '';
      const transient = msg.includes('Frame with ID') || msg.includes('No tab with id') || msg.includes('cannot be scripted') || msg.includes('No frame with id');
      if (attempt < retries && transient) {
        console.warn('[LeadPilot BG] executeScript transient error, retrying:', msg);
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      throw e;
    }
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SET_AUTH_TOKEN') {
    setUserToken(msg.token);   // web app handed us the logged-in user's JWT (or null on logout)
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'SAVE_SESSION') {
    handleSaveSession().then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SYNC_SENT_STATUS') {
    handleSyncSentStatus().then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'FETCH_INBOX') {
    handleFetchInbox().then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SEND_MESSAGE') {
    handleSendMessage(msg).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.type === 'SEND_INVITE') {
    handleSendInvite(msg)
      .then(r => sendResponse(r))
      .catch(async (e) => {
        // Guarantee the backend job is terminated even if handleSendInvite throws before
        // its own done() runs — otherwise the job stays in "waiting_extension" forever and
        // the frontend's 2-second status poll spins indefinitely (the "unlimited requests"
        // seen in the Network tab). Reporting an error result flips the job to "error",
        // which stops the poll.
        try {
          await post(`/leads/connect-job/${msg.job_id}/extension-result`, {
            success: false, error: e.message || 'extension error',
          });
        } catch (_) {}
        sendResponse({ success: false, error: e.message });
      });
    return true;
  }
  if (msg.type === 'RESOLVE_SN_URLS') {
    // Bulk resolve: takes array of {lead_id, sn_url}, returns {lead_id, linkedin_url}[]
    handleResolveSNUrls(msg.leads, _sender.tab?.id).then(r => sendResponse(r)).catch(e => sendResponse({ resolved: [], error: e.message }));
    return true;
  }
  if (msg.type === 'GET_JOB') {
    chrome.storage.session.get('lp_scrape_job')
      .then(d => sendResponse({ job: d?.lp_scrape_job ?? null }))
      .catch(() => sendResponse({ job: null }));
    return true;
  }
  if (msg.type === 'START_SCRAPE') {
    handleStart(msg).then(() => sendResponse({ ok: true })).catch(e => {
      console.error('[LeadPilot BG] START_SCRAPE error:', e);
      sendResponse({ ok: false });
    });
    return true;
  }
  if (msg.type === 'PAGE_SCRAPED') {
    handlePageScraped(msg).then(res => sendResponse(res)).catch(() => sendResponse({ done: true }));
    return true;
  }
  if (msg.type === 'SCRAPE_DONE') {
    handleDone(msg.job_id).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});

async function handleStart(job) {
  const { job_id, url, max_profiles = 100 } = job;
  console.log('[LeadPilot BG] Starting job', job_id, url);

  // Leave existing LinkedIn tabs open — closing then immediately re-opening
  // a search tab is a detectable bot pattern. LinkedIn's fraud system flags it.

  await chrome.storage.session.set({
    lp_scrape_job: { job_id, url, max_profiles, page: 0, total: 0, done: false }
  });
  console.log('[LeadPilot BG] Job stored:', job_id);

  await post('/scrape/extension-update', { job_id, status: 'running', progress_profiles: 0, progress_pages: 0 });
  await new Promise(r => setTimeout(r, 300));
  const tab = await chrome.tabs.create({ url, active: true });
  console.log('[LeadPilot BG] Tab opened:', tab.id, url);
}

// ── CDP-trusted click ───────────────────────────────────────────────────────
// chrome.scripting.executeScript can only dispatch synthetic DOM events, which always
// have event.isTrusted === false. Some LinkedIn controls (confirmed: the SN lead page's
// "..." overflow menu) appear to ignore synthetic clicks entirely. chrome.debugger's
// Input.dispatchMouseEvent goes through Chrome's real input pipeline and produces a
// genuinely trusted click — the same mechanism browser-automation tools like Puppeteer
// use for "real" clicks. Shows a brief "extension is debugging this browser" banner
// while attached; detaches immediately after.
async function cdpClick(tabId, x, y) {
  const send = (method, params) => new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  } catch (e) {
    console.warn('[LeadPilot BG] cdpClick failed:', e.message);
    return false;
  } finally {
    try { await new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve())); } catch (_) {}
  }
}

// ── Trusted keyboard activation (no mouse hit-testing) ────────────────────────
// Confirmed: even a re-measured, trusted CDP mouse click at the correct coordinates does not
// activate LinkedIn's Connect <a> on this machine (Windows foreground-focus lock defeats CDP
// mouse hit-testing), and synthetic pointer events can't either (isTrusted gate). A CDP key
// event, however, is delivered as a genuinely-trusted event to whatever element is focused —
// it needs no coordinates and no mouse hit-test. Focus the element in-page first, then press
// Enter here. A focused <a>/<button> activated by Enter fires the same trusted click the
// modal handler requires.
// Attach the debugger ONCE, focus the target element via Runtime.evaluate, and press a
// trusted Enter — all in the SAME session, so focus can't be lost between focusing and the
// keypress (confirmed problem: focusing in one call and then attaching+Enter in a separate
// call reported focused:true but opened no modal — the element was blurred by the time Enter
// fired). `focusExpression` is a self-contained JS expression that focuses the intended
// element and returns { focused: bool, ... }.
async function cdpFocusAndEnter(tabId, focusExpression) {
  const send = (method, params) => new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    const evalRes = await send('Runtime.evaluate', { expression: focusExpression, returnByValue: true });
    const state = evalRes?.result?.value || {};
    console.log('[LeadPilot BG] cdpFocusAndEnter — focus state:', JSON.stringify(state));
    if (state.focused !== true) return { focused: false, state };
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await send('Input.dispatchKeyEvent', { type: 'char', ...key, text: '\r', unmodifiedText: '\r' });
    await new Promise(r => setTimeout(r, 40));
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    return { focused: true, entered: true, state };
  } catch (e) {
    console.warn('[LeadPilot BG] cdpFocusAndEnter failed:', e.message);
    return { focused: false, error: e.message };
  } finally {
    try { await new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve())); } catch (_) {}
  }
}

// Focus the profile's own Connect control and activate it with a trusted Enter (one session).
async function focusConnectAndEnter(tabId, anchorX, anchorY, maxDist) {
  const expr = `(function(){
    var ax=${anchorX}, ay=${anchorY}, md=${maxDist};
    var h1=document.querySelector('h1');
    var owner=((h1&&h1.textContent||'').trim()||(document.title||'').split(/[-|]/)[0].trim()).split(/\\s+/)[0];
    owner=owner?owner.toLowerCase():'';
    function isC(l){return l==='connect'||(owner&&l.indexOf('invite')>=0&&l.indexOf('to connect')>=0&&l.indexOf(owner)>=0);}
    var all=[].slice.call(document.querySelectorAll('a,button,div,li,span,[role]'));
    var m=all.filter(function(el){return isC(((el.getAttribute('aria-label')||el.textContent||'').trim().toLowerCase()));})
      .map(function(el){var c=el.closest('button,a,[role="button"],[role="menuitem"]');var u=c||el;var r=u.getBoundingClientRect();return{u:u,r:r,d:Math.hypot(r.left+r.width/2-ax,r.top+r.height/2-ay),real:!!c};})
      .filter(function(c){return c.r.width>0&&c.r.height>0&&c.d<=md;})
      .sort(function(a,b){return (a.real!==b.real)?(a.real?-1:1):(a.d-b.d);});
    if(!m.length) return {focused:false,reason:'nomatch'};
    var t=m[0].u; t.scrollIntoView({block:'center'});
    try{t.focus({preventScroll:true});}catch(e){try{t.focus();}catch(e2){}}
    return {focused:(document.activeElement===t||t.contains(document.activeElement)),tag:t.tagName};
  })()`;
  const res = await cdpFocusAndEnter(tabId, expr);
  return !!(res && res.focused && res.entered);
}

// ── Trusted CDP click that MEASURES the target inside the same attached session ──
// cdpClick() measures the element's coordinates BEFORE attaching the debugger, but attaching
// pops the "extension is debugging this browser" infobar which pushes the whole page down by
// ~40px — so the trusted click then lands ABOVE the intended element and silently misses
// (confirmed failure mode on the More-menu "Connect" item: a one-shot cdpClick left the
// dropdown open). Measuring the element's live viewport center INSIDE the attached session
// (banner already present) puts the coordinates in the exact same space CDP's input pipeline
// uses. A coordinate mouse click also lands on the innermost element, so event.target is the
// real inner control the site's delegated handler expects — unlike a keyboard Enter on the
// wrapping <a>, whose click has target=<a> and is ignored. Finds the "Connect"/"Invite {owner}
// to connect" control nearest the anchor, scrolls it into view, and clicks its fresh center.
async function cdpMeasureAndClickConnectNear(tabId, anchorX, anchorY, maxDist) {
  const send = (method, params) => new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    const expr = `(function(){
      var ax=${anchorX}, ay=${anchorY}, md=${maxDist};
      var h1=document.querySelector('h1');
      var owner=((h1&&h1.textContent||'').trim()||(document.title||'').split(/[-|]/)[0].trim()).split(/\\s+/)[0];
      owner=owner?owner.toLowerCase():'';
      function isC(l){return l==='connect'||(owner&&l.indexOf('invite')>=0&&l.indexOf('to connect')>=0&&l.indexOf(owner)>=0);}
      var all=[].slice.call(document.querySelectorAll('a,button,div,li,span,[role]'));
      var m=all.filter(function(el){return isC(((el.getAttribute('aria-label')||el.textContent||'').trim().toLowerCase()));})
        .map(function(el){var c=el.closest('button,a,[role="button"],[role="menuitem"]');var u=c||el;var r=u.getBoundingClientRect();return{u:u,r:r,d:Math.hypot(r.left+r.width/2-ax,r.top+r.height/2-ay),real:!!c};})
        .filter(function(c){return c.r.width>0&&c.r.height>0&&c.d<=md;})
        .sort(function(a,b){return (a.real!==b.real)?(a.real?-1:1):(a.d-b.d);});
      if(!m.length) return {ok:false};
      var t=m[0].u; t.scrollIntoView({block:'center'});
      var r=t.getBoundingClientRect();
      var cx=r.left+r.width/2, cy=r.top+r.height/2;
      function hits(el){return !!el&&(el===t||t.contains(el)||(el.closest&&el.closest('button,a,[role="button"],[role="menuitem"]')===t));}
      function desc(el){return el?(el.tagName+(typeof el.className==='string'&&el.className?('.'+el.className.split(/\\s+/).slice(0,2).join('.')):'')):'null';}
      // What element is actually painted at the box-center? If a trusted click keeps missing,
      // either an overlay covers the item or the coordinate is off (the debugger infobar can
      // shift the visual viewport). If the center doesn't land on the item, scan a grid of
      // points within its rect for one that genuinely hits it, and click THAT — this corrects
      // both a partial overlay and a small vertical offset instead of clicking dead space.
      var efC=document.elementFromPoint(cx,cy);
      var x=cx, y=cy, corrected=false;
      if(!hits(efC)){
        var found=false;
        for(var fy=0.2; fy<=0.8 && !found; fy+=0.15){
          for(var fx=0.2; fx<=0.8 && !found; fx+=0.15){
            var px=r.left+r.width*fx, py=r.top+r.height*fy;
            if(hits(document.elementFromPoint(px,py))){ x=px; y=py; corrected=true; found=true; }
          }
        }
      }
      return {ok:true, x:x, y:y, tag:t.tagName, hit:desc(efC), hitIsItemAtCenter:hits(efC), corrected:corrected, hitAtClick:desc(document.elementFromPoint(x,y))};
    })()`;
    const evalRes = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const s = evalRes?.result?.value || {};
    if (!s.ok) return { clicked: false, reason: 'nomatch' };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x, y: s.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x, y: s.y, button: 'left', clickCount: 1 });
    return { clicked: true, x: s.x, y: s.y, tag: s.tag, hit: s.hit, hitIsItemAtCenter: s.hitIsItemAtCenter, corrected: s.corrected, hitAtClick: s.hitAtClick };
  } catch (e) {
    console.warn('[LeadPilot BG] cdpMeasureAndClickConnectNear failed:', e.message);
    return { clicked: false, error: e.message };
  } finally {
    try { await new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve())); } catch (_) {}
  }
}

// ── Open "More" AND click its "Connect" MENU ITEM in ONE debugger session ─────
// Two hard lessons baked into this, both from real data on Renu Bisht's profile:
//  1. SAFETY: the profile's "People similar to X" sidebar renders Connect BUTTONS for OTHER
//     people. A page-wide/nearest-"Connect" search matched one of those and actually sent an
//     invite to the wrong person (confirmed: a suggested person flipped to "Pending"). So we
//     now accept ONLY a Connect that lives inside the open overflow dropdown menu
//     (role="menuitem", or a descendant of [role="menu"]/.artdeco-dropdown__content) — a
//     suggested-people card button is never inside that menu and can no longer be clicked.
//  2. RELIABILITY: doing More-click and Connect-click in separate debugger sessions let the
//     attach/detach churn tear the menu down between steps. Keep ONE session for the whole
//     sequence, and measure the "More" button FRESH inside that session (not with coordinates
//     captured in an earlier, separate scan) so the trusted click lands on it.
async function cdpOpenMoreAndClickConnect(tabId, note, directConnect = false) {
  const send = (method, params) => new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
  const evalV = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.value;
  };
  const clickAt = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  // Find a modal action button by label, PIERCING OPEN SHADOW DOM (the invite modal lives in a
  // shadow root) and SCOPED to the modal's dialog container (anchored on invite-only text or the
  // note textarea) so bare "Send" can never hit the messaging widget. Returns coords + disabled.
  const buttonExpr = (labels) => `(function(){
    var wanted=${JSON.stringify(labels)};
    function deepAll(rootEl){var out=[];function walk(root){var els;try{els=root.querySelectorAll('*');}catch(e){return;}for(var i=0;i<els.length;i++){out.push(els[i]);if(els[i].shadowRoot)walk(els[i].shadowRoot);}}walk(rootEl);return out;}
    function lbl(el){return ((el.getAttribute&&(el.getAttribute('aria-label')||''))||el.textContent||'').trim().toLowerCase();}
    var all=deepAll(document);
    var anchor=null;
    for(var i=0;i<all.length;i++){var l=lbl(all[i]);if(l.indexOf('send without a note')>=0||l.indexOf('add a note to your invitation')>=0||l==='add a note'){anchor=all[i];break;}}
    if(!anchor){for(var i=0;i<all.length;i++){if(all[i].tagName==='TEXTAREA'){anchor=all[i];break;}}}
    var root=null;
    if(anchor){var p=anchor;for(var k=0;k<12&&p;k++){var rr=p.getBoundingClientRect?p.getBoundingClientRect():null;if(rr&&rr.width>=200&&rr.height>=120){root=p;if(rr.width>=300&&rr.height>=180)break;}var par=p.parentElement;if(!par){var rn=p.getRootNode&&p.getRootNode();par=rn&&rn.host?rn.host:null;}p=par;}}
    var scope=root?deepAll(root):all;
    for(var w=0;w<wanted.length;w++){
      var want=wanted[w];
      var cands=[];
      for(var i=0;i<scope.length;i++){var el=scope[i];var l=lbl(el);if(l===want||(want.length>=5&&l.indexOf(want)>=0)){var r=el.getBoundingClientRect();if(r.width>0&&r.height>0)cands.push({el:el,r:r});}}
      if(!cands.length)continue;
      cands.sort(function(a,b){return (b.r.width*b.r.height)-(a.r.width*a.r.height);});
      var raw=cands[0].el;
      var t=(raw.closest&&raw.closest('a,button,[role="button"]'))||raw;
      var disabled=t.disabled||t.getAttribute('aria-disabled')==='true';
      t.scrollIntoView({block:'center'});
      var r2=t.getBoundingClientRect();
      return {ok:true,x:r2.left+r2.width/2,y:r2.top+r2.height/2,disabled:disabled,matched:want,scoped:!!root,label:(t.textContent||t.getAttribute('aria-label')||'').trim().slice(0,30)};
    }
    return {ok:false,scoped:!!root};
  })()`;
  // Fill the note textarea (value + input/change events so React registers it), piercing shadow DOM.
  const fillExpr = `(function(){
    var ta=null;function walk(root){if(ta)return;var els;try{els=root.querySelectorAll('textarea');}catch(e){return;}if(els.length){ta=els[0];return;}var all;try{all=root.querySelectorAll('*');}catch(e){return;}for(var i=0;i<all.length;i++){if(all[i].shadowRoot){walk(all[i].shadowRoot);if(ta)return;}}}
    walk(document);
    if(!ta) return {filled:false};
    var val=${JSON.stringify((note || '').slice(0, 300))};
    ta.focus();
    var setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value');
    if(setter&&setter.set)setter.set.call(ta,val);else ta.value=val;
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.dispatchEvent(new Event('change',{bubbles:true}));
    return {filled:ta.value===val};
  })()`;
  // Locate the profile action-row "More" button (exclude the sticky top-nav "More" at y≈0).
  const moreExpr = `(function(){
    var btns=[].slice.call(document.querySelectorAll('button'));
    var m=btns.filter(function(b){var l=(b.getAttribute('aria-label')||b.title||b.textContent||'').trim().toLowerCase();return l==='more'||l.indexOf('more actions')>=0;})
      .map(function(b){var r=b.getBoundingClientRect();return{b:b,r:r,py:r.top+window.scrollY};})
      .filter(function(c){return c.r.width>0&&c.r.height>0&&c.py>100&&c.py<=1600;})
      .sort(function(a,b){return a.py-b.py;});
    if(!m.length) return {ok:false};
    var t=m[0].b; t.scrollIntoView({block:'center'});
    var r=t.getBoundingClientRect();
    return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2};
  })()`;
  // Locate the profile's OWN "Connect" control (direct-connect profiles) and return its fresh
  // viewport-center. Measured INSIDE this debugger session so the coordinates match the CDP click's
  // coordinate space exactly — the old out-of-session measureConnectNear returned coords that missed
  // the button (x=244 vs the real ~102), so the trusted click landed in dead space and no modal
  // opened. Prefers the control whose aria-label names the PROFILE OWNER ("Invite {owner} to
  // connect") over the generic "Connect" of "People similar to X" cards, then the topmost.
  const connectExpr = `(function(){
    var owner=(((document.querySelector('h1')&&document.querySelector('h1').textContent)||'').trim().split(/\\s+/)[0]||'').toLowerCase();
    function lbl(el){return ((el.getAttribute&&(el.getAttribute('aria-label')||''))||el.textContent||'').trim().toLowerCase();}
    var els=[].slice.call(document.querySelectorAll('button,a,[role="button"]'));
    var m=els.map(function(el){return{el:el,l:lbl(el)};})
      .filter(function(c){return c.l==='connect'||(c.l.indexOf('invite')>=0&&c.l.indexOf('to connect')>=0);})
      .map(function(c){var r=c.el.getBoundingClientRect();return{el:c.el,l:c.l,r:r,py:r.top+window.scrollY};})
      .filter(function(c){return c.r.width>0&&c.r.height>0&&c.py>100&&c.py<=800;})
      .sort(function(a,b){var ao=owner&&a.l.indexOf(owner)>=0,bo=owner&&b.l.indexOf(owner)>=0;if(ao!==bo)return ao?-1:1;return a.py-b.py;});
    if(!m.length) return {ok:false};
    var t=m[0].el; t.scrollIntoView({block:'center'});
    var r=t.getBoundingClientRect();
    return {ok:true,x:r.left+r.width/2,y:r.top+r.height/2,label:m[0].l};
  })()`;
  // Find the "Connect" item STRICTLY inside the open overflow menu, grid-correct the click
  // point to a pixel that actually lands on it, and return it. Returns menuCount so a missing
  // menu (never opened) is distinguishable from a menu with no Connect item.
  const findExpr = `(function(){
    function hits(t,el){return !!el&&(el===t||t.contains(el)||(el.closest&&el.closest('a,button,[role="button"],[role="menuitem"]')===t));}
    function desc(el){return el?(el.tagName+(typeof el.className==='string'&&el.className?('.'+el.className.split(/\\s+/).slice(0,2).join('.')):'')):'null';}
    var menus=[].slice.call(document.querySelectorAll('[role="menu"], .artdeco-dropdown__content'))
      .filter(function(mn){var r=mn.getBoundingClientRect();return r.width>0&&r.height>0;});
    var pool=[];
    menus.forEach(function(mn){pool=pool.concat([].slice.call(mn.querySelectorAll('a,button,div,li,span,[role]')));});
    pool=pool.concat([].slice.call(document.querySelectorAll('[role="menuitem"]')));
    var seen=[], items=[];
    pool.forEach(function(el){ if(seen.indexOf(el)<0){ seen.push(el);
      var l=(el.getAttribute('aria-label')||el.textContent||'').trim().toLowerCase();
      if(l==='connect'||(l.indexOf('invite')>=0&&l.indexOf('to connect')>=0)) items.push(el);
    }});
    var m=items.map(function(el){var c=el.closest('a,button,[role="button"],[role="menuitem"]')||el;var r=c.getBoundingClientRect();return{u:c,r:r};})
      .filter(function(c){return c.r.width>0&&c.r.height>0;});
    if(!m.length) return {ok:false, menus:menus.length};
    m.sort(function(a,b){var am=a.u.getAttribute('role')==='menuitem',bm=b.u.getAttribute('role')==='menuitem';if(am!==bm)return am?-1:1;return (b.r.width*b.r.height)-(a.r.width*a.r.height);});
    var t=m[0].u; t.scrollIntoView({block:'center'});
    var r=t.getBoundingClientRect();
    var cx=r.left+r.width/2, cy=r.top+r.height/2, x=cx, y=cy, corrected=false;
    if(!hits(t,document.elementFromPoint(cx,cy))){
      var found=false;
      for(var fy=0.25; fy<=0.75 && !found; fy+=0.25){
        for(var fx=0.2; fx<=0.8 && !found; fx+=0.2){
          var px=r.left+r.width*fx, py=r.top+r.height*fy;
          if(hits(t,document.elementFromPoint(px,py))){x=px;y=py;corrected=true;found=true;}
        }
      }
    }
    return {ok:true,x:x,y:y,tag:t.tagName,role:t.getAttribute('role'),hitAtClick:desc(document.elementFromPoint(x,y)),corrected:corrected,menus:menus.length};
  })()`;
  // True while the invite modal is open, in EITHER state — the initial "Add a note / Send without
  // a note" choice, OR the note-writing state (textarea + "Send"). PIERCES OPEN SHADOW DOM (the
  // modal renders in a shadow root, so a plain querySelectorAll always returned false and made us
  // wrongly bail / falsely conclude "sent"). Used both to detect the modal opening and to confirm
  // it CLOSED after Send (all signals gone → submitted).
  const modalExpr = `(function(){
    function deepAll(){var out=[];function walk(root){var els;try{els=root.querySelectorAll('*');}catch(e){return;}for(var i=0;i<els.length;i++){out.push(els[i]);if(els[i].shadowRoot)walk(els[i].shadowRoot);}}walk(document);return out;}
    function vis(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
    function lbl(el){return ((el.getAttribute&&(el.getAttribute('aria-label')||''))||el.textContent||'').trim().toLowerCase();}
    var all=deepAll(), hasSW=false,hasAN=false,hasTA=false,hasSend=false;
    for(var i=0;i<all.length;i++){var el=all[i];if(!vis(el))continue;var l=lbl(el);
      if(l.indexOf('send without a note')>=0)hasSW=true;
      else if(l==='add a note'||l.indexOf('add a note to your invitation')>=0)hasAN=true;
      if(el.tagName==='TEXTAREA')hasTA=true;
      if(l==='send'||l==='send invitation')hasSend=true;
    }
    // Invite-UNIQUE signals ONLY. The old "hasTA && hasSend" fallback also matched the LinkedIn
    // MESSAGING widget (always present on a profile — it has a textarea + a "Send" button), which
    // falsely reported the invite modal as "open", then as "closed → sent" when the widget flickered
    // away. On profiles where the modal renders in an iframe this main-frame eval can't see it at all;
    // returning false here is correct — it makes the caller fall through to handleModalAcrossFrames.
    return hasSW||hasAN;
  })()`;
  // Tight-poll for a modal button and CLICK it the instant it appears. The invite modal on many
  // profiles is a fleeting preload render (present when detected, gone ~150ms later), so any gap
  // between locating the button and clicking loses the race. Polling the button directly (rather
  // than detecting the modal, then separately locating the button, then clicking) collapses that
  // gap to a single eval→click. Returns as soon as it clicks, hits a disabled button, or times out.
  const tightClickBtn = async (labels, budgetMs) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < budgetMs) {
      const b = await evalV(buttonExpr(labels));
      last = b;
      if (b && b.ok && !b.disabled) { await clickAt(b.x, b.y); return { clicked: true, label: b.label, x: b.x, y: b.y }; }
      if (b && b.disabled) return { clicked: false, disabled: true, label: b.label };
      await new Promise(r => setTimeout(r, 70));
    }
    return { clicked: false, last };
  };
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    // ── Open the invite modal, IN-SESSION, with a genuinely TRUSTED CDP click ────────────────
    // LinkedIn gates the Connect control on isTrusted (a synthetic click won't open the modal),
    // AND re-attaching the debugger later dismisses the modal — so the ONLY reliable path is to
    // stay in ONE session from the opening click through Send. Measuring the target INSIDE this
    // session keeps the coordinates in the same space as the click (fixes the "click missed the
    // button → no modal" flakiness). Direct-connect profiles click the profile's own Connect;
    // otherwise open "More" and click its "Connect" menu item.
    let target = null;
    if (directConnect) {
      // Measure + trusted-click the Connect control, retrying — a lazy layout shift can mis-measure
      // it once, and a single missed click opens nothing. We do NOT poll modalExpr here: the modal
      // is a fleeting preload render, so detecting it separately then locating the button loses the
      // race. Instead we go straight into the tight button-race below, which IS the modal signal.
      for (let attempt = 0; attempt < 3 && !target; attempt++) {
        const c = await evalV(connectExpr);
        if (!c || !c.ok) { await new Promise(r => setTimeout(r, 500)); continue; }
        target = c;
        console.log('[LeadPilot BG] cdpOpenMoreAndClickConnect(direct) — Connect measured:', JSON.stringify(c), 'attempt', attempt + 1);
        await clickAt(c.x, c.y);
      }
      if (!target) return { opened: false, reason: 'connect-button-not-found' };
    } else {
      // Measure "More" fresh inside this session, then click it to open the menu.
      const more = await evalV(moreExpr);
      if (!more || !more.ok) return { opened: false, reason: 'more-button-not-found' };
      await clickAt(more.x, more.y);
      // Poll for the Connect item to appear inside the open menu.
      let lastFind = null;
      for (let i = 0; i < 16; i++) {
        await new Promise(r => setTimeout(r, 300));
        lastFind = await evalV(findExpr);
        if (lastFind && lastFind.ok) { target = lastFind; break; }
      }
      if (!target) return { opened: true, modalOpened: false, reason: 'no-connect-in-open-menu', lastFind };
      await clickAt(target.x, target.y);
    }

    // ── Drive the (fleeting) invite modal — tight-race every step, all IN-SESSION ────────────────
    // Never detach/re-attach here (that resizes the viewport and dismisses the modal). The modal on
    // many profiles is a preload render that vanishes ~150ms after appearing, so each step polls its
    // button directly and clicks the instant it renders. First action: with a note, open the note
    // field ("Add a note"); otherwise send straight from the choice screen ("Send without a note").
    let sendPath = 'none', modalOpened = false, clickedSend = false, lastSend = null;
    if (note && note.trim()) {
      const an = await tightClickBtn(['add a note'], 9000);
      if (an.disabled) return { opened: true, modalOpened: true, sent: false, sendPath, lastSend: { ok: true, disabled: true }, diag: target };
      if (an.clicked) {
        modalOpened = true;
        for (let i = 0; i < 40; i++) { // tight-poll for the note textarea to mount, then fill it
          const f = await evalV(fillExpr);
          if (f && f.filled) { sendPath = 'with-note'; break; }
          await new Promise(r => setTimeout(r, 120));
        }
      }
    }
    // Send. With a note we click "Send"; otherwise "Send without a note" (which both opens-and-sends
    // from the choice screen). buttonExpr is scoped to the invite dialog, so a bare "send" can't hit
    // the messaging widget — but we still prefer the unique labels first.
    const sendLabels = sendPath === 'with-note' ? ['send', 'send invitation'] : ['send without a note', 'send now'];
    const sc = await tightClickBtn(sendLabels, 9000);
    if (sc.clicked) { modalOpened = true; clickedSend = true; lastSend = { ok: true }; }
    else if (sc.disabled) { return { opened: true, modalOpened: true, sent: false, sendPath, lastSend: { ok: true, disabled: true }, diag: target }; }
    else { lastSend = { ok: false }; }

    // Verify submission: BOTH the invite-unique signals AND the send button must be gone (a silently
    // failed click in the note-writing state would otherwise be misread as success).
    let sent = false;
    if (clickedSend) {
      for (let i = 0; i < 8 && !sent; i++) {
        await new Promise(r => setTimeout(r, 400));
        const modalGone = !(await evalV(modalExpr));
        const btnNow = await evalV(buttonExpr(sendLabels));
        if (modalGone && (!btnNow || !btnNow.ok)) sent = true;
      }
    }
    console.log('[LeadPilot BG] cdpOpenMoreAndClickConnect — direct:', directConnect, '| sendPath:', sendPath, '| clickedSend:', clickedSend, '| sent:', sent);
    return { opened: true, modalOpened, sent, sendPath, lastSend, diag: target };
  } catch (e) {
    console.warn('[LeadPilot BG] cdpOpenMoreAndClickConnect failed:', e.message);
    return { opened: false, error: e.message };
  } finally {
    try { await new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve())); } catch (_) {}
  }
}

// ── Drive the invite modal ACROSS ALL FRAMES (+ open shadow DOM) ──────────────
// Confirmed via real data: on this profile the invite modal ("Add a note to your invitation?")
// renders in an IFRAME, not the main document — main-frame dialog/artdeco-modal count is 0 and a
// full main-document text search finds nothing while the modal is visibly open. Every previous
// "no modal detected → bail" was this: we were querying the wrong document. These functions run
// in EVERY frame (chrome.scripting allFrames / frameIds) and pierce OPEN shadow roots, so they
// find and drive the modal wherever it actually lives. Synthetic clicks are used because we're
// now clicking the correct element in the correct frame (the earlier "needs trusted click"
// belief was really "wrong frame").

// Self-contained (injected) — detects invite-modal controls in THIS frame, piercing open shadow DOM.
function _lpDetectModalInFrame() {
  const deep = () => {
    const out = [];
    const walk = (root) => {
      let els; try { els = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of els) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
    };
    walk(document);
    return out;
  };
  const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const lbl = el => (el.getAttribute && (el.getAttribute('aria-label') || '') || el.textContent || '').trim().toLowerCase();
  const els = deep();
  const hasAddNote = els.some(el => vis(el) && (lbl(el) === 'add a note' || lbl(el).includes('add a note to your invitation')));
  const hasSendWithout = els.some(el => vis(el) && lbl(el).includes('send without a note'));
  const hasSend = els.some(el => vis(el) && (lbl(el) === 'send' || lbl(el) === 'send invitation'));
  const hasTextarea = els.some(el => el.tagName === 'TEXTAREA' && vis(el));
  return { hasAddNote, hasSendWithout, hasSend, hasTextarea, href: location.href };
}

// Self-contained (injected) — synthetic-clicks a modal button by label in THIS frame.
function _lpClickInFrameByLabel(labels) {
  const deep = () => {
    const out = [];
    const walk = (root) => {
      let els; try { els = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of els) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
    };
    walk(document);
    return out;
  };
  const lbl = el => (el.getAttribute && (el.getAttribute('aria-label') || '') || el.textContent || '').trim().toLowerCase();
  const pool = deep();
  for (const want of labels) {
    const cands = pool.filter(el => { const l = lbl(el); return l === want || (want.length >= 5 && l.includes(want)); })
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(c => c.r.width > 0 && c.r.height > 0);
    if (!cands.length) continue;
    // Prefer a real control over a bare text span; among those, the largest.
    cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    const raw = cands[0].el;
    const target = (raw.closest && raw.closest('a,button,[role="button"]')) || raw;
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { clicked: false, disabled: true, matched: want };
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    try { target.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); } catch (_) {}
    target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    try { target.click(); } catch (_) {}
    return { clicked: true, matched: want, label: (target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 30) };
  }
  return { clicked: false };
}

// Self-contained (injected) — SCOPED synthetic click of an invite-modal button in THIS frame.
// Used for the MAIN frame (frame 0) instead of a CDP click: attaching chrome.debugger mid-modal
// pops the "started debugging this browser" infobar, which resizes the viewport / steals focus and
// DISMISSES LinkedIn's fragile invite modal before the click can land (confirmed: findModalFrame
// reported addNote+sendWithout, then the CDP click's fresh attach made Runtime.evaluate find nothing
// — scoped:false). This runs via chrome.scripting (NO debugger attach) so the modal stays open, and
// it SCOPES the search to the invite dialog container (anchored on invite-unique text or the note
// textarea) so a bare "Send" can never hit the persistent messaging widget outside the dialog.
function _lpScopedClickInvite(labels) {
  const deep = (rootEl) => {
    const out = [];
    const walk = (root) => {
      let els; try { els = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of els) { out.push(el); if (el.shadowRoot) walk(el.shadowRoot); }
    };
    walk(rootEl);
    return out;
  };
  const lbl = el => (el.getAttribute && (el.getAttribute('aria-label') || '') || el.textContent || '').trim().toLowerCase();
  const all = deep(document);
  // Anchor on a signal UNIQUE to the invite modal (never in the chat widget), or the note textarea.
  let anchor = null;
  for (const el of all) {
    const l = lbl(el);
    if (l.includes('send without a note') || l.includes('add a note to your invitation') || l === 'add a note') { anchor = el; break; }
  }
  if (!anchor) { for (const el of all) { if (el.tagName === 'TEXTAREA') { anchor = el; break; } } }
  // Walk up (crossing shadow boundaries) to a dialog-sized container to scope the search.
  let root = null;
  if (anchor) {
    let p = anchor;
    for (let k = 0; k < 12 && p; k++) {
      const rr = p.getBoundingClientRect ? p.getBoundingClientRect() : null;
      if (rr && rr.width >= 200 && rr.height >= 120) { root = p; if (rr.width >= 300 && rr.height >= 180) break; }
      let par = p.parentElement;
      if (!par) { const rn = p.getRootNode && p.getRootNode(); par = rn && rn.host ? rn.host : null; }
      p = par;
    }
  }
  const scope = root ? deep(root) : all;
  for (const want of labels) {
    const cands = scope.filter(el => { const l = lbl(el); return l === want || (want.length >= 5 && l.includes(want)); })
      .map(el => ({ el, r: el.getBoundingClientRect() }))
      .filter(c => c.r.width > 0 && c.r.height > 0);
    if (!cands.length) continue;
    cands.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height));
    const raw = cands[0].el;
    const target = (raw.closest && raw.closest('a,button,[role="button"]')) || raw;
    if (target.disabled || target.getAttribute('aria-disabled') === 'true') return { clicked: false, disabled: true, matched: want, scoped: !!root };
    target.scrollIntoView({ block: 'center' });
    const r = target.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
    try { target.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch (_) {}
    try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    try { target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); } catch (_) {}
    target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
    target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
    try { target.click(); } catch (_) {}
    return { clicked: true, matched: want, scoped: !!root, label: (target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 30) };
  }
  return { clicked: false, reason: 'nomatch', scoped: !!root };
}

// Self-contained (injected) — fills the note textarea in THIS frame (pierces open shadow DOM).
function _lpFillNoteInFrame(note) {
  const deep = () => {
    const out = [];
    const walk = (root) => {
      let els; try { els = root.querySelectorAll('textarea'); } catch (_) { return; }
      for (const el of els) out.push(el);
      let all; try { all = root.querySelectorAll('*'); } catch (_) { return; }
      for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return out;
  };
  const ta = deep()[0];
  if (!ta) return { filled: false };
  const val = (note || '').slice(0, 300);
  ta.focus();
  // React tracks the textarea value via its own internal value-tracker; a plain `ta.value = …`
  // is reverted on the next render and leaves "Send" disabled. Set through the native prototype
  // setter so React's onChange fires with the real value and enables the Send button.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(ta, val); else ta.value = val;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.dispatchEvent(new Event('change', { bubbles: true }));
  return { filled: ta.value === val, value: ta.value };
}

// Locate which frame currently holds the invite modal (null if none).
async function findModalFrame(tabId) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: _lpDetectModalInFrame });
  } catch (_) { return null; }
  const frames = (results || []).map(res => ({ frameId: res.frameId, ...(res.result || {}) }));
  // Invite-specific signals first ("Add a note"/"Send without a note" never appear in the chat
  // widget). Only then a textarea+Send frame (the note-writing step). A bare "Send" alone is NOT
  // enough — that would match the persistent messaging widget in the main frame.
  return frames.find(v => v.hasSendWithout || v.hasAddNote)
      || frames.find(v => v.hasTextarea && v.hasSend)
      || null;
}

// ── Trusted CDP click of a modal button, SCOPED to the modal's shadow-DOM container ──
// Confirmed via real data: the invite modal lives in the MAIN frame's OPEN shadow DOM, and the
// main frame also has the persistent messaging widget (its own "Send" button). A whole-frame
// synthetic click matched that widget's bare "Send", which is OUTSIDE the modal — clicking
// outside the dialog DISMISSES it without sending ("add-note/without-note se back ho jata hai").
// This function (a) scopes the search to the modal's dialog container by anchoring on a label
// unique to the invite modal (or the note textarea) and walking up across shadow boundaries,
// and (b) clicks with a genuinely-trusted CDP mouse event measured INSIDE the debugger session,
// which LinkedIn's modal action buttons require to actually submit. Main-frame only (the modal
// is in frame 0); the coordinates are main-viewport coordinates that CDP input uses directly.
async function cdpClickModalButton(tabId, labels) {
  const send = (method, params) => new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
  const expr = `(function(){
    var wanted=${JSON.stringify(labels)};
    function deepAll(rootEl){var out=[];function walk(root){var els;try{els=root.querySelectorAll('*');}catch(e){return;}for(var i=0;i<els.length;i++){out.push(els[i]);if(els[i].shadowRoot)walk(els[i].shadowRoot);}}walk(rootEl);return out;}
    function lbl(el){return ((el.getAttribute&&(el.getAttribute('aria-label')||''))||el.textContent||'').trim().toLowerCase();}
    var all=deepAll(document);
    // Anchor on a signal unique to the invite modal (never in the chat widget), or the textarea.
    var anchor=null;
    for(var i=0;i<all.length;i++){var l=lbl(all[i]);if(l.indexOf('send without a note')>=0||l.indexOf('add a note to your invitation')>=0||l==='add a note'){anchor=all[i];break;}}
    if(!anchor){for(var i=0;i<all.length;i++){if(all[i].tagName==='TEXTAREA'){anchor=all[i];break;}}}
    // Walk up (crossing shadow boundaries) to a dialog-sized container to scope the search.
    var root=null;
    if(anchor){var p=anchor;for(var k=0;k<12&&p;k++){var rr=p.getBoundingClientRect?p.getBoundingClientRect():null;if(rr&&rr.width>=200&&rr.height>=120){root=p;if(rr.width>=300&&rr.height>=180)break;}var par=p.parentElement;if(!par){var rn=p.getRootNode&&p.getRootNode();par=rn&&rn.host?rn.host:null;}p=par;}}
    var scope=root?deepAll(root):all;
    for(var w=0;w<wanted.length;w++){
      var want=wanted[w];
      var cands=[];
      for(var i=0;i<scope.length;i++){var el=scope[i];var l=lbl(el);if(l===want||(want.length>=5&&l.indexOf(want)>=0)){var r=el.getBoundingClientRect();if(r.width>0&&r.height>0)cands.push({el:el,r:r});}}
      if(!cands.length)continue;
      cands.sort(function(a,b){return (b.r.width*b.r.height)-(a.r.width*a.r.height);});
      var raw=cands[0].el;
      var t=(raw.closest&&raw.closest('a,button,[role="button"]'))||raw;
      var disabled=t.disabled||t.getAttribute('aria-disabled')==='true';
      t.scrollIntoView({block:'center'});
      var r2=t.getBoundingClientRect();
      return {ok:true,x:r2.left+r2.width/2,y:r2.top+r2.height/2,disabled:disabled,matched:want,scoped:!!root,label:(t.textContent||t.getAttribute('aria-label')||'').trim().slice(0,30)};
    }
    return {ok:false,scoped:!!root};
  })()`;
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve();
      });
    });
    const evalRes = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    const s = evalRes?.result?.value || {};
    if (!s.ok) return { clicked: false, reason: 'nomatch', scoped: s.scoped };
    if (s.disabled) return { clicked: false, disabled: true, matched: s.matched, label: s.label };
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: s.x, y: s.y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: s.x, y: s.y, button: 'left', clickCount: 1 });
    await new Promise(r => setTimeout(r, 60));
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: s.x, y: s.y, button: 'left', clickCount: 1 });
    return { clicked: true, matched: s.matched, label: s.label, scoped: s.scoped, x: s.x, y: s.y };
  } catch (e) {
    console.warn('[LeadPilot BG] cdpClickModalButton failed:', e.message);
    return { clicked: false, error: e.message };
  } finally {
    try { await new Promise(resolve => chrome.debugger.detach({ tabId }, () => resolve())); } catch (_) {}
  }
}

// Detect the invite modal in whatever frame it lives, fill the note (if any), and click Send.
async function handleModalAcrossFrames(tabId, note, leadEmail) {
  let mf = null;
  for (let i = 0; i < 40; i++) { // slow page → up to ~16s for the modal frame to appear
    await new Promise(r => setTimeout(r, 400));
    mf = await findModalFrame(tabId);
    if (mf) break;
  }
  if (!mf) return { modalFound: false };
  console.log('[LeadPilot BG] Modal frame found:', mf.frameId, '| flags:', JSON.stringify({ addNote: mf.hasAddNote, sendWithout: mf.hasSendWithout, send: mf.hasSend, textarea: mf.hasTextarea, href: mf.href }));

  const inFrame = async (func, args) => {
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [mf.frameId] }, func, args });
      return res?.result;
    } catch (e) { return { error: e.message }; }
  };

  // Click a modal button with a SCOPED SYNTHETIC click in whatever frame the modal lives (no
  // chrome.debugger). Previously frame-0 modals used a CDP click, but its fresh debugger attach
  // dismissed the invite modal before the click landed (infobar/viewport resize — confirmed:
  // findModalFrame saw addNote+sendWithout, then the CDP eval found nothing, scoped:false). The
  // scoped click anchors on invite-UNIQUE text / the note textarea, so a bare "Send" can never
  // reach the persistent messaging widget outside the dialog — which is the only reason CDP was
  // used here in the first place.
  const clickModalBtn = async (labels) => {
    const r = await inFrame(_lpScopedClickInvite, [labels]);
    return { clicked: !!(r && r.clicked), disabled: !!(r && r.disabled), matched: r && r.matched, label: r && r.label, scoped: r && r.scoped };
  };

  // Prefer sending WITH the note if one was provided and the modal offers an "Add a note" step.
  let sendPath = 'none';
  if (note && note.trim() && mf.hasAddNote && !mf.hasTextarea) {
    await clickModalBtn(['add a note']);
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 400));
      const f = await inFrame(_lpFillNoteInFrame, [note]);
      if (f && f.filled) { sendPath = 'with-note'; break; }
    }
  } else if (note && note.trim() && mf.hasTextarea) {
    const f = await inFrame(_lpFillNoteInFrame, [note]);
    if (f && f.filled) sendPath = 'with-note';
  }

  // Send labels: NEVER a bare "send" in the no-note case — that matches the messaging widget and
  // dismisses the modal. "send without a note" is unique to the invite modal. Bare "send" is only
  // used in the note-writing step (a textarea is present), and even then the click is scoped to
  // the modal container.
  const sendLabels = sendPath === 'with-note'
    ? ['send', 'send invitation']
    : ['send without a note', 'send now'];
  let sent = false, lastClick = null;
  for (let i = 0; i < 8 && !sent; i++) {
    lastClick = await clickModalBtn(sendLabels);
    if (lastClick && lastClick.disabled) {
      return { modalFound: true, sent: false, disabled: true, sendPath, lastClick };
    }
    // CRITICAL: only conclude "sent" if we ACTUALLY clicked the button AND the modal then closed.
    // Previously a "nomatch" (clicked:false — button not found) followed by the modal being gone
    // was wrongly reported as sent (false positive: app showed Pending but LinkedIn still showed
    // Connect). If the button wasn't found this pass, wait and retry — the modal may still be
    // rendering (shadow DOM on a slow page).
    if (!lastClick || !lastClick.clicked) { await new Promise(r => setTimeout(r, 600)); continue; }
    await new Promise(r => setTimeout(r, 1000));
    const still = await findModalFrame(tabId);
    if (!still) { sent = true; break; } // we clicked the real Send and the modal closed → submitted
  }
  console.log('[LeadPilot BG] handleModalAcrossFrames — sendPath:', sendPath, '| sent:', sent, '| lastClick:', JSON.stringify(lastClick));
  return { modalFound: true, sent, sendPath, lastClick, disabled: lastClick && lastClick.disabled === true };
}

// ── In-page pointer click of a "Connect" element BY IDENTITY (not coordinates) ──
// Confirmed via real data: clicking the "More" menu's Connect item by COORDINATES is flaky
// — the dropdown scrolls internally so elementFromPoint(x,y) sometimes lands off the item
// (one run closed the dropdown, the next didn't, same profile). Finding the element itself
// by text/proximity in-page and dispatching the pointer sequence directly on it removes the
// coordinate dependency entirely. Retries a few times because the item can still be settling.
async function pointerClickConnectNear(tabId, anchorX, anchorY, maxDist, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const [{ result }] = await safeExecuteScript({
      target: { tabId },
      args: [anchorX, anchorY, maxDist],
      func: (ax, ay, md) => {
        const describe = el => {
          const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).slice(0, 3).join('.');
          return el.tagName
            + (el.id ? '#' + el.id : '')
            + (cls ? '.' + cls : '')
            + '[role=' + (el.getAttribute('role') || '-') + ']'
            + (el.getAttribute('href') ? ' href=' + el.getAttribute('href').slice(0, 40) : '')
            + (el.getAttribute('aria-label') ? ' aria="' + el.getAttribute('aria-label').slice(0, 30) + '"' : '');
        };
        const matches = [...document.querySelectorAll('a, button, div, li, span, [role]')]
          .filter(el => (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase() === 'connect')
          .map(el => {
            // Resolve to the nearest real clickable control; measure/click THAT. A bare
            // <div>/<span> labelled "Connect" (confirmed: the "People similar to X" cards
            // and decoy labels) has no handler — clicking it does nothing.
            const clickable = el.closest('button, a, [role="button"], [role="menuitem"]');
            const useEl = clickable || el;
            const r = useEl.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            return { rawEl: el, useEl, r, dist: Math.hypot(cx - ax, cy - ay), isReal: !!clickable };
          })
          .filter(c => c.r.width > 0 && c.r.height > 0 && c.dist <= md)
          // Prefer a real control over dead text; among those, nearest to the anchor.
          .sort((a, b) => (a.isReal !== b.isReal) ? (a.isReal ? -1 : 1) : (a.dist - b.dist));
        // Diagnostic: describe every nearby candidate + its resolved click target so we can
        // see exactly what element the modal-opening click is (or isn't) landing on.
        const candidatesDump = matches.slice(0, 6).map(c =>
          'raw=' + describe(c.rawEl) + ' | clicks=' + describe(c.useEl) + ' | y=' + Math.round(c.r.top + window.scrollY) + ' dist=' + Math.round(c.dist));
        if (!matches.length) return { clicked: false, reason: 'no visible connect element near anchor' };
        const target = matches[0].useEl;
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, composed: true, view: window,
          clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
        try { target.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
        try { target.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch (_) {}
        try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        try { target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); } catch (_) {}
        target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
        try { target.click(); } catch (_) {}
        return { clicked: true, target: describe(target), outerHTML: target.outerHTML.slice(0, 200), candidatesDump };
      },
    });
    console.log(`[LeadPilot BG] pointerClickConnectNear attempt ${i + 1}:`, JSON.stringify(result));
    if (result?.clicked) return true;
    await new Promise(r => setTimeout(r, 350));
  }
  return false;
}

// Re-measure the real Connect control's on-screen center RIGHT BEFORE a CDP click, mirroring
// the SN-menu resolver's "re-measure before clicking" fix. The coordinates captured back in
// the initial scan can be stale (layout shift, focus change, lazy content), so a trusted CDP
// click at those old coords silently misses. Finds the same element the pointer path targets
// (the profile's own "Connect"/"Invite {owner} to connect" control), scrolls it into view,
// and returns its fresh viewport-center coordinates.
async function measureConnectNear(tabId, anchorX, anchorY, maxDist) {
  try {
    const [{ result }] = await safeExecuteScript({
      target: { tabId },
      args: [anchorX, anchorY, maxDist],
      func: (ax, ay, md) => {
        const owner = ((document.querySelector('h1')?.textContent || '').trim()
          || (document.title || '').split(/[-|]/)[0].trim()).split(/\s+/)[0]?.toLowerCase() || '';
        const isConnectLabel = l =>
          l === 'connect' || (owner && l.includes('invite') && l.includes('to connect') && l.includes(owner));
        const matches = [...document.querySelectorAll('a, button, div, li, span, [role]')]
          .filter(el => isConnectLabel((el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase()))
          .map(el => {
            const clickable = el.closest('button, a, [role="button"], [role="menuitem"]');
            const useEl = clickable || el;
            const r = useEl.getBoundingClientRect();
            return { useEl, r, dist: Math.hypot(r.left + r.width / 2 - ax, r.top + r.height / 2 - ay), isReal: !!clickable };
          })
          .filter(c => c.r.width > 0 && c.r.height > 0 && c.dist <= md)
          .sort((a, b) => (a.isReal !== b.isReal) ? (a.isReal ? -1 : 1) : (a.dist - b.dist));
        if (!matches.length) return null;
        const t = matches[0].useEl;
        t.scrollIntoView({ block: 'center' });
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
    });
    return result || null;
  } catch (_) { return null; }
}

// ── In-page pointer click of a MODAL button (Add a note / Send without a note / Send) ──
// The invite modal's action buttons are React controls too, so a CDP mouse-only click
// doesn't fire them (confirmed: modal opens, "Send without a note" visible, but a cdpClick
// on it does nothing and the flow hangs on the open modal). Scope the search to the modal
// container so the bare word "Send" can't match LinkedIn's persistent chat widget, then
// dispatch a real pointer sequence on the button. `wantedLabels` are tried in priority
// order (exact match, or substring for multi-word phrases). Returns { clicked, disabled }.
async function pointerClickButtonInModal(tabId, wantedLabels, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const [{ result }] = await safeExecuteScript({
      target: { tabId },
      args: [wantedLabels],
      func: (wanted) => {
        // Locate the modal container (same strategy as the modal scan).
        let root = null;
        const dialogs = [...document.querySelectorAll('[role="dialog"], .artdeco-modal, [data-test-modal]')]
          .map(el => ({ el, r: el.getBoundingClientRect(), txt: (el.textContent || '').toLowerCase() }))
          .filter(c => c.r.width >= 200 && c.r.height >= 100);
        root = (dialogs.find(c => c.txt.includes('invitation') || c.txt.includes('add a note') || c.txt.includes('send without'))
          || dialogs.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0] || {}).el || null;
        if (!root) {
          let bestZ = -1;
          for (const el of document.querySelectorAll('*')) {
            const cs = getComputedStyle(el);
            if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
            const z = parseInt(cs.zIndex, 10);
            if (isNaN(z) || z <= bestZ) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 250 || r.height < 150) continue;
            bestZ = z; root = el;
          }
        }
        const containerFound = !!root;
        const pool = [...(root || document).querySelectorAll('a, button, div, li, span, [role]')];
        for (const w of wanted) {
          // Bare "send" is only safe scoped to a real container (the chat widget also has one).
          if (w === 'send' && !containerFound) continue;
          const cands = pool.filter(el => {
            const label = (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
            return label === w || (w.length >= 5 && label.includes(w));
          }).map(el => { const r = el.getBoundingClientRect(); return { el, r }; })
            .filter(c => c.r.width > 0 && c.r.height > 0);
          if (!cands.length) continue;
          cands.sort((a, b) => {
            const aSpan = a.el.tagName === 'SPAN', bSpan = b.el.tagName === 'SPAN';
            if (aSpan !== bSpan) return aSpan ? 1 : -1;
            return (b.r.width * b.r.height) - (a.r.width * a.r.height);
          });
          const raw = cands[0].el;
          const target = raw.closest('button, a, [role="button"], [role="menuitem"]') || raw;
          if (target.disabled || target.getAttribute('aria-disabled') === 'true') {
            return { clicked: false, disabled: true, matched: w, containerFound };
          }
          target.scrollIntoView({ block: 'center' });
          const r = target.getBoundingClientRect();
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const opts = { bubbles: true, cancelable: true, composed: true, view: window,
            clientX: cx, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' };
          try { target.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (_) {}
          try { target.dispatchEvent(new PointerEvent('pointerenter', opts)); } catch (_) {}
          try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
          target.dispatchEvent(new MouseEvent('mousedown', opts));
          try { target.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 })); } catch (_) {}
          target.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
          target.dispatchEvent(new MouseEvent('click', { ...opts, buttons: 0 }));
          try { target.click(); } catch (_) {}
          return { clicked: true, matched: w, label: (target.textContent || target.getAttribute('aria-label') || '').trim().slice(0, 30), containerFound, rect: { x: cx, y: cy } };
        }
        return { clicked: false, reason: 'no matching button', containerFound };
      },
    });
    console.log(`[LeadPilot BG] pointerClickButtonInModal attempt ${i + 1}:`, JSON.stringify(result));
    if (result?.clicked) return result;
    if (result?.disabled) return result; // caller decides what a disabled button means
    await new Promise(r => setTimeout(r, 350));
  }
  return { clicked: false };
}

// Is the invite modal still open? Uses the same unique-phrase signals as the modal scan.
async function inviteModalStillOpen(tabId) {
  try {
    const [{ result }] = await safeExecuteScript({
      target: { tabId },
      func: () => {
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const lbl = el => (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
        return [...document.querySelectorAll('a, button, div, li, span, [role]')]
          .some(el => vis(el) && (lbl(el).includes('send without a note') || lbl(el) === 'add a note' || lbl(el).includes('add a note to your invitation')));
      },
    });
    return !!result;
  } catch (_) { return false; }
}

// ── Robust modal-button click: pointer first, then trusted CDP if the modal stays open ──
// Same lesson as the Connect trigger — some modal buttons only fire on a genuinely-trusted
// click. Click via pointer, verify the modal actually closed, and if it didn't, click the
// same coordinates with a trusted CDP click.
// Focus a modal action button in-page (scoped to the dialog), then activate with CDP Enter.
async function focusModalButtonAndEnter(tabId, wantedLabels) {
  const expr = `(function(){
    var wanted=${JSON.stringify(wantedLabels)};
    var dlgs=[].slice.call(document.querySelectorAll('[role="dialog"],.artdeco-modal,[data-test-modal]'))
      .map(function(el){var r=el.getBoundingClientRect();return{el:el,r:r,txt:(el.textContent||'').toLowerCase()};})
      .filter(function(c){return c.r.width>=200&&c.r.height>=100;});
    var inv=null;
    for(var i=0;i<dlgs.length;i++){var t=dlgs[i].txt;if(t.indexOf('invitation')>=0||t.indexOf('add a note')>=0||t.indexOf('send without')>=0){inv=dlgs[i];break;}}
    if(!inv&&dlgs.length){dlgs.sort(function(a,b){return (b.r.width*b.r.height)-(a.r.width*a.r.height);});inv=dlgs[0];}
    var root=inv?inv.el:null, cf=!!root;
    var pool=[].slice.call((root||document).querySelectorAll('a,button,div,li,span,[role]'));
    for(var w=0;w<wanted.length;w++){
      var want=wanted[w];
      if(want==='send'&&!cf) continue;
      var cands=pool.filter(function(el){var l=(el.getAttribute('aria-label')||el.textContent||'').trim().toLowerCase();return l===want||(want.length>=5&&l.indexOf(want)>=0);})
        .map(function(el){var r=el.getBoundingClientRect();return{el:el,r:r};})
        .filter(function(c){return c.r.width>0&&c.r.height>0;});
      if(!cands.length) continue;
      cands.sort(function(a,b){var as=a.el.tagName==='SPAN',bs=b.el.tagName==='SPAN';if(as!==bs)return as?1:-1;return (b.r.width*b.r.height)-(a.r.width*a.r.height);});
      var t=cands[0].el.closest('button,a,[role="button"]')||cands[0].el;
      if(t.disabled||t.getAttribute('aria-disabled')==='true') return {focused:false,disabled:true};
      t.scrollIntoView({block:'center'});
      try{t.focus({preventScroll:true});}catch(e){try{t.focus();}catch(e2){}}
      return {focused:(document.activeElement===t||t.contains(document.activeElement)),matched:want};
    }
    return {focused:false,reason:'nomatch'};
  })()`;
  const res = await cdpFocusAndEnter(tabId, expr);
  if (res?.state?.disabled) return { disabled: true };
  return { focused: !!res?.focused, entered: !!res?.entered, matched: res?.state?.matched };
}

async function clickModalButtonRobust(tabId, wantedLabels) {
  const res = await pointerClickButtonInModal(tabId, wantedLabels, 3);
  if (res.disabled) return res;
  await new Promise(r => setTimeout(r, 800));
  if (!(await inviteModalStillOpen(tabId))) return { clicked: true, via: 'pointer', matched: res.matched };
  if (res.rect) {
    console.log('[LeadPilot BG] Modal still open after pointer click — trying trusted CDP click on the button');
    await cdpClick(tabId, res.rect.x, res.rect.y);
    await new Promise(r => setTimeout(r, 800));
    if (!(await inviteModalStillOpen(tabId))) return { clicked: true, via: 'cdp', matched: res.matched };
  }
  // Final fallback: focus the button and press a trusted Enter (no mouse hit-test needed).
  console.log('[LeadPilot BG] Modal still open after CDP click — trying focus + trusted Enter on the button');
  const kb = await focusModalButtonAndEnter(tabId, wantedLabels);
  if (kb.disabled) return { clicked: false, disabled: true, matched: kb.matched };
  await new Promise(r => setTimeout(r, 800));
  if (!(await inviteModalStillOpen(tabId))) return { clicked: true, via: 'enter', matched: kb.matched };
  return { clicked: res.clicked, via: 'none', stillOpen: true, matched: res.matched };
}

// ── Send the invite via LinkedIn's OWN in-tab API (bypasses the un-automatable modal) ──────────
// Runs INSIDE the LinkedIn page (chrome.scripting), so fetch() is same-origin and the session
// cookies + CSRF attach exactly like LinkedIn's own Send button. This is the path that actually
// works: the UI "send-invite-modal" is a preload render that never commits for automated clicks.
// The old BACKEND httpx attempts 301/404'd because they were cross-origin; a same-origin in-tab
// fetch is a different thing. Tries the modern dash mutation first, then the legacy REST shapes,
// and RETURNS every response (status + body snippet) so we can see LinkedIn's real answer and lock
// onto the correct format. `note` is attached as the personalized message.
async function _lpSendInviteViaApi(vanity, note) {
  const out = { vanity, steps: [] };
  const csrf = (() => {
    try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d && d.csrfToken) return d.csrfToken; } } catch (_) {}
    const m = document.cookie.match(/JSESSIONID="?([^;"]+)"?/); return m ? m[1] : null;
  })();
  out.csrf = csrf ? (csrf.slice(0, 10) + '…') : null;
  if (!csrf) { out.error = 'no-csrf'; return out; }
  const headers = {
    'accept': 'application/vnd.linkedin.normalized+json+2.1',
    'content-type': 'application/json; charset=UTF-8',
    'csrf-token': csrf,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
  };
  // 1) Resolve the profile's fsd_profile URN (and network distance) from its public vanity.
  let urn = null;
  // A Sales Navigator / URN-based /in/ url gives the fsd_profile ID directly (e.g. ACwAAArDMcYB…).
  // Build the URN from it and skip the memberIdentity lookup (which only works for public vanities).
  if (/^AC[A-Za-z0-9_-]{16,}$/.test(vanity)) {
    urn = `urn:li:fsd_profile:${vanity}`;
    out.urn = urn;
    out.steps.push({ step: 'urn-from-id', urn });
  }
  if (!urn) try {
    const res = await fetch(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(vanity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16`, { headers, credentials: 'include' });
    const txt = await res.text();
    const m = txt.match(/urn:li:fsd_profile:[\w-]+/);
    if (m) urn = m[0];
    const dm = txt.match(/DISTANCE_(\$SELF|SELF|\d)/);
    out.distance = dm ? dm[1] : '';
    // WebTopCard includes the memberRelationship (it renders Connect vs Message), so the connection
    // state is in THIS response's `included[]`. Detect it directly — no extra endpoint needed.
    if (/MemberRelationshipConnection|"connection"\s*:\s*\{|CONNECTED\b|DISTANCE_1\b/.test(txt)) out.rel = 'connected';
    else if (/MemberRelationshipInvitation|invitationState|"invitation"\s*:\s*\{|"invitee"/.test(txt)) out.rel = 'pending';
    out.steps.push({ step: 'resolve-urn', status: res.status, found: !!urn, distance: out.distance, rel: out.rel || '' });
  } catch (e) { out.steps.push({ step: 'resolve-urn', error: String(e).slice(0, 140) }); }
  if (!urn) { out.error = 'no-urn'; return out; }
  out.urn = urn;
  // Already connected (1st degree / self) → never invite; report so backend marks ACCEPTED.
  if (out.distance === '1' || /SELF/.test(out.distance) || out.rel === 'connected') { out.alreadyConnected = true; return out; }
  if (out.rel === 'pending') { out.alreadyPending = true; return out; }

  const idOnly = urn.split(':').pop();
  const msg = (note || '').trim().slice(0, 300);
  const trackingId = btoa(String.fromCharCode.apply(null, crypto.getRandomValues(new Uint8Array(16))));

  // 2) Try invite endpoints in order; stop on the first 200/201.
  const attempts = [
    { name: 'dash-verifyQuotaAndCreateV2',
      url: '/voyager/api/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
      body: msg ? { invitee: { inviteeUnion: { memberProfile: urn } }, customMessage: msg } : { invitee: { inviteeUnion: { memberProfile: urn } } } },
    { name: 'growth-normInvitations',
      url: '/voyager/api/growth/normInvitations',
      body: { emberEntityName: 'growth/invitation', invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: idOnly } }, trackingId, ...(msg ? { message: msg } : {}) } },
    { name: 'relationships-normInvitations',
      url: '/voyager/api/relationships/normInvitations',
      body: { emberEntityName: 'growth/invitation', invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: idOnly } }, trackingId, ...(msg ? { message: msg } : {}) } },
  ];
  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { method: 'POST', headers, credentials: 'include', body: JSON.stringify(a.body) });
      const txt = await res.text();
      const ct = res.headers.get('content-type') || '';
      out.steps.push({ step: 'invite', ep: a.name, status: res.status, ct: ct.slice(0, 40), snippet: txt.slice(0, 200) });
      // Require ACTUAL creation evidence, not a bare 200 (a 200 HTML page = redirected to login).
      if ((res.status === 200 || res.status === 201) && !/html/i.test(ct) &&
          (txt.indexOf('invitationUrn') >= 0 || txt.indexOf('InvitationCreationResult') >= 0 || res.status === 201)) {
        out.success = true; out.usedEp = a.name;
        out.invitationUrn = (txt.match(/urn:li:fsd_invitation:\d+/) || [null])[0];
        break;
      }
      // "Can't resend yet" (a cooldown after a prior invite/withdraw) or an existing pending invite
      // → already contacted; treat as pending, do NOT retry other endpoints or fall to any UI path.
      if (/CANT_RESEND_YET|CANT_RESEND|CantResendYet|AlreadyInvited|InvitationExists|INVITATION_EXISTS/i.test(txt)) { out.alreadyPending = true; out.usedEp = a.name; break; }
      if (/AlreadyConnected|ALREADY_CONNECTED/i.test(txt)) { out.alreadyConnected = true; break; }
    } catch (e) { out.steps.push({ step: 'invite', ep: a.name, error: String(e).slice(0, 140) }); }
  }
  return out;
}

// ── Read LinkedIn's OWN "Sent invitations" list (for real status reconciliation) ──────────────
// Runs in-tab (same-origin) and pulls the outgoing/pending invitations, returning the invitee
// public identifiers (the /in/<vanity> slug). We match these against our leads: a lead whose vanity
// is in this set is GENUINELY pending; any lead marked pending but NOT in this set was a false
// positive and gets cleared. Tries several endpoints and logs each response so we can lock the
// right one — same probe approach that nailed the invite-create endpoint first try.
async function _lpFetchSentInvites() {
  const out = { steps: [], vanities: [] };
  const csrf = (() => {
    try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d && d.csrfToken) return d.csrfToken; } } catch (_) {}
    const m = document.cookie.match(/JSESSIONID="?([^;"]+)"?/); return m ? m[1] : null;
  })();
  if (!csrf) { out.error = 'no-csrf'; return out; }
  const headers = { 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
  const nameSet = new Set();
  const scan = (txt, set) => {
    let n = 0;
    const re = /"publicIdentifier":"([^"]+)"/g; let m; while ((m = re.exec(txt))) { set.add(m[1].toLowerCase()); n++; }
    // Also collect invitee names (zip firstName/lastName in order) so SN-imported leads whose
    // invite is genuinely pending can be matched by NAME, not just vanity.
    const grab = (key) => {
      const arr = []; const r1 = new RegExp('"' + key + '":"([^"]*)"', 'g'); let x; while ((x = r1.exec(txt))) arr.push(x[1]);
      const r2 = new RegExp('"' + key + '":\\{"text":"([^"]*)"', 'g'); let y; while ((y = r2.exec(txt))) arr.push(y[1]);
      return arr;
    };
    const firsts = grab('firstName'), lasts = grab('lastName');
    const k = Math.min(firsts.length, lasts.length);
    for (let j = 0; j < k; j++) { const full = (firsts[j] + ' ' + lasts[j]).trim().toLowerCase(); if (full.length > 1) nameSet.add(full); }
    return n;
  };
  // PAGINATE — a user can have 100s of outstanding invites; without paging, older pending invites
  // (e.g. Tushar) were missed and their leads wrongly showed "Send Invite" instead of Pending.
  const mk = [
    (s) => `/voyager/api/relationships/sentInvitationViewsV2?count=50&start=${s}&q=invitationType&invitationType=CONNECTION`,
    (s) => `/voyager/api/relationships/invitationViews?q=invitationType&invitationType=CONNECTION&start=${s}&count=50`,
  ];
  const found = new Set();
  let epIdx = -1;
  for (let i = 0; i < mk.length && epIdx < 0; i++) {
    try {
      const res = await fetch(mk[i](0), { headers, credentials: 'include' });
      const txt = await res.text();
      const n = scan(txt, found);
      out.steps.push({ ep: i, status: res.status, publicIds: n, snippet: n ? '' : txt.slice(0, 160) });
      if (res.status === 200 && n > 0) epIdx = i;
    } catch (e) { out.steps.push({ ep: i, error: String(e).slice(0, 140) }); }
  }
  if (epIdx >= 0) {
    for (let start = 50; start < 1000; start += 50) { // up to ~1000 outstanding invites
      try {
        const res = await fetch(mk[epIdx](start), { headers, credentials: 'include' });
        const txt = await res.text();
        if (res.status !== 200 || scan(txt, found) === 0) break;
      } catch (_) { break; }
    }
  }
  out.vanities = [...found];
  out.names = [...nameSet];
  return out;
}

// ── Read LinkedIn's 1st-degree CONNECTIONS (to mark already-connected leads accurately) ─────────
// Per-profile degree checks are all dead (networkinfo 410, relationship 400, WebTopCard omits it),
// so we reconcile connected status the same reliable way as pending: read the connections list and
// match by vanity. Paginates and collects invitee public identifiers.
async function _lpFetchConnections() {
  const out = { steps: [], vanities: [] };
  const csrf = (() => {
    try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d && d.csrfToken) return d.csrfToken; } } catch (_) {}
    const m = document.cookie.match(/JSESSIONID="?([^;"]+)"?/); return m ? m[1] : null;
  })();
  if (!csrf) { out.error = 'no-csrf'; return out; }
  const headers = { 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
  const mk = [
    (s) => `/voyager/api/relationships/dash/connections?decorationId=com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16&count=40&q=search&sortType=RECENTLY_ADDED&start=${s}`,
    (s) => `/voyager/api/relationships/connections?count=40&start=${s}&q=viewer&sortType=RECENTLY_ADDED`,
  ];
  // Capture the vanity (publicIdentifier), the fsd_profile URN id, AND the full name.
  // SN-imported leads are stored as /in/<fsd_salesProfile-id> — neither their vanity nor their
  // fsd_profile id matches this list, so the backend also matches them by NAME.
  const scan = (txt, vset, iset, nset) => {
    let n = 0;
    const re = /"publicIdentifier":"([^"]+)"/g; let m; while ((m = re.exec(txt))) { vset.add(m[1].toLowerCase()); n++; }
    const ri = /urn:li:fsd?_?profile:([A-Za-z0-9_-]+)/gi; let mi; while ((mi = ri.exec(txt))) { iset.add(mi[1]); }
    // Pair firstName/lastName in document order — they may not be adjacent JSON keys, and
    // LinkedIn sometimes nests them as {"text":"..."}. Handle both string and {text} forms.
    const grab = (key) => {
      const arr = [];
      const r1 = new RegExp('"' + key + '":"([^"]*)"', 'g'); let x;
      while ((x = r1.exec(txt))) arr.push(x[1]);
      const r2 = new RegExp('"' + key + '":\\{"text":"([^"]*)"', 'g'); let y;
      while ((y = r2.exec(txt))) arr.push(y[1]);
      return arr;
    };
    const firsts = grab('firstName'), lasts = grab('lastName');
    const k = Math.min(firsts.length, lasts.length);
    for (let j = 0; j < k; j++) { const full = (firsts[j] + ' ' + lasts[j]).trim().toLowerCase(); if (full.length > 1) nset.add(full); }
    return n;
  };
  const found = new Set();
  const ids = new Set();
  const names = new Set();
  let epIdx = -1;
  for (let i = 0; i < mk.length && epIdx < 0; i++) {
    try {
      const res = await fetch(mk[i](0), { headers, credentials: 'include' });
      const txt = await res.text();
      const n = scan(txt, found, ids, names);
      // Diagnostic: capture a chunk around the first name-ish field so we can see the real format.
      if (!out.sample && res.status === 200) {
        const idx = txt.search(/firstName|"name"|lastName/);
        out.sample = idx >= 0 ? txt.slice(Math.max(0, idx - 30), idx + 300) : txt.slice(0, 300);
      }
      out.steps.push({ ep: i, status: res.status, publicIds: n, snippet: n ? '' : txt.slice(0, 140) });
      if (res.status === 200 && n > 0) epIdx = i;
    } catch (e) { out.steps.push({ ep: i, error: String(e).slice(0, 120) }); }
  }
  if (epIdx >= 0) {
    for (let start = 40; start < 1000; start += 40) { // up to ~1000 connections
      try {
        const res = await fetch(mk[epIdx](start), { headers, credentials: 'include' });
        const txt = await res.text();
        if (res.status !== 200 || scan(txt, found, ids, names) === 0) break;
      } catch (_) { break; }
    }
  }
  out.vanities = [...found];
  out.ids = [...ids];
  out.names = [...names];
  return out;
}

// ── Read LinkedIn INBOX (conversations + messages) via the in-tab messaging API ────────────────
// Same same-origin approach. Parses the normalized messaging response into per-conversation threads
// keyed by the other participant's public identifier (so the backend can match to a lead). Includes
// a raw sample in the result so the parser can be refined if LinkedIn's shape differs.
async function _lpFetchInbox() {
  const out = { steps: [], convs: [] };
  const csrf = (() => {
    try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d && d.csrfToken) return d.csrfToken; } } catch (_) {}
    const m = document.cookie.match(/JSESSIONID="?([^;"]+)"?/); return m ? m[1] : null;
  })();
  if (!csrf) { out.error = 'no-csrf'; return out; }
  const headers = { 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
  // Who am I? (mailbox owner — used to build mailboxUrn and to tell OUTBOUND from INBOUND)
  let meUrn = '';
  try { const r = await fetch('/voyager/api/me', { headers, credentials: 'include' }); const t = await r.text(); const m = t.match(/urn:li:fs[dm]?_?[a-zA-Z]*[Pp]rofile:[\w-]+/); meUrn = m ? m[0] : ''; } catch (_) {}
  out.me = meUrn;
  const meId = (meUrn.match(/:([\w-]+)$/) || [null, ''])[1];
  if (!meId) { out.error = 'no-mailbox'; return out; }

  // LinkedIn messaging is GraphQL now. queryId + variables captured from a real browser request.
  // accept MUST be application/graphql (the response is nested JSON, not the included[] format).
  const gqlHeaders = { 'accept': 'application/graphql', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
  const encUrn = `urn:li:fsd_profile:${meId}`.replace(/:/g, '%3A');
  const QUERY_ID = 'messengerConversations.9501074288a12f3ae9e3c7ea243bccbf';
  const nameTxt = (v) => (v && (v.text || (typeof v === 'string' ? v : ''))) || '';
  const seen = new Set();
  let before = Date.now();
  for (let page = 0; page < 6; page++) { // paginate via lastUpdatedBefore
    const vars = `(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),count:20,mailboxUrn:${encUrn},lastUpdatedBefore:${before})`;
    const url = `/voyager/api/voyagerMessagingGraphQL/graphql?queryId=${QUERY_ID}&variables=${vars}`;
    let txt = '';
    try {
      const res = await fetch(url, { headers: gqlHeaders, credentials: 'include' });
      txt = await res.text();
      out.steps.push({ page, status: res.status, len: txt.length, body: res.status !== 200 ? txt.slice(0, 120) : '' });
      if (res.status !== 200 || txt.length < 50) break;
    } catch (e) { out.steps.push({ page, error: String(e).slice(0, 120) }); break; }
    if (!out.sample) out.sample = txt.slice(0, 4000); // raw sample to refine parsing if needed

    let elements = [];
    try {
      const j = JSON.parse(txt);
      (function walk(o) {
        if (elements.length || !o || typeof o !== 'object') return;
        if (Array.isArray(o.elements) && o.elements.some(x => x && (x.conversationParticipants || x.conversationUrl || (typeof x.entityUrn === 'string' && x.entityUrn.indexOf('msg_conversation') >= 0)))) { elements = o.elements; return; }
        for (const k in o) walk(o[k]);
      })(j.data || j);
    } catch (e) { out.parseError = String(e).slice(0, 140); break; }
    if (!elements.length) break;

    let progressed = false, minTs = before;
    for (const c of elements) {
      const parts = c.conversationParticipants || [];
      let other = null;
      for (const p of parts) {
        const mem = (p.participantType && (p.participantType.member || p.participantType.organization)) || p.member || {};
        const hostUrn = p.hostIdentityUrn || (mem && mem.entityUrn) || '';
        const vanity = (((mem.profileUrl || '').match(/\/in\/([A-Za-z0-9\-]+)/) || [])[1] || '').toLowerCase();
        const nm = (nameTxt(mem.firstName) + ' ' + nameTxt(mem.lastName)).trim();
        const isMe = hostUrn && hostUrn.indexOf(meId) >= 0;
        if (!isMe && (vanity || nm)) other = { vanity, name: nm };
      }
      if (!other) continue;
      const threadId = typeof c.entityUrn === 'string' ? c.entityUrn : '';
      const messages = [];
      const mel = (c.messages && c.messages.elements) || c.events || [];
      for (const m of mel) {
        const text = (m.body && (m.body.text || (typeof m.body === 'string' ? m.body : ''))) || '';
        if (!text) continue;
        const sHost = (m.sender && (m.sender.hostIdentityUrn || (m.sender.participantType && m.sender.participantType.member && m.sender.participantType.member.entityUrn))) || '';
        const dir = (sHost && sHost.indexOf(meId) >= 0) ? 'OUTBOUND' : 'INBOUND';
        const at = m.deliveredAt || m.createdAt || 0;
        messages.push({ dir, body: String(text).slice(0, 2000), at });
      }
      const ts = c.lastActivityAt || (messages[0] && messages[0].at) || 0;
      if (ts && ts < minTs) minTs = ts;
      if (threadId && !seen.has(threadId)) { seen.add(threadId); out.convs.push({ vanity: other.vanity, name: other.name, threadId, messages }); progressed = true; }
    }
    if (!progressed || minTs >= before) break; // no new conversations / no timestamp progress
    before = minTs;
  }
  // Diagnostics: how many conversations carried messages, and a peek at the first few.
  out.withMsgs = out.convs.filter(c => c.messages.length).length;
  out.msgCounts = out.convs.slice(0, 8).map(c => `${c.name || c.vanity}:${c.messages.length}`);
  return out;
}

// ── Send a LinkedIn message in-tab (for campaign follow-ups + inbox replies) ───────────────────
// LinkedIn READS messages via GraphQL but WRITES via the dash action endpoint
// `voyagerMessagingDashMessengerMessages?action=createMessage` (well-known format). `target` is
// either an existing conversation (urn or raw threadId like "2-…") for a reply, OR the recipient's
// fsd_profile urn to start a NEW conversation. Returns the response so the format can be verified.
async function _lpSendMessage(target, text) {
  const out = { steps: [] };
  const csrf = (() => {
    try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d && d.csrfToken) return d.csrfToken; } } catch (_) {}
    const m = document.cookie.match(/JSESSIONID="?([^;"]+)"?/); return m ? m[1] : null;
  })();
  if (!csrf) { out.error = 'no-csrf'; return out; }
  const headers = { 'accept': 'application/json', 'content-type': 'application/json; charset=UTF-8', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
  let meUrn = '';
  try { const r = await fetch('/voyager/api/me', { headers, credentials: 'include' }); const t = await r.text(); const m = t.match(/urn:li:fs[dm]?_?[a-zA-Z]*[Pp]rofile:[\w-]+/); meUrn = m ? m[0] : ''; } catch (_) {}
  const meId = (meUrn.match(/:([\w-]+)$/) || [null, ''])[1];
  if (!meId) { out.error = 'no-mailbox'; return out; }
  const mailboxUrn = `urn:li:fsd_profile:${meId}`;

  const a = String(target || '');
  let convUrn = '', recipientUrn = '';
  const threadTok = (a.match(/2-[A-Za-z0-9+/=_-]{10,}/) || [])[0]; // the "2-…" conversation token
  if (a.indexOf('msg_conversation') >= 0) convUrn = a;                       // already a full conversation urn
  else if (threadTok) convUrn = `urn:li:msg_conversation:(${mailboxUrn},${threadTok})`; // any convo urn/id → build
  else if (a.indexOf('fsd_profile') >= 0) recipientUrn = a;                  // a bare profile urn → new convo
  else if (/^AC[A-Za-z0-9_-]{16,}$/.test(a)) recipientUrn = `urn:li:fsd_profile:${a}`; // fsd_profile id → build urn
  else if (a) {
    // a public vanity (e.g. "renubisht") → resolve to the recipient's profile urn, start/append a convo
    try {
      const rr = await fetch(`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(a)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16`, { headers, credentials: 'include' });
      const tt = await rr.text(); const mm = tt.match(/urn:li:fsd_profile:[\w-]+/); if (mm) recipientUrn = mm[0];
    } catch (_) {}
  }
  out.convUrn = convUrn; out.recipientUrn = recipientUrn;

  if (!convUrn && !recipientUrn) { out.error = 'no-target'; return out; }
  const uuid = (crypto.randomUUID && crypto.randomUUID()) || ('' + Date.now() + Math.random());
  // trackingId is a raw 16-byte string (as the real request sends), not base64.
  const trackingId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => String.fromCharCode(b)).join('');
  const txt = String(text || '').slice(0, 8000);
  // CONFIRMED format (captured from a real send): content-type text/plain, and conversationUrn +
  // originToken live INSIDE `message`. For a NEW conversation, hostRecipientUrns replaces
  // conversationUrn (best-effort placement).
  const baseMsg = { body: { attributes: [], text: txt }, renderContentUnions: [], originToken: uuid };
  const variants = [];
  if (convUrn) {
    // Reply to an existing conversation → conversationUrn INSIDE message (confirmed capture).
    variants.push({ message: { ...baseMsg, conversationUrn: convUrn }, mailboxUrn, trackingId, dedupeByClientGeneratedToken: false });
  } else {
    // New/append conversation to a recipient → hostRecipientUrns at TOP LEVEL (confirmed 200).
    variants.push({ message: baseMsg, mailboxUrn, trackingId, dedupeByClientGeneratedToken: false, hostRecipientUrns: [recipientUrn] });
    variants.push({ message: { ...baseMsg, hostRecipientUrns: [recipientUrn] }, mailboxUrn, trackingId, dedupeByClientGeneratedToken: false });
  }
  const sendHeaders = { 'accept': 'application/json', 'content-type': 'text/plain;charset=UTF-8', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
  for (let i = 0; i < variants.length; i++) {
    try {
      const res = await fetch('/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage', { method: 'POST', headers: sendHeaders, credentials: 'include', body: JSON.stringify(variants[i]) });
      const rt = await res.text();
      const ct = res.headers.get('content-type') || '';
      out.steps.push({ v: i, status: res.status, snippet: rt.slice(0, 220) });
      if ((res.status === 200 || res.status === 201) && !/html/i.test(ct)) {
        out.success = true; out.usedVariant = i;
        out.messageUrn = (rt.match(/urn:li:msg_message:[^"]+/) || rt.match(/"backendUrn":"([^"]+)"/) || [true])[0];
        break;
      }
    } catch (e) { out.steps.push({ v: i, error: String(e).slice(0, 120) }); }
  }
  return out;
}

// ── Real-button Connect click ────────────────────────────────────────────────
// LinkedIn's invite Voyager endpoints (growth/normInvitations, relationships/normInvitations)
// are confirmed dead — every attempt returns a 301-with-no-Location-header followed by a flat
// 404, for every lead, with zero successes ever logged. Same root cause class as the Sales
// Navigator endpoints: the /voyager/api/ namespace this codebase guessed against doesn't match
// current LinkedIn. Fix: click the real, rendered "Connect" button via CDP-trusted clicks,
// same technique proven for the SN "..." menu.
async function clickConnectButton(tabId, profileUrl, note, leadEmail) {
  // CDP's Input.dispatchMouseEvent doesn't reliably register hit-testing on a
  // background/unfocused tab OR when the Chrome WINDOW lacks OS focus (confirmed: the invite
  // modal opened only in runs where the window happened to be focused; with DevTools focused
  // or another window in front, the trusted click silently missed and no modal appeared).
  // Focus both the tab and its window before any clicks below.
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    if (t?.windowId != null) await Promise.resolve() /* window-focus disabled: don't raise the window to the foreground so it can run in the background without popping up (CDP clicks target the tab renderer, not OS focus) */;
  } catch (_) {}

  // Navigate to the specific lead's profile if the tab isn't already there.
  let currentUrl = '';
  try { currentUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
  const targetVanity = (profileUrl.split('/in/')[1] || '').split(/[/?#]/)[0];
  if (!targetVanity) return { success: false, error: 'Invalid profile URL: ' + profileUrl };

  let navigatedUrl = currentUrl;
  if (!currentUrl.includes(`/in/${targetVanity}`)) {
    await new Promise(resolve => chrome.tabs.update(tabId, { url: profileUrl }, () => resolve()));
    // Poll the tab's actual URL instead of trusting a single onUpdated 'complete' event —
    // that event can fire on an intermediate redirect before the real page settles, leaving
    // the tab on stale content (confirmed: caught mid-navigation showing feed content once).
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      try { navigatedUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
      if (navigatedUrl.includes(`/in/${targetVanity}`)) break;
    }
    await new Promise(r => setTimeout(r, 3000)); // let profile page hydrate after URL settles
  }
  console.log('[LeadPilot BG] clickConnectButton — tab URL after navigation wait:', navigatedUrl);

  if (!navigatedUrl.includes(`/in/${targetVanity}`)) {
    return { success: false, error: `Navigation to profile failed — tab ended up at ${navigatedUrl || '(unknown)'} instead of ${profileUrl}` };
  }

  // ── PRIMARY: send via LinkedIn's OWN in-tab API (no un-automatable modal) ──
  // The invite UI modal is a preload render that never commits for automated clicks (confirmed
  // over a month of attempts), so drive LinkedIn's own invite request same-origin from the tab —
  // exactly what its Send button does under the hood, with the personalized note attached.
  // The API targets the profile by its OWN resolved URN (from this exact /in/<vanity>), so it can
  // NEVER hit the wrong person. This is now the ONLY sender. The old UI-click fallback below is
  // DISABLED: on profiles where the API can't send, that fallback measured a "Connect"/"Invite X to
  // connect" button from the "People you may know" / similar-profiles sidebar and invited the WRONG
  // person (confirmed: Shrey's page → measured "invite Rohit Shukla to connect" at x≈1116). Sending
  // to the wrong person is far worse than not sending, so we fail honestly instead.
  {
    let api = null;
    try {
      const [{ result }] = await safeExecuteScript({ target: { tabId }, args: [targetVanity, note || ''], func: _lpSendInviteViaApi });
      api = result;
    } catch (e) {
      console.warn('[LeadPilot BG] In-tab invite API threw:', e.message);
      return { success: false, error: 'Invite API could not run in the LinkedIn tab: ' + e.message };
    }
    console.log('[LeadPilot BG] In-tab invite API result:', JSON.stringify(api));
    // Exact error strings 'already_connected'/'already_pending' — the backend maps THESE to
    // ConnectionStatus.ACCEPTED / PENDING respectively (see extension_connect_result).
    if (api && api.alreadyConnected) return { success: false, already_connected: true, error: 'already_connected' };
    if (api && api.alreadyPending) return { success: false, already_pending: true, error: 'already_pending' };
    if (api && api.success) {
      // AUTHORITATIVE: LinkedIn's own API returned 200 with an invitationUrn — the invitation was
      // created (confirmed in Invitation Manager → Sent, WITH the note). The API cannot fake a
      // creation, and it targeted this profile's own URN, so this is a correct, real send.
      console.log('[LeadPilot BG] In-tab API invite CONFIRMED via LinkedIn invitationUrn:', api.invitationUrn, '— success');
      return { success: true };
    }
    // API ran but LinkedIn refused (quota, restricted, etc.), or the profile URN wouldn't resolve.
    // Do NOT fall through to any UI clicking — report an honest, safe failure for THIS person only.
    const codes = (api?.steps || []).map(s => `${s.step}:${s.status || s.error || '?'}`).join(', ');
    if (api?.urn) {
      return { success: false, error: `LinkedIn did not accept the invite (${codes || 'no 200'}). Not sent — no UI fallback, to avoid inviting the wrong person.` };
    }
    return { success: false, error: `Could not resolve this profile for the invite API (${api?.error || codes || 'unknown'}). Not sent.` };
  }

  // ⛔ UNREACHABLE / DISABLED below: the legacy UI-click flow. Kept for reference only — it must
  // NOT run, because its Connect-button search can select a suggested person from the sidebar and
  // invite the WRONG profile. All sends now go through the URN-targeted API above.
  // eslint-disable-next-line no-unreachable
  // ── Step 1: find the Connect button (direct, or behind "More") ────────────
  const [{ result: step1 }] = await safeExecuteScript({
    target: { tabId },
    func: () => {
      function findVisible(predicate) {
        const matches = [...document.querySelectorAll('button')].filter(predicate);
        return matches.find(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }) || null;
      }
      function rectOf(el) {
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }

      const debug = {};
      const allButtons = [...document.querySelectorAll('button')];
      debug.buttonLabels = allButtons.map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 30);

      // The profile's own Connect button can be labeled either plain "Connect" OR
      // "Invite {ThisProfile'sName} to connect" — confirmed via real data: a profile
      // showed zero plain "Connect" matches because its real button used the latter
      // form. The "Invite {Name} to connect" pattern is ALSO used by unrelated "People
      // similar to X" sidebar suggestions for OTHER people, so the name must match the
      // page's own subject (read from the page's <h1>), not just any name.
      const MIN_Y = 100;
      // h1 came back empty (LinkedIn doesn't use a semantic h1 for the name here) —
      // document.title reliably starts with "{Name} - ..." on every profile page instead.
      const pageOwnerName = (document.querySelector('h1')?.textContent || '').trim()
        || (document.title || '').split(/[-|]/)[0].trim();
      const pageOwnerFirstName = pageOwnerName.split(/\s+/)[0]?.toLowerCase() || '';

      // Search beyond <button> — confirmed this session that LinkedIn renders some
      // clickable controls (the SN "..." menu items, "More"-menu Connect items) as
      // <div>/<a>/<span> with no real <button> tag at all. A pure 'button' query can
      // miss the real element entirely.
      const connectCandidates = [...document.querySelectorAll('a, button, div, li, span, [role]')]
        .filter(b => {
          const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
          if (label === 'connect') return true;
          if (pageOwnerFirstName && label.includes('invite') && label.includes('to connect') && label.includes(pageOwnerFirstName)) return true;
          return false;
        })
        .map(b => { const r = b.getBoundingClientRect(); return { b, y: Math.round(r.top + window.scrollY), r }; })
        .filter(c => c.r.width > 0 && c.r.height > 0)
        .sort((a, b2) => a.y - b2.y);
      debug.pageOwnerFirstName = pageOwnerFirstName;
      debug.connectBtnCandidateYs = connectCandidates.map(c => c.y).slice(0, 10);
      const inRange = connectCandidates.filter(c => c.y > MIN_Y && c.y <= 1200);
      // The matched "Connect" text is frequently a bare <span>/<div> LABEL with no click
      // handler — the real control is a wrapping <button>/<a>/[role=button]. Confirmed via
      // real data: on a "Connect if you know each other" profile the scan matched a Connect
      // element that was NOT in the page's <button> list at all, clicked it, and NO modal
      // opened (the click hit dead text). Fix: resolve every match to its nearest actually-
      // clickable ancestor and click THAT, not the raw text node.
      if (inRange.length) {
        const resolved = inRange.map(c => {
          const clickable = c.b.closest('button, a, [role="button"]') || c.b;
          const cr = clickable.getBoundingClientRect();
          const isRealControl = clickable !== c.b
            || c.b.tagName === 'BUTTON' || c.b.tagName === 'A'
            || c.b.getAttribute('role') === 'button';
          return { orig: c.b, clickable, y: Math.round(cr.top + window.scrollY), r: cr, isRealControl };
        }).filter(c => c.r.width > 0 && c.r.height > 0);
        // Prefer a resolved real control over dead text; among those, topmost then largest.
        resolved.sort((a, b2) => {
          if (a.isRealControl !== b2.isRealControl) return a.isRealControl ? -1 : 1;
          if (a.y !== b2.y) return a.y - b2.y;
          return (b2.r.width * b2.r.height) - (a.r.width * a.r.height);
        });
        const pick = resolved[0] || { orig: inRange[0].b, clickable: inRange[0].b };
        debug.connectFoundDirect = true;
        debug.connectPicked = { matchedTag: pick.orig.tagName, clickedTag: pick.clickable.tagName, resolvedToAncestor: pick.clickable !== pick.orig };
        return { debug, connectRect: rectOf(pick.clickable) };
      }

      // Same multi-duplicate problem as Connect — there are several elements labeled
      // "More" on a profile page. Confirmed via real data: a candidate at y=3 is the
      // sticky/fixed top nav bar (always near pixel 0 regardless of scroll), NOT the
      // profile's own action-row "More" — that one sits further down (confirmed: y=531),
      // below the cover photo + nav. Exclude the sticky-nav zone, then take the topmost
      // of what remains.
      const moreCandidates = [...document.querySelectorAll('button')]
        .filter(b => {
          const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().toLowerCase();
          return label === 'more' || label.includes('more actions');
        })
        .map(b => { const r = b.getBoundingClientRect(); return { b, y: Math.round(r.top + window.scrollY), r }; })
        .filter(c => c.r.width > 0 && c.r.height > 0)
        .sort((a, b2) => a.y - b2.y); // topmost first

      debug.moreBtnCandidateYs = moreCandidates.map(c => c.y).slice(0, 10);
      const moreCandidate = moreCandidates.find(c => c.y > MIN_Y && c.y <= 1200) || null;
      debug.moreBtnFound = !!moreCandidate;
      return { debug, connectRect: null, moreBtnRect: rectOf(moreCandidate ? moreCandidate.b : null) };
    },
  });

  console.log('[LeadPilot BG] Connect button scan:', JSON.stringify(step1.debug));

  let clickTarget = step1.connectRect;
  let moreMenuModalOpened = false;
  if (!clickTarget && step1.moreBtnRect) {
    // PRIMARY: open "More" and click "Connect" in ONE debugger session. Re-attaching between
    // opening the menu and clicking its item resizes the viewport (infobar) and closes the
    // menu — see cdpOpenMoreAndClickConnect(). Manual clicks open the modal fine, so the only
    // problem was our attach/detach thrash tearing the menu down mid-sequence.
    try {
      const t = await chrome.tabs.get(tabId);
      if (t?.windowId != null) await Promise.resolve() /* window-focus disabled: don't raise the window to the foreground so it can run in the background without popping up (CDP clicks target the tab renderer, not OS focus) */;
    } catch (_) {}
    const single = await cdpOpenMoreAndClickConnect(tabId, note);
    console.log('[LeadPilot BG] More→Connect single-session result:', JSON.stringify(single));
    let postSingleUrl = '';
    try { postSingleUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    if (!postSingleUrl.includes(`/in/${targetVanity}`)) {
      return { success: false, error: `Opening the More menu navigated away unexpectedly to ${postSingleUrl || '(unknown)'} — aborting rather than continuing on the wrong page` };
    }
    if (single.modalOpened && single.sent) {
      // Whole More→Connect→Send happened in ONE debugger session: we clicked the modal's real
      // "Send without a note"/"Send" button (shadow-DOM-scoped, trusted) and the modal closed —
      // LinkedIn's success signal (a failed/blocked send keeps the modal open). Do NOT downgrade
      // with a clean-reload verify: on "Connect-under-More" profiles both Connect and Pending are
      // hidden from the action row and render in shadow DOM, so the reload scan can't see either
      // and would falsely report "couldn't confirm". Trust the in-session send.
      console.log('[LeadPilot BG] Invite submitted in single session (modal closed after Send) — success');
      return { success: true };
    }
    if (single.modalOpened && !single.sent && single.diag && single.diag.ok) {
      // Modal opened but the in-session Send did not close it (e.g. disabled / needs email).
      if (single.lastSend && single.lastSend.disabled) {
        return { success: false, error: 'requires_email_verification', requiresEmail: true };
      }
    }
    // The menu Connect item was clicked (role="menuitem") but the modal isn't in the main frame —
    // it renders in an IFRAME on this profile. Drive it across all frames + open shadow DOM.
    if (single.opened && single.diag && single.diag.ok) {
      const framed = await handleModalAcrossFrames(tabId, note, leadEmail);
      console.log('[LeadPilot BG] Across-frames modal result:', JSON.stringify(framed));
      if (framed.modalFound && framed.sent) {
        // The modal closed immediately after we clicked Send in its (shadow-DOM) frame — that is
        // LinkedIn's success signal (a failed/blocked send keeps the modal open with an error).
        // Do NOT downgrade this with a clean-reload verify: on profiles where Connect lives under
        // the "More" menu, both "Connect" and "Pending" are hidden from the action row and also
        // render in shadow DOM, so the reload scan can't see either and would falsely report
        // "couldn't confirm" (confirmed this session). Trust the send.
        console.log('[LeadPilot BG] Invite submitted (modal closed after Send) — success');
        return { success: true };
      }
      if (framed.modalFound && framed.disabled) {
        return { success: false, error: 'requires_email_verification', requiresEmail: true };
      }
      if (framed.modalFound) {
        // Modal was found but Send didn't take — verify honestly rather than assume.
        await new Promise(r => setTimeout(r, 1000));
        return await verifyConnectionSent(tabId, profileUrl, targetVanity);
      }
    }
    if (single.modalOpened) {
      // Modal opened in the main frame but in-session Send didn't close it — hand off to the
      // existing main-frame modal handling below.
      moreMenuModalOpened = true;
      clickTarget = single.diag ? { x: single.diag.x, y: single.diag.y } : step1.moreBtnRect;
    }
  }
  if (!moreMenuModalOpened && !clickTarget && step1.moreBtnRect) {
    // The single-session menu path did NOT surface the invite modal. Deliberately do NOT fall
    // back to a page-wide "nearest Connect" click — that is exactly what invited the WRONG
    // person (a "People similar to X" suggested-card Connect button) in a confirmed run. Fail
    // honestly and safely instead; no invite is worse-than-nothing, a wrong invite is harmful.
    return { success: false, error: 'Could not open the invite modal from the More menu (no menu "Connect" item activated) — please send this invite manually. No request was sent, to avoid contacting the wrong person.' };
  }

  if (!clickTarget) {
    return { success: false, error: 'Connect button not found on profile page — debug: ' + JSON.stringify(step1.debug) };
  }

  // When the single-session More→Connect path already opened the modal, skip ALL of the
  // legacy click machinery below — clicking again would land on the open modal/backdrop and
  // could dismiss it. Fall straight through to the modal handling (Step 2).
  if (!moreMenuModalOpened) {
  // ── PRIMARY (direct-connect profiles): open Connect + drive the whole modal in ONE debugger
  // session. LinkedIn's Connect control AND the modal's action buttons both require a TRUSTED
  // (CDP) click, and re-attaching the debugger mid-modal DISMISSES the modal — so the old flow
  // (open in a throwaway session, detach, re-attach to click Send) could never complete. This
  // single session clicks Connect, waits for the modal, clicks "Add a note", fills the note, and
  // clicks Send without ever detaching, measuring every target inside the same session so the
  // coordinates match the click (fixes the "click missed the button → no modal" flakiness). The
  // More-menu path already runs its own single session above; only the direct button lacked one.
  if (!step1.moreBtnRect) {
    const direct = await cdpOpenMoreAndClickConnect(tabId, note, true);
    console.log('[LeadPilot BG] Direct single-session Connect→Send result:', JSON.stringify(direct));
    let du = '';
    try { du = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    if (!du.includes(`/in/${targetVanity}`)) {
      return { success: false, error: `Clicking Connect navigated away unexpectedly to ${du || '(unknown)'} — aborting rather than continuing on the wrong page` };
    }
    if (direct.modalOpened && direct.lastSend && direct.lastSend.disabled) {
      return { success: false, error: 'requires_email_verification', requiresEmail: true };
    }
    if (direct.modalOpened && direct.sent) {
      // DO NOT trust the modal-closed signal. Confirmed via real data: this invite modal is a
      // fleeting PRELOAD render that vanishes on its own whether or not the request committed, so
      // "we clicked Send and the modal closed" was a FALSE positive (LinkedIn still showed Connect,
      // the lead was wrongly marked Pending). The only trustworthy proof is a clean reload showing
      // "Pending"/"Withdraw". Verify, and report success ONLY if the profile actually flips.
      console.log('[LeadPilot BG] Direct path claims sent — verifying via clean reload before trusting it');
      const verified = await verifyConnectionSent(tabId, profileUrl, targetVanity);
      console.log('[LeadPilot BG] Direct-path reload verification:', JSON.stringify(verified));
      return verified;
    }
    // FAIL FAST. The single session is the ONLY mechanism that can work for a direct-Connect
    // profile (trusted click + no re-attach). The old legacy cascade below — CDP click, focus+Enter,
    // identity pointer click, then a full page reload+verify — cannot open this preload-gated modal
    // either, and it churned the extension for ~1 minute per lead (5+ debugger attach/detach cycles
    // and a page reload) before failing anyway. Return the honest failure now instead of thrashing.
    return {
      success: false,
      error: direct.modalOpened
        ? 'The invite modal opened but LinkedIn closed it before the request could be sent (preload-gated modal). No request was sent — please send this one manually for now.'
        : 'Could not open the invite modal (LinkedIn did not respond to the Connect click). No request was sent.',
    };
  }
  // Trigger the Connect element with a genuinely-TRUSTED CDP click first. Confirmed via real
  // data: LinkedIn's invite modal only opens for a trusted click here — a synthetic pointer
  // sequence closes a dropdown but does NOT open this modal. The identity-based pointer click
  // is kept as a fallback below (fires only if no modal appears), covering controls that the
  // CDP click misses without double-firing on the ones it opens.
  // Re-assert window focus right before the click — focus can be lost during the navigation
  // wait, and CDP hit-testing silently misses on an unfocused window.
  try {
    const t = await chrome.tabs.get(tabId);
    if (t?.windowId != null) await Promise.resolve() /* window-focus disabled: don't raise the window to the foreground so it can run in the background without popping up (CDP clicks target the tab renderer, not OS focus) */;
  } catch (_) {}
  // Re-measure the Connect control's position immediately before the trusted click — the
  // step-1 coordinates may be stale (confirmed: clicking the correct <a> by old coords did
  // nothing). For the DIRECT path only; the More-menu path's clickTarget is a menu item.
  let connectClickPt = clickTarget;
  if (!step1.moreBtnRect) {
    const fresh = await measureConnectNear(tabId, clickTarget.x, clickTarget.y, 300);
    if (fresh) { connectClickPt = fresh; console.log('[LeadPilot BG] Re-measured Connect rect before CDP click:', JSON.stringify(fresh)); }
  }
  await cdpClick(tabId, connectClickPt.x, connectClickPt.y);
  await new Promise(r => setTimeout(r, 500));

  // Diagnostic: did the click register at all? If this came via the "More" menu, check
  // whether the dropdown actually closed — a fast, reliable signal independent of whether
  // a modal appears, to distinguish "click missed entirely" from "click worked but no
  // modal shows up".
  if (step1.moreBtnRect) {
    const dropdownProbe = (x, y) => [...document.querySelectorAll('a, button, div, li, span, [role]')]
      .filter(el => (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase() === 'connect')
      .some(el => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        return Math.hypot((r.left + r.width / 2) - x, (r.top + r.height / 2) - y) <= 100;
      });
    const [{ result: dropdownStillOpen }] = await safeExecuteScript({
      target: { tabId }, args: [clickTarget.x, clickTarget.y], func: dropdownProbe,
    });
    console.log('[LeadPilot BG] Dropdown still open after More-menu Connect click:', dropdownStillOpen);

    // The CDP click landed but didn't activate the menu item (confirmed: dropdown stays
    // open, no modal — and clicking by coordinates is flaky because the dropdown scrolls
    // internally). Retry by finding the Connect item BY IDENTITY in-page and dispatching a
    // real pointer-event sequence on it, re-checking after each attempt until it closes.
    let menuStillOpen = dropdownStillOpen;
    const probeMenuOpen = async () => {
      const [{ result }] = await safeExecuteScript({
        target: { tabId }, args: [clickTarget.x, clickTarget.y], func: dropdownProbe,
      });
      return !!result;
    };

    // PRIMARY: trusted CDP mouse click at FRESHLY RE-MEASURED coordinates, retried.
    // Confirmed via real data: on this profile the menu "Connect" is a decoy
    // <a href="…/preload/custom-…"> whose handler ignores both a keyboard-Enter and
    // synthetic pointer events (isTrusted gate) AND a one-shot CDP click at scan-time
    // coordinates — because the dropdown scrolls/re-lays-out internally, so those
    // coordinates go stale and the trusted click lands off the item. Re-measuring the
    // item's live viewport center immediately before EACH CDP click (the exact fix that
    // made the direct-button path reliable) is the missing piece. Try it first and hardest.
    for (let attempt = 0; attempt < 4 && menuStillOpen; attempt++) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t?.windowId != null) await Promise.resolve() /* window-focus disabled: don't raise the window to the foreground so it can run in the background without popping up (CDP clicks target the tab renderer, not OS focus) */;
      } catch (_) {}
      const clickRes = await cdpMeasureAndClickConnectNear(tabId, clickTarget.x, clickTarget.y, 350);
      await new Promise(r => setTimeout(r, 550));
      // Stop the moment the invite modal appears — clicking again could dismiss it
      // (the old menu coordinates may now sit over the modal backdrop or a nearby
      // "People similar to…" Connect button).
      if (await inviteModalStillOpen(tabId)) { menuStillOpen = false; console.log('[LeadPilot BG] Menu-item re-measured CDP — invite modal opened, stopping'); break; }
      menuStillOpen = await probeMenuOpen();
      console.log(`[LeadPilot BG] Menu-item re-measured CDP retry ${attempt + 1} — ${JSON.stringify(clickRes)} | dropdown still open: ${menuStillOpen}`);
    }

    // FALLBACK 1: trusted keyboard activation — focus the menu item and press a trusted
    // Enter (no coordinate dependency at all).
    if (menuStillOpen) {
      await focusConnectAndEnter(tabId, clickTarget.x, clickTarget.y, 350);
      await new Promise(r => setTimeout(r, 500));
      menuStillOpen = await probeMenuOpen();
      console.log('[LeadPilot BG] Menu-item focus+Enter — dropdown still open:', menuStillOpen);
    }

    // FALLBACK 2: identity-based synthetic pointer sequence (covers handlers that don't
    // gate on isTrusted).
    for (let attempt = 0; attempt < 3 && menuStillOpen; attempt++) {
      const fired = await pointerClickConnectNear(tabId, clickTarget.x, clickTarget.y, 350, 1);
      await new Promise(r => setTimeout(r, 400));
      menuStillOpen = await probeMenuOpen();
      console.log(`[LeadPilot BG] Menu-item pointer retry ${attempt + 1} — fired: ${fired} | dropdown still open: ${menuStillOpen}`);
    }
  }
  } // end if (!moreMenuModalOpened)

  // Safety check: confirm the click opened a modal on THIS page rather than navigating
  // away entirely (confirmed this session: a wrongly-matched element once navigated to
  // the notifications page). A real Connect modal never changes the URL.
  let postClickUrl = '';
  try { postClickUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
  if (!postClickUrl.includes(`/in/${targetVanity}`)) {
    return { success: false, error: `Clicking Connect navigated away unexpectedly to ${postClickUrl || '(unknown)'} — aborting rather than continuing on the wrong page` };
  }

  // The invite modal renders in an OPEN shadow root, which the legacy main-document scan below
  // CANNOT see (confirmed: modalContainerFound:false, dx_addANote:false while the modal is
  // visibly open on a DIRECT-Connect profile). Try the shadow-DOM-aware handler FIRST; if it
  // drives the modal to a real Send (an actual click that closes the modal), we're done. Only
  // fall through to the legacy scan if no modal is found at all.
  {
    const framed = await handleModalAcrossFrames(tabId, note, leadEmail);
    console.log('[LeadPilot BG] Direct-path across-frames modal result:', JSON.stringify(framed));
    if (framed.modalFound && framed.sent) {
      console.log('[LeadPilot BG] Invite submitted (shadow-DOM modal, direct path) — success');
      return { success: true };
    }
    if (framed.modalFound && framed.disabled) {
      return { success: false, error: 'requires_email_verification', requiresEmail: true };
    }
  }

  // ── Step 2: handle the post-click modal (Add a note / Send without a note / Send) ──
  // Poll for the SPECIFIC modal content directly, not generic "did the DOM change" —
  // unrelated sections (e.g. a "People similar to X" sidebar finishing its own lazy load)
  // can grow the DOM right around the same time and falsely look like the modal mounted,
  // causing the scan to run before the actual Connect modal renders (confirmed this session).
  const modalScanFunc = (noteText) => {
    // Scope to the actual modal container, not the whole page — confirmed this session
    // that an unscoped "Send" text search can match LinkedIn's persistent chat/messaging
    // widget (bottom-right of every page), which also has its own "Send" button, instead
    // of the real Connect modal. Modal content/heading text varies across profile variants
    // (not always containing "invitation"), so use a more universal signal instead: a real
    // modal always renders in a fixed-position, high-z-index overlay layer above everything
    // else on the page, including the chat widget.
    let searchRoot = document;
    let detectMethod = 'none';

    // Method A (primary): LinkedIn's invite modal is a real dialog — role="dialog" and/or
    // the artdeco-modal class. Confirmed via real data: the z-index/body-child heuristics
    // below BOTH missed the "Add a note to your invitation?" modal (modalContainerFound
    // stayed false while the modal was visibly open), so the "Send" search never ran and
    // the flow got stuck. An explicit dialog selector is far more reliable. Prefer a dialog
    // that looks like the invite modal (mentions the invitation / add-a-note / has a Send
    // button); otherwise the largest visible dialog. This deliberately excludes the chat
    // widget, which is not a role="dialog"/artdeco-modal.
    {
      const dialogs = [...document.querySelectorAll('[role="dialog"], .artdeco-modal, [data-test-modal]')]
        .map(el => ({ el, r: el.getBoundingClientRect(), txt: (el.textContent || '').toLowerCase() }))
        .filter(c => c.r.width >= 200 && c.r.height >= 100);
      const invite = dialogs.find(c =>
        c.txt.includes('invitation') || c.txt.includes('add a note') ||
        c.txt.includes('send without') || c.txt.includes('how do you know'));
      const pick = invite || dialogs.sort((a, b) => (b.r.width * b.r.height) - (a.r.width * a.r.height))[0];
      if (pick) { searchRoot = pick.el; detectMethod = 'dialog'; }
    }

    // Method B: highest-z fixed/absolute overlay (kept as a fallback for variants that
    // don't expose role="dialog").
    if (searchRoot === document) {
      let bestZ = -1;
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
        const z = parseInt(cs.zIndex, 10);
        if (isNaN(z) || z <= bestZ) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 250 || r.height < 150) continue; // too small to be the dialog itself
        bestZ = z;
        searchRoot = el;
        detectMethod = 'zindex';
      }
    }

    // Method C: modals in React/Ember portals are usually appended as one of the LAST
    // children of <body>; scan backwards for a large element with recognizable modal text.
    if (searchRoot === document) {
      const bodyChildren = [...document.body.children].reverse();
      for (const el of bodyChildren) {
        const r = el.getBoundingClientRect();
        if (r.width < 250 || r.height < 150) continue;
        const txt = (el.textContent || '').toLowerCase();
        if (txt.includes('add a note') || txt.includes('send without a note') || txt.includes('invitation')) {
          searchRoot = el;
          detectMethod = 'bodychild';
          break;
        }
      }
    }

    // Broadened beyond <button> — confirmed this session that LinkedIn's modal action
    // buttons ("Add a note", "Send without a note") aren't necessarily real <button> tags.
    const allButtons = [...searchRoot.querySelectorAll('a, button, div, li, span, [role]')]
      .filter(el => {
        const txt = (el.textContent || el.getAttribute('aria-label') || '').trim();
        return txt.length > 0 && txt.length < 60;
      });
    const debug = {
      modalContainerFound: searchRoot !== document,
      modalDetectMethod: detectMethod,
      modalButtonLabels: allButtons.map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 25),
    };

    // Hard diagnostics: is the invite modal ACTUALLY open right now, independent of whether
    // our container heuristics found it? "add a note" / "send without a note" are unique to
    // this modal and safe to match page-wide. If these are true but modalContainerFound is
    // false, the container detection is the bug; if all false, the modal never opened.
    {
      const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const lbl = el => (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase();
      const everything = [...document.querySelectorAll('a, button, div, li, span, [role]')];
      debug.dx_sendWithoutNote = everything.some(el => vis(el) && lbl(el).includes('send without a note'));
      debug.dx_addANote = everything.some(el => vis(el) && lbl(el) === 'add a note');
      debug.dx_invitationHeading = everything.some(el => vis(el) && lbl(el).includes('add a note to your invitation'));
      debug.dx_dialogCount = document.querySelectorAll('[role="dialog"]').length;
      debug.dx_artdecoModalCount = document.querySelectorAll('.artdeco-modal').length;
      // If a "send without a note"/"add a note" button IS visible, capture its tag + ancestor
      // classes so we can see the real modal container markup for next time.
      const sig = everything.find(el => vis(el) && (lbl(el).includes('send without a note') || lbl(el) === 'add a note'));
      if (sig) {
        const chain = [];
        let p = sig;
        for (let k = 0; k < 6 && p; k++) { chain.push(p.tagName + (p.className && typeof p.className === 'string' ? '.' + p.className.split(/\s+/).slice(0, 2).join('.') : '')); p = p.parentElement; }
        debug.dx_signatureChain = chain;
      }
    }

    // (Removed the in-place "already pending" shortcut — even distance-scoped, it was
    // still fooled by page noise like a loading video ad, confirmed this session producing
    // a false success report. The clean-reload verification at the end of this function is
    // now the single source of truth for success/failure, including the "already pending"
    // case — if nothing needs sending, the normal click flow fails harmlessly and honestly
    // instead of falsely claiming success.)

    // Even without a confirmed container, "Add a note" / "Send without a note" are
    // specific enough phrases that an unscoped page-wide search for them is safe — the
    // chat widget doesn't have buttons with this exact wording. Only the bare word "Send"
    // is dangerous unscoped (confirmed: matches the chat widget's own Send button), so
    // that one stays gated behind having found a real container.
    const allButtonsUnscoped = debug.modalContainerFound ? allButtons
      : [...document.querySelectorAll('a, button, div, li, span, [role]')].filter(el => {
          const txt = (el.textContent || el.getAttribute('aria-label') || '').trim();
          return txt.length > 0 && txt.length < 60;
        });

    function findVisible(predicate, pool) {
      const visible = pool.filter(predicate)
        .map(b => { const r = b.getBoundingClientRect(); return { b, r }; })
        .filter(c => c.r.width > 0 && c.r.height > 0);
      if (!visible.length) return null;
      // Same nested DIV>A>SPAN problem as the Connect button — prefer the largest
      // non-span element instead of whichever happens to come first.
      visible.sort((a, b2) => {
        const aSpan = a.b.tagName === 'SPAN', bSpan = b2.b.tagName === 'SPAN';
        if (aSpan !== bSpan) return aSpan ? 1 : -1;
        return (b2.r.width * b2.r.height) - (a.r.width * a.r.height);
      });
      return visible[0].b;
    }
    function rectOf(el) {
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }

    // "Add a note" / "Send without a note" are specific enough to search unscoped safely.
    const addNoteBtn = noteText ? findVisible(b => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      return label.includes('add a note') || label === 'add a note';
    }, allButtonsUnscoped) : null;
    debug.addNoteBtnFound = !!addNoteBtn;
    if (addNoteBtn) return { debug, addNoteRect: rectOf(addNoteBtn) };

    const sendWithoutNoteBtn = findVisible(b => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      return label.includes('send without a note') || label.includes('send now');
    }, allButtonsUnscoped);
    debug.sendWithoutNoteBtnFound = !!sendWithoutNoteBtn;
    if (sendWithoutNoteBtn) return { debug, sendRect: rectOf(sendWithoutNoteBtn) };

    // Bare "Send" is too generic to search unscoped (confirmed: matches the chat widget) —
    // only attempt it when we actually found a real modal container.
    if (debug.modalContainerFound) {
      const sendBtn = findVisible(b => {
        const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
        return label === 'send' || label === 'send invitation';
      }, allButtons);
      debug.sendBtnFound = !!sendBtn;
      if (sendBtn) return { debug, sendRect: rectOf(sendBtn) };
    }

    return { debug, noModalFound: true };
  };

  const pollForModal = async (iterations) => {
    let s = { noModalFound: true, debug: {} };
    for (let i = 0; i < iterations; i++) {
      await new Promise(r => setTimeout(r, 300));
      const [{ result }] = await safeExecuteScript({ target: { tabId }, args: [note || ''], func: modalScanFunc });
      s = result;
      if (!s.noModalFound) break; // found something actionable — stop polling
    }
    return s;
  };

  let step3 = await pollForModal(15);
  console.log('[LeadPilot BG] Post-click modal scan:', JSON.stringify(step3.debug));

  if (step3.alreadySent) return { success: false, error: 'already_pending' };
  // Fallback: the trusted CDP click didn't open a modal. Try the identity-based pointer
  // click (covers controls the CDP click misses), then re-poll. This is now safe from the
  // earlier double-click-dismiss problem because pollForModal keys off the unscoped
  // "send without a note"/"add a note" search — if the CDP click HAD opened the modal we'd
  // never reach here. Skip on the More-menu path, which already ran its own pointer retry.
  if (step3.noModalFound && !step1.moreBtnRect) {
    // Fallback 1: trusted keyboard activation. CDP mouse clicks can miss hit-testing when the
    // window isn't truly OS-focused (Windows), but a CDP key event needs no hit-test — focus
    // the control in-page and press Enter.
    console.log('[LeadPilot BG] CDP mouse click opened no modal — trying focus + trusted Enter');
    const enterFired = await focusConnectAndEnter(tabId, clickTarget.x, clickTarget.y, 300);
    if (enterFired) {
      step3 = await pollForModal(15);
      console.log('[LeadPilot BG] Post-Enter modal scan:', JSON.stringify(step3.debug));
    }
    // Fallback 2: identity-based synthetic pointer click (covers handlers that don't gate on
    // isTrusted).
    if (step3.noModalFound) {
      console.log('[LeadPilot BG] Enter opened no modal — trying identity-based pointer click');
      const fired = await pointerClickConnectNear(tabId, clickTarget.x, clickTarget.y, 250, 3);
      if (fired) {
        step3 = await pollForModal(15);
        console.log('[LeadPilot BG] Post-pointer-fallback modal scan:', JSON.stringify(step3.debug));
      }
    }
  }
  if (step3.alreadySent) return { success: false, error: 'already_pending' };
  if (step3.noModalFound) {
    // Still no detectable modal — the click may yet have succeeded via a mechanism that
    // produces no visible modal. Verify for real instead of assuming failure.
    console.log('[LeadPilot BG] No modal detected after Connect click — verifying via clean reload anyway');
    return await verifyConnectionSent(tabId, profileUrl, targetVanity);
  }

  // Both paths (clicked "Add a note" first, or landed directly on a combined
  // textarea+Send view like Pearl's modal) can present a textarea + Send button —
  // confirmed this session: blindly clicking "Send" without filling the textarea first
  // hits a disabled button and silently does nothing. Always attempt the fill-then-send
  // sequence whenever either path is available.
  if (step3.addNoteRect || step3.sendRect) {
    if (step3.addNoteRect) {
      // Open the note textarea. Pointer first; if no textarea appears shortly, the trusted
      // CDP click below (via the known addNoteRect) fires. Success here = textarea present,
      // NOT modal closed, so we can't use clickModalButtonRobust.
      await pointerClickButtonInModal(tabId, ['add a note'], 2);
      let taSeen = false;
      for (let i = 0; i < 6; i++) {
        await new Promise(r => setTimeout(r, 300));
        const [{ result }] = await safeExecuteScript({ target: { tabId }, func: () => !!document.querySelector('textarea') });
        if (result) { taSeen = true; break; }
      }
      if (!taSeen) {
        console.log('[LeadPilot BG] "Add a note" pointer click showed no textarea — trying trusted CDP click');
        await cdpClick(tabId, step3.addNoteRect.x, step3.addNoteRect.y);
      }
    }
    const noteFormFunc = (noteText, leadEmail) => {
        const textarea = document.querySelector('textarea');
        if (!textarea) return { found: false };
        textarea.focus();
        textarea.value = noteText.slice(0, 300);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        // Some profiles (confirmed: Premium-flagged accounts) require an email to
        // "verify you know this member" before Send becomes clickable.
        const emailInput = document.querySelector('input[type="email"], input[type="text"]');
        const emailFieldPresent = !!emailInput;
        let emailFilled = false;
        if (emailInput && leadEmail) {
          emailInput.focus();
          emailInput.value = leadEmail;
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          emailInput.dispatchEvent(new Event('change', { bubbles: true }));
          emailFilled = true;
        }

        const sendCandidates = [...document.querySelectorAll('a, button, div, li, span, [role]')]
          .filter(b => {
            const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
            return label === 'send' || label === 'send invitation';
          })
          .map(b => { const r = b.getBoundingClientRect(); return { b, r }; })
          .filter(c => c.r.width > 0 && c.r.height > 0);
        sendCandidates.sort((a, b2) => {
          const aSpan = a.b.tagName === 'SPAN', bSpan = b2.b.tagName === 'SPAN';
          if (aSpan !== bSpan) return aSpan ? 1 : -1;
          return (b2.r.width * b2.r.height) - (a.r.width * a.r.height);
        });
        const sendCandidateInfo = sendCandidates.map(c => c.b.tagName + ' ' + Math.round(c.r.width) + 'x' + Math.round(c.r.height) +
          ' disabled=' + (c.b.disabled || c.b.getAttribute('aria-disabled') === 'true')).slice(0, 6);
        const sendBtn = sendCandidates[0]?.b || null;
        if (!sendBtn) return { found: true, sendRect: null, emailFieldPresent, emailFilled, sendCandidateInfo };
        sendBtn.scrollIntoView({ block: 'center' });
        const r = sendBtn.getBoundingClientRect();
        return {
          found: true,
          sendRect: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
          sendDisabled: sendBtn.disabled || sendBtn.getAttribute('aria-disabled') === 'true',
          emailFieldPresent, emailFilled, sendCandidateInfo,
        };
    };

    // Poll until the textarea actually exists, instead of a fixed wait — same fix as
    // the modal/menu scans above.
    let step4 = { found: false };
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 300));
      const [{ result }] = await safeExecuteScript({ target: { tabId }, args: [note, leadEmail || ''], func: noteFormFunc });
      step4 = result;
      if (step4.found) break;
    }
    console.log('[LeadPilot BG] Note/email form scan:', JSON.stringify(step4));
    if (!step4.found) {
      // No textarea present — the plain "Send without a note" case. Click it with a real
      // pointer sequence (React button; a CDP mouse-only click leaves the modal hanging).
      if (step3.sendRect) {
        const sent = await clickModalButtonRobust(tabId, ['send without a note', 'send now', 'send invitation', 'send']);
        if (sent.disabled) {
          return { success: false, error: 'Send button is disabled — debug: ' + JSON.stringify(sent) };
        }
      } else {
        // Clicked "Add a note" but found neither a textarea nor a fallback Send — ambiguous
        // rather than a confirmed no-op, verify instead of assuming failure.
        await new Promise(r => setTimeout(r, 1000));
        return await verifyConnectionSent(tabId, profileUrl, targetVanity);
      }
    } else if (!step4.sendRect) {
      await new Promise(r => setTimeout(r, 1000));
      return await verifyConnectionSent(tabId, profileUrl, targetVanity);
    } else if (step4.sendDisabled) {
      if (step4.emailFieldPresent && !step4.emailFilled) {
        return { success: false, error: 'requires_email_verification', requiresEmail: true };
      }
      return { success: false, error: 'Send button is disabled — debug: ' + JSON.stringify(step4) };
    } else {
      // Note filled and Send enabled — pointer first, trusted CDP if the modal stays open.
      await clickModalButtonRobust(tabId, ['send', 'send invitation']);
    }
  } else {
    return { success: false, error: 'No usable send path found — debug: ' + JSON.stringify(step3.debug) };
  }

  await new Promise(r => setTimeout(r, 1500));
  return await verifyConnectionSent(tabId, profileUrl, targetVanity);
}

// Extracted so it can be called both after a normal click sequence AND from the
// "ambiguous, nothing clickable found" paths — confirmed this session that a Connect
// click can sometimes succeed via a mechanism that produces no detectable modal at all
// (e.g. via the "More" menu), so giving up immediately on "no modal found" was wrong;
// this is the only reliable way to know what actually happened.
async function verifyConnectionSent(tabId, profileUrl, targetVanity) {
  // ── Verify via a CLEAN page reload, not in-place DOM text search ──
  // Confirmed this session: in-place "pending" text matching can be fooled by page noise
  // (video ads, unrelated overlays mid-load) even when distance-scoped to the click point.
  // A fresh navigation eliminates all of that — reload the same profile from scratch and
  // re-run the exact same Connect-button-finding logic used in Step 1. If that button no
  // longer exists, the request genuinely went through; if it's still there, it didn't.
  let reloadedUrl = '';
  await new Promise(resolve => chrome.tabs.update(tabId, { url: profileUrl }, () => resolve()));
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { reloadedUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    if (reloadedUrl.includes(`/in/${targetVanity}`)) break;
  }
  await new Promise(r => setTimeout(r, 3000)); // let the reloaded page hydrate

  // Decision rule (biased AGAINST false positives — confirmed real data: a not-sent Connect
  // was falsely reported "sent" because the "Connect if you know each other" box renders LATE
  // and a single 3s scan missed it):
  //   • A visible "Pending"/"Withdraw" state  → SENT (success).
  //   • The profile's own Connect control visible at ANY point in the poll → NOT sent.
  //   • Neither, after the full poll → ambiguous → NOT sent ("verify manually").
  // Poll over a longer window so a late-rendering Connect box or Pending state is caught.
  const verifyScan = () => {
    const pageOwnerName = (document.querySelector('h1')?.textContent || '').trim()
      || (document.title || '').split(/[-|]/)[0].trim();
    const pageOwnerFirstName = pageOwnerName.split(/\s+/)[0]?.toLowerCase() || '';
    const MIN_Y = 100;
    // Pierce open shadow DOM — LinkedIn renders the profile action controls (Connect / Pending /
    // the invite modal) inside open shadow roots, which a plain querySelectorAll cannot see.
    const deepEls = () => {
      const out = [];
      const walk = (root) => {
        let list; try { list = root.querySelectorAll('a, button, div, li, span, [role]'); } catch (_) { return; }
        for (const el of list) out.push(el);
        let all; try { all = root.querySelectorAll('*'); } catch (_) { return; }
        for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
      };
      walk(document);
      return out;
    };
    const els = deepEls();
    const inRange = (predicate, maxY = 1200) => els.filter(predicate)
      .map(b => { const r = b.getBoundingClientRect(); return { r, y: Math.round(r.top + window.scrollY) }; })
      .some(c => c.r.width > 0 && c.r.height > 0 && c.y > MIN_Y && c.y <= maxY);

    const connectDirectlyVisible = inRange(b => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      if (label === 'connect') return true;
      if (pageOwnerFirstName && label.includes('invite') && label.includes('to connect') && label.includes(pageOwnerFirstName)) return true;
      return false;
    });
    // Pending/Withdraw can render lower than the action row — allow the whole page.
    const pendingVisible = inRange(b => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      return label === 'pending' || label.includes('pending') || label.includes('withdraw invitation') || label.includes('invitation sent');
    }, 100000);
    // A "Message <name>" button in the top action row (or "Remove Connection") means this
    // person is ALREADY a 1st-degree connection — not a failed invite.
    const messageVisible = inRange(b => {
      const label = (b.getAttribute('aria-label') || b.textContent || '').trim().toLowerCase();
      if (label === 'message') return true;
      if (label.startsWith('message ') && pageOwnerFirstName && label.includes(pageOwnerFirstName)) return true;
      if (label.includes('remove connection')) return true;
      return false;
    });
    return { connectDirectlyVisible, pendingVisible, messageVisible };
  };

  let sawConnect = false;
  let sawMessage = false;
  let last = { connectDirectlyVisible: false, pendingVisible: false, messageVisible: false };
  for (let i = 0; i < 12; i++) {
    const [{ result }] = await safeExecuteScript({ target: { tabId }, func: verifyScan });
    last = result;
    if (result.pendingVisible) {
      console.log('[LeadPilot BG] Verify: Pending/Withdraw detected → invite sent (poll', i + 1, ')');
      return { success: true };
    }
    if (result.connectDirectlyVisible) sawConnect = true;
    if (result.messageVisible) sawMessage = true;
    await new Promise(r => setTimeout(r, 700));
  }
  console.log('[LeadPilot BG] Verify poll done — sawConnect:', sawConnect, 'sawMessage:', sawMessage, '| last:', JSON.stringify(last));

  if (sawConnect) {
    return { success: false, error: 'Connect button still present after a clean reload — the request was not actually sent.' };
  }
  // No Connect and no Pending, but a Message button present → already a 1st-degree connection.
  if (sawMessage) {
    console.log('[LeadPilot BG] Verify: Message button present, no Connect → already connected');
    return { success: false, already_connected: true, error: 'already_connected' };
  }
  // No Pending state and Connect not directly visible. We can't positively confirm a send,
  // and we must NOT claim success without evidence (a false "sent" is worse than a false
  // "failed"). Report honestly so the lead isn't wrongly marked contacted.
  return { success: false, error: 'Could not confirm the invite was sent (no Pending indicator found after reload) — please verify manually.' };
}

// ── Permanent SN resolution: open profile page in a background tab ────────────
// Opens the SN lead page silently, extracts fsd_profile ID AND regular /in/ URL
// from the DOM. Returns { fsdId, linkedinUrl } — fsdId is used directly for the
// invite API (no further resolution needed). 100% reliable — pure DOM scraping.

// SN session activation (opening SN home) is expensive (~15-20s). Once activated,
// it stays valid for a few minutes — cache it so a bulk batch of leads doesn't
// pay this cost on every single lead.
let _snSessionActivatedAt = 0;
const SN_SESSION_TTL_MS = 5 * 60 * 1000;

async function resolveSNUrl(snFull, bgJsessionid) {
  // bgJsessionid: the JSESSIONID read by the background script via chrome.cookies.getAll.
  // document.cookie inside executeScript cannot read HttpOnly cookies, so we pass
  // the value from here as an argument and use it as the CSRF token fallback.
  if (!bgJsessionid) {
    const _c = await new Promise(r => chrome.cookies.getAll({ domain: '.linkedin.com' }, r));
    const _jss = _c.find(c => c.name === 'JSESSIONID' && c.domain === '.linkedin.com') || _c.find(c => c.name === 'JSESSIONID');
    bgJsessionid = (_jss?.value || '').replace(/"/g, '');
  }
  const snPageUrl = `https://www.linkedin.com/sales/lead/${snFull}`;
  console.log('[LeadPilot BG] SN resolve — opening background tab:', snFull.split(',')[0].slice(0, 16), '| CSRF len:', bgJsessionid.length);

  // If no SN tab is open, open SN home first to activate the SN session.
  // Without an active SN context, the lead page redirects to a subscription/login wall.
  const allTabs = await chrome.tabs.query({ url: 'https://*.linkedin.com/*' });
  const snTabs  = allTabs.filter(t => t.url && t.url.includes('/sales/'));
  const sessionRecentlyActivated = Date.now() - _snSessionActivatedAt < SN_SESSION_TTL_MS;
  if (snTabs.length === 0 && !sessionRecentlyActivated) {
    console.log('[LeadPilot BG] No SN tab open — opening SN home to activate session');
    let snHomeTab = null;
    try {
      snHomeTab = await chrome.tabs.create({ url: 'https://www.linkedin.com/sales/home', active: false });
      await new Promise(resolve => {
        const l = (tabId, c) => { if (tabId === snHomeTab.id && c.status === 'complete') { chrome.tabs.onUpdated.removeListener(l); resolve(); } };
        chrome.tabs.onUpdated.addListener(l);
        setTimeout(() => { try { chrome.tabs.onUpdated.removeListener(l); } catch (_) {} resolve(); }, 15000);
      });
      await new Promise(r => setTimeout(r, 3000)); // let SN session cookies settle
      console.log('[LeadPilot BG] SN home loaded — session should now be active');
    } catch (e) {
      console.warn('[LeadPilot BG] SN home open failed:', e.message);
    } finally {
      if (snHomeTab) try { await chrome.tabs.remove(snHomeTab.id); } catch (_) {}
    }
  }
  _snSessionActivatedAt = Date.now();

  let newTab = null;
  try {
    // active:true is required — CDP's Input.dispatchMouseEvent (used below to open the
    // SN "..." menu with a genuinely trusted click) doesn't reliably register hit-testing
    // on background/unfocused tabs. This only affects local browser UI (briefly stealing
    // window focus); LinkedIn's servers have no visibility into Chrome's tab-active state,
    // so this has no effect on account-safety/detection risk. Only runs once per lead —
    // the resolved /in/ URL is saved permanently afterward.
    newTab = await chrome.tabs.create({ url: snPageUrl, active: true });

    // Wait for tab to fully load (max 20 seconds)
    await new Promise(resolve => {
      const listener = (tabId, changeInfo) => {
        if (tabId === newTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
        resolve();
      }, 20000);
    });

    // SN is a React SPA — profile data loads via XHR after page renders.
    // Wait longer so React can hydrate and SN can make its own API calls
    // (which populate the DOM with the "View LinkedIn Profile" link and embedded URNs).
    await new Promise(r => setTimeout(r, 8000));

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: newTab.id },
      func: async (snFull, bgJsessionid) => {
        const pageUrl   = window.location.href;
        const pageTitle = document.title;

        // ── CSRF token ────────────────────────────────────────────────────────
        // CSRF priority: page DOM → background-provided JSESSIONID (HttpOnly, can't read via document.cookie)
        const csrf = (() => {
          try {
            const el = document.getElementById('session-data-serialized');
            if (el) { const d = JSON.parse(el.textContent); if (d?.csrfToken) return d.csrfToken; }
          } catch (_) {}
          const meta = document.querySelector('meta[name="csrf-token"]')?.content;
          if (meta) return meta;
          return bgJsessionid; // ← background passed the real JSESSIONID (read via chrome.cookies)
        })();
        console.log('[SN tab] CSRF len:', csrf.length, '| first 12:', csrf.slice(0, 12));

        const hdr = {
          'accept': 'application/vnd.linkedin.normalized+json+2.1',
          'accept-language': 'en-US,en;q=0.9',
          'csrf-token': csrf,
          'x-restli-protocol-version': '2.0.0',
          'x-li-lang': 'en_US',
          'x-li-track': JSON.stringify({ clientVersion: '1.15.16532', mpVersion: '1.15.16532', osName: 'web', deviceFormFactor: 'DESKTOP', mpName: 'voyager-web' }),
        };

        const snId  = snFull.split(',')[0];
        const snUrn = encodeURIComponent(`urn:li:fs_salesProfile:(${snFull})`);

        function extractFsd(text) {
          const m = text.match(/urn:li:fsd_profile:([A-Za-z0-9+\/=_-]{10,})/);
          return m ? m[1] : null;
        }
        function extractPub(text) {
          const m1 = text.match(/"publicProfileUrl"\s*:\s*"(https?:[^"\\]+\/in\/[^"\\]+)"/);
          if (m1) return m1[1].replace(/\\/g, '');
          const m2 = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{3,120})/);
          return m2 ? `https://www.linkedin.com/in/${m2[1]}` : null;
        }

        // Plain el.click() only fires a synthetic 'click' event — React dropdown/menu
        // components frequently listen for pointerdown/mousedown instead (to support
        // outside-click-to-close logic), so a bare .click() silently does nothing.
        // Dispatch the full real-world event sequence instead.
        function simulateClick(el) {
          const rect = el.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
          try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
          el.dispatchEvent(new MouseEvent('mousedown', opts));
          try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_) {}
          el.dispatchEvent(new MouseEvent('mouseup', opts));
          el.dispatchEvent(new MouseEvent('click', opts));
          el.click(); // belt-and-suspenders: also fire the native click in case neither path is listened for
        }

        let fsdId = null, linkedinUrl = null;

        // ── Method 0: open the "..." (more options) menu and read the link inside ──
        // Confirmed via live DevTools capture: SN's lead page exposes the public /in/
        // link ONLY inside this dropdown (likely portal-rendered, not in the initial DOM) —
        // none of the /voyager/api/ endpoints below have ever returned this data. Try this
        // first since it's the one proven-working path.
        // debug0 is returned to the caller so failures are diagnosable from the visible
        // extension console (this function's own console.log calls run inside a hidden
        // background tab and aren't visible without opening that tab's own devtools).
        const debug0 = { buttonsScanned: 0, buttonLabels: [], moreBtnFound: false, menuAppeared: false, menuItemTexts: [] };
        try {
          const allButtons = [...document.querySelectorAll('button')];
          debug0.buttonsScanned = allButtons.length;
          debug0.buttonLabels = allButtons
            .map(b => (b.getAttribute('aria-label') || b.title || b.textContent || '').trim())
            .filter(Boolean)
            .slice(0, 25);

          // There may be multiple elements matching this label (e.g. a visually-hidden
          // accessibility duplicate plus the real visible control) — getBoundingClientRect()
          // is all-zero for a hidden element (display:none on itself or an ancestor), so
          // prefer the first match that actually has real, non-zero layout dimensions.
          const moreBtnCandidates = allButtons.filter(b => {
            const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().toLowerCase();
            return label === 'more actions' || label === 'more' || label === '...' || label === '•••' || label.includes('overflow') || label.includes('more options') || label.includes('actions');
          });
          debug0.moreBtnCandidateRects = moreBtnCandidates.map(b => {
            const r = b.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          });
          let moreBtn = moreBtnCandidates.find(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          });
          if (!moreBtn) moreBtn = moreBtnCandidates[0]; // fall back to first even if hidden, for debug visibility
          debug0.moreBtnFound = !!moreBtn;

          if (moreBtn) {
            moreBtn.scrollIntoView({ block: 'center' });
            const r = moreBtn.getBoundingClientRect();
            debug0.moreBtnRect = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };

            const beforeClickCount = document.querySelectorAll('*').length;
            simulateClick(moreBtn);

            // Don't guess the dropdown's container/role — just wait for the DOM to grow
            // (new menu content mounted somewhere) then scan broadly for a profile link,
            // since the exact wrapper markup is unknown and not worth guessing twice.
            for (let i = 0; i < 15; i++) {
              await new Promise(r => setTimeout(r, 100));
              if (document.querySelectorAll('*').length !== beforeClickCount) break;
            }
            await new Promise(r => setTimeout(r, 300)); // let menu finish animating in

            // Broad candidate set: any clickable-ish element, not just <a>/[role=menuitem] —
            // LinkedIn often uses div/li/span with a click handler instead of real links.
            const candidates = [...document.querySelectorAll('a, button, div, li, span, [role]')]
              .filter(el => {
                const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                return txt.length > 0 && txt.length < 60 && (
                  txt.includes('linkedin profile') || txt.includes('view profile') ||
                  txt.includes('view on linkedin') || txt.includes('view full profile') ||
                  txt.includes('open linkedin')
                );
              });
            debug0.menuAppeared = document.querySelectorAll('*').length !== beforeClickCount;
            debug0.menuItemTexts = candidates
              .map(el => (el.tagName + ': ' + (el.textContent || el.getAttribute('aria-label') || '').trim()).slice(0, 80))
              .slice(0, 15);

            for (const el of candidates) {
              const href = (el.href || el.getAttribute('href') || '').split('?')[0];
              if (href.includes('/in/')) {
                linkedinUrl = href.replace(/\/$/, '');
                console.log('[SN tab] Method 0: resolved via menu href:', linkedinUrl);
                break;
              }
              // No real href — JS-driven navigation. Click the deepest/most specific
              // matching element and watch for the URL to change.
              const before = window.location.href;
              simulateClick(el);
              for (let i = 0; i < 30 && window.location.href === before; i++) {
                await new Promise(r => setTimeout(r, 100));
              }
              if (window.location.href.includes('/in/')) {
                linkedinUrl = window.location.href.split('?')[0].replace(/\/$/, '');
                console.log('[SN tab] Method 0: resolved via menu click+navigate:', linkedinUrl);
                break;
              }
            }

            // Last resort: if nothing matched by text, dump any href containing "/in/"
            // that appeared anywhere on the page after opening the menu (covers the case
            // where the link text doesn't match our keyword list at all).
            if (!linkedinUrl) {
              const anyInLink = [...document.querySelectorAll('a[href*="/in/"]')]
                .map(a => a.href.split('?')[0])
                .find(href => href.match(/linkedin\.com\/in\/[A-Za-z0-9_-]{3,}/) && !href.includes('/sales/'));
              if (anyInLink) {
                linkedinUrl = anyInLink.replace(/\/$/, '');
                console.log('[SN tab] Method 0: resolved via post-menu /in/ link scan:', linkedinUrl);
              }
            }
          }
        } catch (e) { debug0.error = e.message; }

        // ── Method 1: SN Voyager JSON API (same-origin fetch from within SN tab) ──
        const sig = () => { try { return AbortSignal.timeout(10000); } catch (_) { return undefined; } };

        for (const ep of (fsdId || linkedinUrl) ? [] : [
          `/voyager/api/salesApiProfiles/${snUrn}`,
          `/voyager/api/sales/leads/${snId}`,
          `/voyager/api/salesApiPeopleSearch?q=member&memberIds=List(${encodeURIComponent(snId)})`,
          `/voyager/api/salesApiProfiles/${encodeURIComponent(`urn:li:fs_salesProfile:(${snFull})`)}`,
        ]) {
          try {
            const r = await fetch(ep, { credentials: 'include', headers: hdr, signal: sig() });
            console.log('[SN tab] API', ep.split('?')[0].split('/').pop(), '→ HTTP', r.status);
            if (!r.ok) { console.log('[SN tab] non-200:', r.status, r.url); continue; }
            const json = await r.json();
            const text = JSON.stringify(json);
            console.log('[SN tab] response keys:', Object.keys(json).slice(0, 8).join(', '));
            fsdId       = fsdId      || extractFsd(text);
            linkedinUrl = linkedinUrl || extractPub(text);
            if (fsdId || linkedinUrl) { console.log('[SN tab] resolved via API'); break; }
          } catch (e) { console.warn('[SN tab] API error:', e.message); }
        }

        // ── Method 2: Parse all embedded JSON in <script> tags ──────────────
        // SN React sometimes bootstraps data into inline JSON that's searchable
        if (!fsdId || !linkedinUrl) {
          for (const s of document.querySelectorAll('script[type="application/json"], script:not([src])')) {
            const t = s.textContent || '';
            if (t.includes('fsd_profile:') || t.includes('publicProfileUrl')) {
              fsdId       = fsdId      || extractFsd(t);
              linkedinUrl = linkedinUrl || extractPub(t);
              if (fsdId || linkedinUrl) break;
            }
          }
        }

        // ── Method 3: Full page HTML scan ───────────────────────────────────
        if (!fsdId || !linkedinUrl) {
          const html = document.documentElement.innerHTML;
          fsdId       = fsdId      || extractFsd(html);
          linkedinUrl = linkedinUrl || extractPub(html);
        }

        // ── Method 4: "View LinkedIn Profile" link in rendered DOM ──────────
        if (!linkedinUrl) {
          // Targeted: look for links whose text mentions "linkedin profile"
          for (const el of document.querySelectorAll('a, [role="link"]')) {
            const txt = (el.textContent || el.getAttribute('aria-label') || el.title || '').toLowerCase();
            if (txt.includes('linkedin profile') || txt.includes('view on linkedin') || txt.includes('open linkedin')) {
              const href = (el.href || el.getAttribute('href') || '').split('?')[0];
              if (href.includes('/in/')) { linkedinUrl = href.replace(/\/$/, ''); break; }
            }
          }
        }
        if (!linkedinUrl) {
          // Broader: any /in/ link inside the main profile card section
          const card = document.querySelector(
            '.profile-topcard, [data-view-name="profile-card"], main, [role="main"]'
          ) || document;
          for (const a of card.querySelectorAll('a[href*="/in/"]')) {
            const href = a.href.split('?')[0].replace(/\/$/, '');
            if (href.match(/linkedin\.com\/in\/[A-Za-z0-9_-]{3,}/) && !href.includes('/sales/')) {
              // Skip if it's the nav "Me" link (current user's own profile)
              const txt = (a.textContent || '').trim().toLowerCase();
              if (txt === 'me' || txt === 'you') continue;
              linkedinUrl = href;
              break;
            }
          }
        }

        console.log('[SN tab] final: fsdId=', fsdId?.slice(0,12), 'url=', linkedinUrl);
        return { fsdId, linkedinUrl, pageUrl, pageTitle, debug0 };
      },
      args: [snFull, bgJsessionid],
    });

    console.log('[LeadPilot BG] SN tab URL:', result?.pageUrl);
    console.log('[LeadPilot BG] SN tab title:', result?.pageTitle);
    console.log('[LeadPilot BG] SN resolved fsdId:', result?.fsdId?.slice(0, 12), '| url:', result?.linkedinUrl);

    if (result?.fsdId || result?.linkedinUrl) {
      return result;
    }

    // ── CDP-trusted click fallback ───────────────────────────────────────────
    // The synthetic pointerdown/mousedown/click sequence found the "..." button but
    // never opened its menu — LinkedIn likely checks event.isTrusted (always false for
    // JS-dispatched events) on this control. chrome.debugger's Input.dispatchMouseEvent
    // produces a genuinely OS-trusted click (same mechanism Puppeteer/Selenium use),
    // which a synthetic DOM event can never replicate.
    if (result?.debug0?.moreBtnFound && !result?.debug0?.menuAppeared && result?.debug0?.moreBtnRect) {
      // Re-measure right before clicking instead of reusing the rect captured several
      // seconds ago in the first executeScript call — any scroll/layout shift since then
      // would make stale coordinates miss the real button.
      let clickRect = result.debug0.moreBtnRect;
      try {
        const [{ result: freshRect }] = await chrome.scripting.executeScript({
          target: { tabId: newTab.id },
          func: () => {
            const btn = [...document.querySelectorAll('button')].find(b => {
              const label = (b.getAttribute('aria-label') || b.title || b.textContent || '').trim().toLowerCase();
              const matches = label === 'more actions' || label === 'more' || label === '...' || label === '•••' || label.includes('overflow') || label.includes('more options') || label.includes('actions');
              if (!matches) return false;
              const r = b.getBoundingClientRect();
              return r.width > 0 && r.height > 0;
            });
            if (!btn) return null;
            btn.scrollIntoView({ block: 'center' });
            const r = btn.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          },
        });
        if (freshRect) clickRect = freshRect;
      } catch (e) { console.warn('[LeadPilot BG] re-measure before CDP click failed:', e.message); }

      console.log('[LeadPilot BG] Simulated click did not open menu — trying CDP-trusted click at', clickRect);
      const clicked = await cdpClick(newTab.id, clickRect.x, clickRect.y);
      if (clicked) {
        await new Promise(r => setTimeout(r, 1200));
        try {
          const [{ result: scanResult }] = await chrome.scripting.executeScript({
            target: { tabId: newTab.id },
            func: () => {
              function extractUrlFromEl(el) {
                const href = (el.href || el.getAttribute('href') || '').split('?')[0];
                return href.includes('/in/') ? href.replace(/\/$/, '') : null;
              }
              const candidates = [...document.querySelectorAll('a, button, div, li, span, [role]')]
                .filter(el => {
                  const txt = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                  return txt.length > 0 && txt.length < 60 && (
                    txt.includes('linkedin profile') || txt.includes('view profile') ||
                    txt.includes('view on linkedin') || txt.includes('view full profile') ||
                    txt.includes('open linkedin')
                  );
                });
              const menuItemTexts = candidates
                .map(el => (el.tagName + ': ' + (el.textContent || el.getAttribute('aria-label') || '').trim()).slice(0, 80))
                .slice(0, 15);

              for (const el of candidates) {
                const direct = extractUrlFromEl(el);
                if (direct) return { linkedinUrl: direct, menuItemTexts };
              }
              const anyInLink = [...document.querySelectorAll('a[href*="/in/"]')]
                .map(a => a.href.split('?')[0])
                .find(href => href.match(/linkedin\.com\/in\/[A-Za-z0-9_-]{3,}/) && !href.includes('/sales/'));
              return { linkedinUrl: anyInLink ? anyInLink.replace(/\/$/, '') : null, menuItemTexts };
            },
          });
          console.log('[LeadPilot BG] CDP-click rescan — menu items now seen:', JSON.stringify(scanResult?.menuItemTexts));
          if (scanResult?.linkedinUrl) {
            console.log('[LeadPilot BG] CDP click resolved:', scanResult.linkedinUrl);
            return { ...result, linkedinUrl: scanResult.linkedinUrl };
          }
        } catch (e) {
          console.warn('[LeadPilot BG] post-CDP rescan failed:', e.message);
        }
      } else {
        console.warn('[LeadPilot BG] CDP click attempt itself failed (debugger attach/dispatch error)');
      }
    }

    console.warn('[LeadPilot BG] SN page loaded but nothing extracted from DOM or API');
    if (result?.debug0) {
      console.warn('[LeadPilot BG] Method 0 debug — moreBtnFound:', result.debug0.moreBtnFound,
        '| menuAppeared:', result.debug0.menuAppeared,
        '| buttonsScanned:', result.debug0.buttonsScanned,
        '| error:', result.debug0.error || 'none');
      console.warn('[LeadPilot BG] Method 0 debug — button labels seen:', JSON.stringify(result.debug0.buttonLabels));
      console.warn('[LeadPilot BG] Method 0 debug — menu item texts seen:', JSON.stringify(result.debug0.menuItemTexts));
      console.warn('[LeadPilot BG] Method 0 debug — moreBtn candidate rects (w/h):', JSON.stringify(result.debug0.moreBtnCandidateRects));
    }

  } catch (e) {
    console.error('[LeadPilot BG] SN page resolution failed:', e.message);
    return null;
  } finally {
    if (newTab) {
      try { await chrome.tabs.remove(newTab.id); } catch (_) {}
    }
  }
}

async function resolveSNViaTab(tabId, snFull) {
  // Resolve SN ID to regular LinkedIn URL using executeScript on an EXISTING SN tab.
  // No background tabs needed — runs directly in the authenticated SN page context.
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (snFull) => {
        const csrf = (() => {
          try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d?.csrfToken) return d.csrfToken; } } catch (_) {}
          const m = document.cookie.match(/JSESSIONID="?([^";]+)/); return m?.[1] || '';
        })();
        const hdr = { 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
        const snId  = snFull.split(',')[0];
        const snUrn = encodeURIComponent(`urn:li:fs_salesProfile:(${snFull})`);
        const sig   = () => { try { return AbortSignal.timeout(6000); } catch (_) { return undefined; } };

        function extractUrl(text) {
          const m1 = text.match(/"publicProfileUrl"\s*:\s*"([^"]+)"/);
          if (m1 && m1[1].includes('/in/')) return m1[1].replace(/\\/g, '');
          const m2 = text.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/([A-Za-z0-9_%-]{3,120})/);
          if (m2) return `https://www.linkedin.com/in/${m2[1]}`;
          return null;
        }

        const diag = [];
        for (const ep of [
          `/voyager/api/salesApiProfiles/${snUrn}`,
          `/voyager/api/sales/leads/${snId}`,
          `/voyager/api/salesApiPeopleSearch?q=member&memberIds=List(${encodeURIComponent(snId)})`,
        ]) {
          try {
            const r = await fetch(ep, { credentials: 'include', headers: hdr, signal: sig() });
            const body = r.ok ? JSON.stringify(await r.json()) : '';
            const u = r.ok ? extractUrl(body) : null;
            diag.push(ep.split('?')[0].split('/').pop() + ':' + r.status + (u ? '✓' : ''));
            if (u) return { url: u, diag };
          } catch (e) { diag.push(ep.split('/').pop() + ':err'); }
        }
        return { url: null, diag };
      },
      args: [snFull],
    });
    return result;
  } catch (e) {
    console.warn('[LeadPilot BG] resolveSNViaTab failed:', e.message);
    return null;
  }
}

async function handlePageScraped(msg) {
  const { job_id, profiles, page, total, max } = msg;
  const isDone = total >= max || profiles.length === 0;
  console.log('[LeadPilot BG] Page', page, '—', profiles.length, 'profiles, total:', total, 'done:', isDone);

  // NOTE: We deliberately DO NOT resolve Sales Navigator URLs anymore. LinkedIn removed that API
  // (every endpoint 404s) and the sequential per-profile resolution stalled the fetch and dropped
  // profiles. All profiles are posted as-is below; the backend normalises /sales/lead/<id> to
  // /in/<id> and invites still send via that id.

  // Background updates session storage (not content script — avoids content script storage hangs)
  try {
    if (isDone) {
      await chrome.storage.session.remove('lp_scrape_job');
    } else {
      const stored = await chrome.storage.session.get('lp_scrape_job');
      const job = stored?.lp_scrape_job;
      if (job && job.job_id === job_id) {
        await chrome.storage.session.set({ lp_scrape_job: { ...job, page, total } });
        console.log('[LeadPilot BG] Job updated: page', page, 'total', total);
      }
    }
  } catch (e) {
    console.warn('[LeadPilot BG] Storage update failed:', e.message);
  }

  await post('/scrape/extension-update', {
    job_id,
    status: isDone ? 'done' : 'running',
    new_profiles: profiles,
    progress_profiles: total,
    progress_pages: page,
    finished: isDone,
  });

  return { done: isDone };
}

async function handleDone(job_id) {
  await chrome.storage.session.remove('lp_scrape_job');
  await post('/scrape/extension-update', { job_id, status: 'done', finished: true });
}

async function handleSaveSession() {
  const cookies = await new Promise(r => chrome.cookies.getAll({ domain: '.linkedin.com' }, r));
  const li_at = cookies.find(c => c.name === 'li_at');
  if (!li_at) return { success: false, error: 'Not logged into LinkedIn in this browser.' };

  // Extract profile data from the LinkedIn page — runs in the user's own browser (same IP).
  // The backend must never call LinkedIn's API with these cookies; doing so flags the session
  // as active from two IPs and LinkedIn forces an immediate logout.
  let profileName = null, profileHeadline = null, profileUrl = null;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://*.linkedin.com/*' });
    if (tabs.length > 0) {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        world: 'MAIN',
        func: () => {
          // Primary source: session-data-serialized (always present on authenticated pages)
          const el = document.getElementById('session-data-serialized');
          if (el) {
            try {
              const d = JSON.parse(el.textContent);
              if (d?.userDisplayName) {
                return {
                  name:     d.userDisplayName || null,
                  url:      d.userProfileUrl  || null,
                  headline: null, // not in this element; extracted below
                };
              }
            } catch (_) {}
          }
          return null;
        },
      });
      if (result?.name)     profileName     = result.name;
      if (result?.url)      profileUrl      = result.url;
      if (result?.headline) profileHeadline = result.headline;

      // Secondary: try to get headline from the feed left-panel mini-profile card
      if (!profileHeadline && tabs.length > 0) {
        try {
          const [{ result: r2 }] = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            world: 'MAIN',
            func: () => {
              const selectors = [
                // Feed left panel — LinkedIn redesigns these periodically
                '.profile-rail-card__actor-meta .t-12.t-black--light',
                '.feed-identity-module__actor-meta .t-12',
                '.profile-rail-card__actor-meta p',
                '[data-control-name="identity_profile_photo"] ~ * .t-12',
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el?.textContent?.trim()) return el.textContent.trim();
              }
              return null;
            },
          });
          if (r2) profileHeadline = r2;
        } catch (_) {}
      }
    }
  } catch (_) {}

  const storage_state = { cookies: cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite === 'no_restriction' ? 'None'
            : c.sameSite === 'lax'             ? 'Lax'
            : c.sameSite === 'strict'          ? 'Strict'
            : 'None',
    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
  })) };
  try {
    const res = await fetch(`${API}/linkedin/save-session`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ storage_state, account_name: 'default', profile_name: profileName, profile_headline: profileHeadline, profile_url: profileUrl }),
    });
    const data = await res.json();
    return { success: data.success ?? res.ok, message: data.message };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function handleSendInvite({ linkedin_url, note, job_id, lead_email }) {
  // Surface whether a personalized note actually arrived from the backend. sendPath:'none' in the
  // modal handlers can mean EITHER "note branch failed" OR simply "note is empty" — this disambiguates.
  console.log('[LeadPilot BG] handleSendInvite — note length:', (note || '').trim().length, '| preview:', JSON.stringify((note || '').slice(0, 60)));
  // Parse SN URL in OUTER scope — needed for the background tab fallback below
  const _mSNOuter = linkedin_url.match(/\/sales\/lead\/([^/?#]+)/);
  const salesNavFull = _mSNOuter ? _mSNOuter[1] : null;   // "ACo...,NAME_SEARCH,xyz"

  // Helper: ALWAYS notify backend before returning — prevents the 60-second timeout
  async function done(result) {
    await post(`/leads/connect-job/${job_id}/extension-result`, {
      success: result.success,
      note: result.success ? note : undefined,
      error: result.error,
      session_expired: result.session_expired ?? false,
    });
    return result;
  }

  // Verify LinkedIn cookies exist in the browser
  const cookies = await new Promise(r => chrome.cookies.getAll({ domain: '.linkedin.com' }, r));
  const li_at = cookies.find(c => c.name === 'li_at');
  if (!li_at) return done({ success: false, error: 'session_expired (not logged in)', session_expired: true });

  // Check if li_at cookie has actually expired (expirationDate is in seconds)
  if (li_at.expirationDate && li_at.expirationDate < Date.now() / 1000) {
    return done({ success: false, error: 'session_expired (li_at cookie expired — please log into LinkedIn)', session_expired: true });
  }

  // Prefer the broad .linkedin.com JSESSIONID; strip surrounding quotes LinkedIn adds
  const jsessionCookie = cookies.find(c => c.name === 'JSESSIONID' && c.domain === '.linkedin.com')
    || cookies.find(c => c.name === 'JSESSIONID');
  const jsessionid = (jsessionCookie?.value || '').replace(/"/g, '');

  console.log('[LeadPilot BG] cookies:', cookies.map(c => c.name).join(', '));
  console.log('[LeadPilot BG] JSESSIONID:', jsessionid ? jsessionid.slice(0, 12) + '... (' + jsessionid.length + ' chars)' : 'NOT FOUND');

  // ── SN pre-resolution ─────────────────────────────────────────────────────
  // SN Voyager APIs (/salesApiProfiles/) only work from within an SN-authenticated
  // tab context. Resolve SN → regular /in/ URL NOW using an existing SN tab, then
  // the normal invite path runs against a regular LinkedIn URL — no SN complexity.
  let effectiveUrl = linkedin_url;
  let effectiveSNFull = salesNavFull;

  if (salesNavFull) {
    // 1. Try existing open SN tab first (zero extra tabs opened)
    const snTabs = (await chrome.tabs.query({ url: 'https://*.linkedin.com/sales/*' }))
      .filter(t => t.url && !t.url.includes('/login') && !t.url.includes('/uas/'));

    if (snTabs.length > 0) {
      console.log('[LeadPilot BG] SN URL — resolving via existing SN tab:', snTabs[0].url?.split('/').slice(0, 5).join('/'));
      const resolvedUrl = await resolveSNViaTab(snTabs[0].id, salesNavFull);
      if (resolvedUrl && resolvedUrl.includes('/in/')) {
        console.log('[LeadPilot BG] SN pre-resolved:', resolvedUrl);
        await post('/leads/update-linkedin-url', { lead_sn_url: linkedin_url, linkedin_url: resolvedUrl });
        effectiveUrl    = resolvedUrl;
        effectiveSNFull = null;
      } else {
        console.warn('[LeadPilot BG] SN tab found but resolveSNViaTab returned:', resolvedUrl);
      }
    } else {
      console.log('[LeadPilot BG] No SN tab open — will open background SN tab for resolution');
    }

    // 2. No SN tab open (or tab resolve failed) — open the SN lead page and resolve
    if (effectiveSNFull) {
      const snData = await resolveSNUrl(effectiveSNFull, jsessionid);
      if (snData?.linkedinUrl && snData.linkedinUrl.includes('/in/')) {
        console.log('[LeadPilot BG] SN background tab resolved:', snData.linkedinUrl);
        await post('/leads/update-linkedin-url', { lead_sn_url: linkedin_url, linkedin_url: snData.linkedinUrl });
        effectiveUrl    = snData.linkedinUrl;
        effectiveSNFull = null;
      } else if (snData?.fsdId) {
        // Have the fsd_profile ID but not the /in/ URL — send invite directly via tab
        console.log('[LeadPilot BG] SN resolved to fsdId:', snData.fsdId.slice(0, 12));
        const liTabs = (await chrome.tabs.query({ url: 'https://*.linkedin.com/*' }))
          .filter(t => t.url && !t.url.includes('/login'));
        const liTab = liTabs.find(t => t.url?.includes('/feed')) || liTabs[0];
        if (liTab) {
          const [{ result: fsdInvResult }] = await chrome.scripting.executeScript({
            target: { tabId: liTab.id },
            func: async (fsdId, noteText, jss) => {
              const csrf = (() => { try { const el = document.getElementById('session-data-serialized'); if (el) { const d = JSON.parse(el.textContent); if (d?.csrfToken) return d.csrfToken; } } catch (_) {} return jss; })();
              if (!csrf) return { success: false, error: 'session_expired (no CSRF)', session_expired: true };
              const hdr = { 'accept': 'application/vnd.linkedin.normalized+json+2.1', 'content-type': 'application/json', 'csrf-token': csrf, 'x-restli-protocol-version': '2.0.0', 'x-li-lang': 'en_US' };
              const p = { emberEntityName: 'growth/invitation', invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: fsdId } }, trackingId: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))) };
              if (noteText?.trim()) p.message = noteText.trim().slice(0, 300);
              for (const ep of ['https://www.linkedin.com/voyager/api/growth/normInvitations', 'https://www.linkedin.com/voyager/api/relationships/normInvitations']) {
                try {
                  const res = await fetch(ep, { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify(p) });
                  if (res.status === 200 || res.status === 201) return { success: true };
                  if (res.status === 429) return { success: false, error: 'rate_limited' };
                  if (res.url?.includes('/login')) return { success: false, error: 'session_expired', session_expired: true };
                  if (res.status === 404) continue;
                } catch (_) {}
              }
              return { success: false, error: 'Invite endpoints failed' };
            },
            args: [snData.fsdId, note, jsessionid],
          });
          if (fsdInvResult) return done(fsdInvResult);
        }
        return done({ success: false, error: 'SN resolved but no LinkedIn tab found to send invite' });
      }
    }

    // Still could not resolve SN
    if (effectiveSNFull) {
      return done({ success: false, error: 'Could not resolve Sales Navigator profile. Open a Sales Navigator tab in this Chrome window, then retry.' });
    }
  }

  // Run all LinkedIn API calls inside an actual LinkedIn tab so that
  // fetch() is same-origin and cookies attach naturally (MV3 background
  // fetch cross-origin does NOT reliably attach browser cookies).
  //
  // IMPORTANT: Never open a background tab just to close it immediately.
  // LinkedIn's fraud detection flags open→API calls→close as bot behavior → account logout.
  // Strategy: reuse the best existing LinkedIn tab; only create one if none exists, and leave it open.
  const allLiTabs = await chrome.tabs.query({ url: 'https://*.linkedin.com/*' });
  const goodTabs = allLiTabs.filter(t =>
    t.url && !t.url.includes('/login') && !t.url.includes('/uas/') && !t.url.includes('/checkpoint/')
  );
  const feedTabs = goodTabs.filter(t => t.url?.includes('/feed'));
  const bestTab = feedTabs[0] || goodTabs[0];

  let tabId;
  let createdTab = null;
  if (bestTab) {
    tabId = bestTab.id;
    console.log('[LeadPilot BG] reusing tab:', tabId, bestTab.url);
  } else {
    // No usable LinkedIn tab open — create one and leave it open (closing it looks like a bot)
    createdTab = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false });
    tabId = createdTab.id;
    await new Promise(resolve => {
      const onUpdated = (tid, changeInfo) => {
        if (tid === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(onUpdated);
      setTimeout(resolve, 20000);
    });
    await new Promise(r => setTimeout(r, 1000));
  }

  // URL check: must be on an authenticated LinkedIn page — catches login page, landing page, checkpoints
  let finalUrl = '';
  try { finalUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}

  // If we created a new tab, wait for it to fully load before checking URL
  if (createdTab) {
    // already waited above; re-read final URL
    try { finalUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
  }

  const isLoginPage = finalUrl && (
    finalUrl.includes('/login') || finalUrl.includes('/uas/') ||
    finalUrl.includes('/checkpoint/') || finalUrl.includes('/authwall')
  );
  if (isLoginPage) {
    return done({ success: false, error: 'session_expired (redirected to login — please log into LinkedIn and retry)', session_expired: true });
  }

  // (Removed the old isAuthPage whitelist check — it only recognized a handful of URL
  // patterns like /feed, /mynetwork, /in/, and falsely flagged valid authenticated pages
  // like /analytics/profile-views/ as "session expired", blocking the real flow below
  // before it could even run. clickConnectButton() does its own navigation + verification
  // and will correctly detect a genuine login redirect.)

  // Real-button click, not API calls — see clickConnectButton() for why.
  let result;
  try {
    result = await clickConnectButton(tabId, effectiveUrl, note, lead_email);
  } catch (e) {
    result = { success: false, error: e.message };
  }

  // ── SN fallback (should not normally be reached — pre-resolution above handles SN) ──
  // Only hits here if the pre-resolution somehow missed and the in-page executeScript
  // still got __sn_resolve_failed__ (e.g., effectiveSNFull was cleared but URL wasn't updated).
  if (result?.error === '__sn_resolve_failed__' && effectiveSNFull) {
    console.log('[LeadPilot BG] SN fallback — trying background tab approach');
    const snData = await resolveSNUrl(effectiveSNFull, jsessionid);

    if (snData?.fsdId || snData?.linkedinUrl) {
      // Persist the resolved regular URL so future invites skip SN resolution entirely
      if (snData.linkedinUrl) {
        await post('/leads/update-linkedin-url', {
          lead_sn_url: linkedin_url,
          linkedin_url: snData.linkedinUrl,
        });
        console.log('[LeadPilot BG] SN URL saved to backend:', snData.linkedinUrl);
      }

      // Send the invite from WITHIN an existing LinkedIn tab (same-origin → no CORS).
      // Background-script fetch() to LinkedIn is blocked by CORS (extension origin ≠ linkedin.com).
      if (snData.fsdId) {
        const liTabs = (await chrome.tabs.query({ url: 'https://*.linkedin.com/*' }))
          .filter(t => t.url && !t.url.includes('/login') && !t.url.includes('/uas/'));
        const liTab = liTabs.find(t => t.url?.includes('/feed')) || liTabs[0];

        if (liTab) {
          try {
            const cookies4 = await new Promise(r => chrome.cookies.getAll({ domain: '.linkedin.com' }, r));
            const jss4 = (cookies4.find(c => c.name === 'JSESSIONID')?.value || '').replace(/"/g, '');

            const [{ result: invResult }] = await chrome.scripting.executeScript({
              target: { tabId: liTab.id },
              func: async (fsdId, noteText, jsessionid) => {
                // CSRF from page (authoritative) or fall back to background-supplied jsessionid
                const csrf = (() => {
                  try {
                    const el = document.getElementById('session-data-serialized');
                    if (el) { const d = JSON.parse(el.textContent); if (d?.csrfToken) return d.csrfToken; }
                  } catch (_) {}
                  return jsessionid;
                })();
                if (!csrf) return { success: false, error: 'session_expired (no CSRF)', session_expired: true };

                const hdr = {
                  'accept': 'application/vnd.linkedin.normalized+json+2.1',
                  'content-type': 'application/json',
                  'csrf-token': csrf,
                  'x-restli-protocol-version': '2.0.0',
                  'x-li-lang': 'en_US',
                  'x-li-track': JSON.stringify({ clientVersion: '1.15.16532', mpVersion: '1.15.16532', osName: 'web', deviceFormFactor: 'DESKTOP', mpName: 'voyager-web' }),
                };
                const payload = {
                  emberEntityName: 'growth/invitation',
                  invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: fsdId } },
                  trackingId: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
                };
                if (noteText?.trim()) payload.message = noteText.trim().slice(0, 300);

                const sig = () => { try { return AbortSignal.timeout(10000); } catch (_) {} };
                for (const ep of [
                  'https://www.linkedin.com/voyager/api/growth/normInvitations',
                  'https://www.linkedin.com/voyager/api/relationships/normInvitations',
                ]) {
                  try {
                    const res = await fetch(ep, { method: 'POST', credentials: 'include', headers: hdr, body: JSON.stringify(payload), signal: sig() });
                    console.log('[SN invite via tab]', ep.split('/').pop(), '→ HTTP', res.status, '| url:', res.url);
                    if (res.status === 200 || res.status === 201) return { success: true };
                    if (res.url?.includes('/login') || res.url?.includes('/uas/')) return { success: false, error: 'session_expired', session_expired: true };
                    if (res.status === 429) return { success: false, error: 'rate_limited' };
                    if (res.status === 200) { // HTML content (login redirect)
                      let ct = ''; try { ct = res.headers.get('content-type') || ''; } catch (_) {}
                      if (ct.includes('html')) return { success: false, error: 'session_expired (redirect)', session_expired: true };
                    }
                    try {
                      const d = await res.json();
                      const m = d.message || '';
                      if (m.includes('AlreadySent') || m.includes('alreadySent')) return { success: false, error: 'already_pending' };
                      if (m.includes('AlreadyConnected')) return { success: false, error: 'already_connected' };
                    } catch (_) {}
                    if (res.status === 404) continue; // try next endpoint
                  } catch (e) { console.warn('[SN invite via tab] error:', e.message); }
                }
                return { success: false, error: 'All invite endpoints failed' };
              },
              args: [snData.fsdId, note, jss4],
            });

            console.log('[LeadPilot BG] SN invite via tab result:', invResult);
            if (invResult?.success) return done({ success: true });
            if (invResult?.error === 'already_pending') return done({ success: false, error: 'already_pending' });
            if (invResult?.error === 'already_connected') return done({ success: false, error: 'already_connected' });
            if (invResult?.session_expired) return done({ success: false, error: invResult.error, session_expired: true });
            // Non-fatal: fall through to retry-with-URL message
          } catch (e4) {
            console.error('[LeadPilot BG] SN tab invite failed:', e4.message);
          }
        }
      }

      // We resolved the URL but the invite failed — tell user to retry (URL is now saved)
      if (snData.linkedinUrl) {
        return done({ success: false, error: `SN URL resolved to ${snData.linkedinUrl} — please click Send Invite again now` });
      }
    }

    result = { success: false, error: 'Could not resolve Sales Navigator profile. Make sure you are logged into LinkedIn and Sales Navigator tab is open, then retry.' };
  }

  // Note: we intentionally do NOT close any tab — closing a tab immediately after API calls
  // looks like bot behavior to LinkedIn and triggers account logout.
  return done(result);
}


async function handleResolveSNUrls(leads, callerTabId) {
  const resolved = [];
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const snFull = (lead.sn_url || '').split('/sales/lead/')[1]?.split('?')[0];
    if (snFull) {
      try {
        const snData = await resolveSNUrl(snFull);
        const linkedinUrl = snData?.linkedinUrl;
        if (linkedinUrl && linkedinUrl.includes('/in/')) {
          resolved.push({ lead_id: lead.lead_id, linkedin_url: linkedinUrl });
          // Save to backend immediately
          await post(`/leads/update-linkedin-url`, { lead_id: lead.lead_id, linkedin_url: linkedinUrl });
        }
      } catch (e) {
        console.warn('[LeadPilot BG] SN resolve failed for lead', lead.lead_id, ':', e.message);
      }
    }
    if (callerTabId) {
      chrome.tabs.sendMessage(callerTabId, {
        type: 'SN_RESOLVE_PROGRESS', done: i + 1, total: leads.length, resolved: resolved.length,
      }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 300)); // small delay between calls
  }
  console.log('[LeadPilot BG] Bulk SN resolve done:', resolved.length, 'of', leads.length);
  return { resolved };
}

// Reconcile lead statuses against LinkedIn's ACTUAL sent-invitations list: fetch the pending
// invitee vanities in-tab, then hand them to the backend which flips matched leads → PENDING and
// clears any lead wrongly marked pending (false positives from earlier UI attempts) → NOT_SENT.
async function handleSyncSentStatus() {
  const liTabs = (await chrome.tabs.query({ url: 'https://*.linkedin.com/*' }))
    .filter(t => t.url && !t.url.includes('/login') && !t.url.includes('/checkpoint/'));
  const tab = liTabs.find(t => t.url?.includes('/feed')) || liTabs[0];
  if (!tab) return { success: false, error: 'No LinkedIn tab is open. Open linkedin.com in this Chrome window, then Sync again.' };
  const [{ result }] = await safeExecuteScript({ target: { tabId: tab.id }, func: _lpFetchSentInvites });
  console.log('[LeadPilot BG] Sent-invites fetch:', JSON.stringify({ steps: result?.steps, count: (result?.vanities || []).length }));
  const vanities = result?.vanities || [];
  if (!result || result.error || (!vanities.length && !(result.steps || []).some(s => s.status === 200))) {
    return { success: false, error: `Could not read LinkedIn's sent-invitations list (${result?.error || 'no endpoint returned data'}). Make sure you're logged in.`, diag: result };
  }
  // Also read 1st-degree connections so already-connected leads are marked ACCEPTED (not Pending).
  let connected = [], connectedIds = [], connectedNames = [];
  try {
    const [{ result: conns }] = await safeExecuteScript({ target: { tabId: tab.id }, func: _lpFetchConnections });
    connected = conns?.vanities || [];
    connectedIds = conns?.ids || [];
    connectedNames = conns?.names || [];
    console.log('[LeadPilot BG] Connections fetch:', JSON.stringify({ steps: conns?.steps, count: connected.length, ids: connectedIds.length, names: connectedNames.length }));
  } catch (e) { console.warn('[LeadPilot BG] Connections fetch failed:', e.message); }
  try {
    const res = await fetch(`${API}/leads/reconcile-status`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ pending_vanities: vanities, pending_names: result?.names || [], connected_vanities: connected, connected_ids: connectedIds, connected_names: connectedNames }) });
    const raw = await res.text();
    console.log('[LeadPilot BG] reconcile-status HTTP', res.status, '| body:', raw.slice(0, 300));
    let data = {}; try { data = JSON.parse(raw); } catch (_) {}
    if (!res.ok) return { success: false, error: `Backend reconcile returned HTTP ${res.status}: ${raw.slice(0, 160)}` };
    return { success: true, pendingOnLinkedIn: vanities.length, ...(data?.data || {}) };
  } catch (e) {
    return { success: false, error: 'Backend reconcile request failed: ' + e.message };
  }
}

// Fetch LinkedIn conversations in-tab and hand them to the backend to match-by-vanity and store.
async function handleFetchInbox() {
  const liTabs = (await chrome.tabs.query({ url: 'https://*.linkedin.com/*' }))
    .filter(t => t.url && !t.url.includes('/login') && !t.url.includes('/checkpoint/'));
  const tab = liTabs.find(t => t.url?.includes('/feed')) || liTabs[0];
  if (!tab) return { success: false, error: 'No LinkedIn tab is open. Open linkedin.com and try again.' };
  const [{ result }] = await safeExecuteScript({ target: { tabId: tab.id }, func: _lpFetchInbox });
  console.log('[LeadPilot BG] Inbox fetch:', JSON.stringify({ steps: result?.steps, me: result?.me, convs: (result?.convs || []).length, withMsgs: result?.withMsgs, msgCounts: result?.msgCounts, parseError: result?.parseError }));
  if (result?.sample) console.log('[LeadPilot BG] Inbox raw sample:', result.sample);
  const convs = result?.convs || [];
  if (!result || result.error) return { success: false, error: `Could not read LinkedIn inbox (${result?.error || 'unknown'}).`, diag: result };
  try {
    const res = await fetch(`${API}/inbox/ingest`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ conversations: convs }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, error: `Backend inbox ingest HTTP ${res.status}` };
    return { success: true, fetched: convs.length, ...(data?.data || {}) };
  } catch (e) {
    return { success: false, error: 'Backend inbox ingest failed: ' + e.message };
  }
}

// Send a LinkedIn message in-tab. `target` is a conversation urn / threadId / recipient profile urn /
// public vanity (from the lead's /in/<vanity>). Used by inbox replies and campaign follow-ups.
async function handleSendMessage({ target, linkedin_url, thread, text }) {
  const tgt = target || thread || (linkedin_url && (linkedin_url.split('/in/')[1] || '').split(/[/?#]/)[0]) || '';
  if (!tgt) return { success: false, error: 'No recipient/conversation given.' };
  if (!text || !String(text).trim()) return { success: false, error: 'Empty message.' };
  const liTabs = (await chrome.tabs.query({ url: 'https://*.linkedin.com/*' }))
    .filter(t => t.url && !t.url.includes('/login') && !t.url.includes('/checkpoint/'));
  const tab = liTabs.find(t => t.url?.includes('/feed')) || liTabs[0];
  if (!tab) return { success: false, error: 'No LinkedIn tab is open. Open linkedin.com and try again.' };
  const [{ result }] = await safeExecuteScript({ target: { tabId: tab.id }, args: [tgt, String(text)], func: _lpSendMessage });
  console.log('[LeadPilot BG] Send message result:', JSON.stringify(result));
  if (result?.success) return { success: true, messageUrn: result.messageUrn };
  return { success: false, error: `Message not sent (${(result?.steps || []).map(s => s.status || s.error).join(',') || result?.error || 'unknown'}).`, diag: result };
}

async function post(path, body) {
  try {
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    if (!res.ok) console.warn('[LeadPilot BG] POST', path, res.status);
  } catch (e) {
    console.error('[LeadPilot BG] POST failed:', path, e.message);
  }
}
