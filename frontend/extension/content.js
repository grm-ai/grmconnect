/**
 * Content script — runs on localhost:3000.
 * Bridges DOM events → extension background worker.
 */

// Forward scrape-start events to the background worker
window.addEventListener('leadpilot-scrape-start', (e) => {
  chrome.runtime.sendMessage({ type: 'START_SCRAPE', ...e.detail }, () => {
    if (chrome.runtime.lastError) {
      console.error('[LeadPilot] sendMessage error:', chrome.runtime.lastError.message);
    }
  });
});

// Answer readiness pings from the page (handles timing race)
window.addEventListener('leadpilot-ping', () => {
  window.dispatchEvent(new CustomEvent('leadpilot-extension-ready'));
});

// Fire ready event immediately (for pages that loaded before this script)
window.dispatchEvent(new CustomEvent('leadpilot-extension-ready'));
