(function() {
  'use strict';

  // ── Message bridge: page (hook.js) ↔ extension (background.js) ──────────

  window.addEventListener('message', (e) => {
    try {
      if (e.source !== window) return;
      if (!e.data || e.data.source !== 'meet-capture-hook') return;
      chrome.runtime.sendMessage({
        type: e.data.type,
        payload: e.data.payload
      }, () => { void chrome.runtime.lastError; });
    } catch (err) {}
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      if (request.target === 'hook') {
        window.postMessage({
          source: 'meet-capture-control',
          type: request.type,
          payload: request.payload
        }, '*');
        sendResponse({ ok: true });
        return true;
      }
      if (request.type === 'show-tag-toast') {
        showToast(request.candidate);
        sendResponse({ ok: true });
        return true;
      }
      if (request.type === 'hide-tag-toast') {
        hideToast();
        sendResponse({ ok: true });
        return true;
      }
    } catch (err) {}
    try { sendResponse({}); } catch (e) {}
  });

  try {
    chrome.runtime.sendMessage({ type: 'content-ready' }, () => { void chrome.runtime.lastError; });
  } catch (err) {}

  // ── Tag-join toast ────────────────────────────────────────────────────────

  const AUTO_CONFIRM_S = 12;
  let toastHost = null;
  let autoConfirmTimer = null;
  let countdownInterval = null;

  function esc(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function hideToast() {
    clearTimeout(autoConfirmTimer);
    clearInterval(countdownInterval);
    autoConfirmTimer = null;
    countdownInterval = null;
    if (toastHost) {
      toastHost.remove();
      toastHost = null;
    }
  }

  function showToast(candidate) {
    hideToast();

    toastHost = document.createElement('div');
    const shadow = toastHost.attachShadow({ mode: 'closed' });

    const hasSuggestedName = !!(candidate.suggestedName || '').trim();

    shadow.innerHTML = `
      <style>
        :host-context(body) {}
        .toast {
          position: fixed;
          bottom: 80px;
          right: 24px;
          z-index: 2147483647;
          width: 288px;
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 8px 28px rgba(0,0,0,0.2), 0 2px 6px rgba(0,0,0,0.08);
          padding: 16px;
          font-family: 'Google Sans', Roboto, Arial, sans-serif;
          font-size: 14px;
          color: #202124;
          animation: slide-in 0.22s cubic-bezier(0.4,0,0.2,1);
          box-sizing: border-box;
        }
        @keyframes slide-in {
          from { transform: translateY(16px); opacity: 0; }
          to   { transform: translateY(0);   opacity: 1; }
        }
        .header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
          font-weight: 600;
          font-size: 14px;
        }
        .avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: #e8f0fe;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 16px;
          flex-shrink: 0;
        }
        .subtitle {
          font-size: 12px;
          color: #5f6368;
          font-weight: 400;
          margin-top: 1px;
        }
        input {
          display: block;
          width: 100%;
          box-sizing: border-box;
          padding: 9px 12px;
          border: 1.5px solid #dadce0;
          border-radius: 8px;
          font-size: 14px;
          font-family: inherit;
          color: #202124;
          outline: none;
          margin-bottom: 10px;
          background: #fff;
        }
        input:focus { border-color: #1a73e8; box-shadow: 0 0 0 2px rgba(26,115,232,0.15); }
        input::placeholder { color: #bdc1c6; }
        .actions { display: flex; gap: 8px; }
        .btn-save {
          flex: 1;
          padding: 9px 12px;
          background: #1a73e8;
          color: #fff;
          border: none;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s;
        }
        .btn-save:hover { background: #1557b0; }
        .btn-skip {
          padding: 9px 14px;
          background: #fff;
          color: #5f6368;
          border: 1.5px solid #dadce0;
          border-radius: 8px;
          font-size: 13px;
          cursor: pointer;
          font-family: inherit;
          transition: background 0.15s;
        }
        .btn-skip:hover { background: #f1f3f4; }
        .progress-wrap { margin-top: 10px; }
        .progress-label {
          font-size: 11px;
          color: #9aa0a6;
          margin-bottom: 4px;
        }
        .progress-bar {
          height: 2px;
          background: #e8eaed;
          border-radius: 1px;
          overflow: hidden;
        }
        .progress-fill {
          height: 100%;
          width: 100%;
          background: #1a73e8;
          border-radius: 1px;
          transition: width 1s linear;
        }
      </style>
      <div class="toast">
        <div class="header">
          <div class="avatar">👤</div>
          <div>
            New student joined
            <div class="subtitle">${hasSuggestedName ? 'Name detected — confirm or edit' : 'Enter student name'}</div>
          </div>
        </div>
        <input id="name-input" type="text" value="${esc(candidate.suggestedName || '')}" placeholder="Student name" autocomplete="off">
        <div class="actions">
          <button class="btn-save" id="btn-save">Save</button>
          <button class="btn-skip" id="btn-skip">Skip</button>
        </div>
        ${hasSuggestedName ? `
        <div class="progress-wrap" id="progress-wrap">
          <div class="progress-label">Auto-saving in <span id="countdown">${AUTO_CONFIRM_S}</span>s</div>
          <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
        </div>` : ''}
      </div>
    `;

    document.body.appendChild(toastHost);

    const input = shadow.getElementById('name-input');
    const saveBtn = shadow.getElementById('btn-save');
    const skipBtn = shadow.getElementById('btn-skip');
    const countdownEl = shadow.getElementById('countdown');
    const fillEl = shadow.getElementById('progress-fill');
    const progressWrap = shadow.getElementById('progress-wrap');

    setTimeout(() => { try { input.focus(); if (hasSuggestedName) input.select(); } catch (e) {} }, 80);

    function doSave() {
      const name = (input.value || '').trim();
      if (!name) { input.focus(); return; }
      hideToast();
      try {
        chrome.runtime.sendMessage({ type: 'tag-join-save', name }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {}
    }

    function doSkip() {
      hideToast();
      try {
        chrome.runtime.sendMessage({ type: 'toast-skipped' }, () => {
          void chrome.runtime.lastError;
        });
      } catch (e) {}
    }

    saveBtn.addEventListener('click', doSave);
    skipBtn.addEventListener('click', doSkip);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doSave(); }
      if (e.key === 'Escape') doSkip();
    });

    // Typing cancels the auto-confirm countdown
    input.addEventListener('input', () => {
      clearTimeout(autoConfirmTimer);
      clearInterval(countdownInterval);
      autoConfirmTimer = null;
      countdownInterval = null;
      if (progressWrap) progressWrap.remove();
    });

    if (hasSuggestedName && countdownEl) {
      let remaining = AUTO_CONFIRM_S;
      countdownInterval = setInterval(() => {
        remaining--;
        if (countdownEl) countdownEl.textContent = remaining;
        if (fillEl) fillEl.style.width = `${(remaining / AUTO_CONFIRM_S) * 100}%`;
        if (remaining <= 0) clearInterval(countdownInterval);
      }, 1000);
      autoConfirmTimer = setTimeout(doSave, AUTO_CONFIRM_S * 1000);
    }
  }
})();
