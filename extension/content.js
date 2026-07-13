// Runs on localhost:3000 — bridges page events to extension background

// ── Pass the logged-in user's JWT to the extension ─────────────────────────────
// Read the web app's auth token from localStorage and hand it to the background script so the
// extension's backend calls are scoped to THIS user. Re-check periodically so login/logout in
// the same tab is picked up (the 'storage' event only fires for other tabs).
let _lpLastToken = undefined;
function _lpPushToken() {
  try {
    const t = window.localStorage.getItem('leadpilot-token');
    if (t !== _lpLastToken) {
      _lpLastToken = t;
      chrome.runtime.sendMessage({ type: 'SET_AUTH_TOKEN', token: t || null }, () => void chrome.runtime.lastError);
    }
  } catch (_) {}
}
_lpPushToken();
setInterval(_lpPushToken, 2000);
window.addEventListener('storage', _lpPushToken);

window.addEventListener('leadpilot-scrape-start', (e) => {
  chrome.runtime.sendMessage({ type: 'START_SCRAPE', ...e.detail }, () => {
    if (chrome.runtime.lastError) console.error('[LeadPilot] sendMessage error:', chrome.runtime.lastError.message);
  });
});
window.addEventListener('leadpilot-send-invite', (e) => {
  chrome.runtime.sendMessage({ type: 'SEND_INVITE', ...e.detail }, (response) => {
    const err = chrome.runtime.lastError;
    window.dispatchEvent(new CustomEvent(`leadpilot-invite-result-${e.detail.job_id}`, {
      detail: err ? { success: false, error: err.message } : (response || {}),
    }));
  });
});
window.addEventListener('leadpilot-ping', () => {
  window.dispatchEvent(new CustomEvent('leadpilot-extension-ready'));
});
window.addEventListener('leadpilot-sync-status', () => {
  chrome.runtime.sendMessage({ type: 'SYNC_SENT_STATUS' }, (response) => {
    const err = chrome.runtime.lastError;
    window.dispatchEvent(new CustomEvent('leadpilot-sync-status-result', {
      detail: err ? { success: false, error: err.message } : (response || {}),
    }));
  });
});
window.addEventListener('leadpilot-fetch-inbox', () => {
  chrome.runtime.sendMessage({ type: 'FETCH_INBOX' }, (response) => {
    const err = chrome.runtime.lastError;
    window.dispatchEvent(new CustomEvent('leadpilot-fetch-inbox-result', {
      detail: err ? { success: false, error: err.message } : (response || {}),
    }));
  });
});
window.addEventListener('leadpilot-send-message', (e) => {
  const detail = e.detail || {};
  chrome.runtime.sendMessage({ type: 'SEND_MESSAGE', ...detail }, (response) => {
    const err = chrome.runtime.lastError;
    window.dispatchEvent(new CustomEvent(`leadpilot-send-message-result-${detail.reqId || ''}`, {
      detail: err ? { success: false, error: err.message } : (response || {}),
    }));
  });
});
window.addEventListener('leadpilot-save-session', () => {
  chrome.runtime.sendMessage({ type: 'SAVE_SESSION' }, (response) => {
    const err = chrome.runtime.lastError;
    window.dispatchEvent(new CustomEvent('leadpilot-session-saved', {
      detail: err ? { success: false, error: err.message } : (response || {}),
    }));
  });
});

// Bulk resolve Sales Navigator URLs to regular LinkedIn URLs
window.addEventListener('leadpilot-resolve-sn', (e) => {
  const leads = e.detail?.leads || [];
  chrome.runtime.sendMessage({ type: 'RESOLVE_SN_URLS', leads }, (response) => {
    const err = chrome.runtime.lastError;
    window.dispatchEvent(new CustomEvent('leadpilot-sn-resolved', {
      detail: err ? { resolved: [], error: err.message } : (response || { resolved: [] }),
    }));
  });
});

// Live progress updates from the background script while bulk-resolving SN URLs
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SN_RESOLVE_PROGRESS') {
    window.dispatchEvent(new CustomEvent('leadpilot-sn-resolve-progress', {
      detail: { done: msg.done, total: msg.total, resolved: msg.resolved },
    }));
  }
});

window.dispatchEvent(new CustomEvent('leadpilot-extension-ready'));
