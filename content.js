(function() {
  'use strict';

  // Bridge: page (hook.js) -> extension (background.js)
  window.addEventListener('message', (e) => {
    try {
      if (e.source !== window) return;
      if (!e.data || e.data.source !== 'meet-capture-hook') return;

      chrome.runtime.sendMessage({
        type: e.data.type,
        payload: e.data.payload
      }, () => { void chrome.runtime.lastError; });
    } catch (err) {
      // Extension context invalidated after reload — ignore
    }
  });

  // Bridge: extension (background.js) -> page (hook.js)
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      if (request.target === 'hook') {
        window.postMessage({
          source: 'meet-capture-control',
          type: request.type,
          payload: request.payload
        }, '*');
      }
    } catch (err) {
      // Ignore
    }
    try { sendResponse({}); } catch (e) {}
  });

  // Signal to background that content script is ready
  try {
    chrome.runtime.sendMessage({ type: 'content-ready' }, () => { void chrome.runtime.lastError; });
  } catch (err) {}
})();
