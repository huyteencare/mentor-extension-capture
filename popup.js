(function() {
  'use strict';

  const mentorNameInput = document.getElementById('mentorName');
  const mentorCheckinBtn = document.getElementById('mentorCheckinBtn');
  const meetingIdDiv = document.getElementById('meetingId');
  const studentCountSpan = document.getElementById('studentCount');
  const studentList = document.getElementById('studentList');
  const eventCountDiv = document.getElementById('eventCount');
  const queueSizeDiv = document.getElementById('queueSize');
  const viewerBtn = document.getElementById('viewerBtn');
  const forceUploadBtn = document.getElementById('forceUploadBtn');
  const clearSessionBtn = document.getElementById('clearSessionBtn');
  const showAllStreamsCheckbox = document.getElementById('showAllStreams');
  const appTitle = document.getElementById('appTitle');

  // Restore dev mode state on open
  chrome.storage.local.get('devMode', (data) => {
    if (data && data.devMode) document.body.classList.add('dev-mode');
  });

  // Secret: tap the title 5 times within 3s to toggle dev mode
  let devTapCount = 0;
  let devTapTimer = null;
  appTitle.addEventListener('click', () => {
    devTapCount++;
    clearTimeout(devTapTimer);
    devTapTimer = setTimeout(() => { devTapCount = 0; }, 3000);
    if (devTapCount >= 5) {
      devTapCount = 0;
      chrome.storage.local.get('devMode', (data) => {
        const next = !data.devMode;
        chrome.storage.local.set({ devMode: next }, () => {
          document.body.classList.toggle('dev-mode', next);
          updateUI();
        });
      });
    }
  });

  let activeTabId = null;
  const backendProbeCache = new Map();
  let emailMappings = {}; // signedinUserUser → { studentEmail, displayName, signedinUserUser, linkedAt }

  function sendToBackground(msg, cb) {
    chrome.runtime.sendMessage({ ...msg, tabId: activeTabId }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[Popup] sendMessage error:', chrome.runtime.lastError.message);
        return;
      }
      if (cb) cb(resp);
    });
  }

  async function saveEmailMapping(signedinUserUser, studentEmail, displayName, role = 'student') {
    emailMappings[signedinUserUser] = { studentEmail, displayName, signedinUserUser, role, linkedAt: new Date().toISOString() };
    const linkedBy = mentorNameInput.value.trim() || undefined;
    try {
      const resp = await fetch(`${API_BASE_URL}/api/link-student`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleHandle: signedinUserUser, studentEmail, displayName, role, linkedBy })
      });
      const result = await resp.json().catch(() => ({}));
      if (!result.ok) {
        console.error('[saveEmailMapping] failed:', result);
        showToast('Failed to save email mapping');
      }
    } catch (err) {
      console.error('[saveEmailMapping] fetch error:', err);
      showToast('Failed to save email mapping');
    }
  }

  // In-memory: handles already attempted this session — prevents 2s retry spam
  const checkinAttempted = new Set();
  const handlesFetched = new Set();
  // Persisted across popup open/close: "handle:meetCode" → prevents duplicate API calls
  let checkedInKeys = new Set();

  async function fetchHandleMapping(googleHandle) {
    if (handlesFetched.has(googleHandle)) return;
    handlesFetched.add(googleHandle);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/student-by-handle/${encodeURIComponent(googleHandle)}`);
      const data = await resp.json().catch(() => ({}));
      if (data.found) {
        emailMappings[googleHandle] = {
          ...emailMappings[googleHandle],
          studentEmail: data.studentEmail,
          displayName: data.displayName,
          role: data.role || 'student',
        };
      }
    } catch {}
  }

  async function tryAutoCheckin(googleHandle, meetCode) {
    if (!googleHandle || !meetCode) return;
    const key = `${googleHandle}:${meetCode}`;
    if (checkedInKeys.has(key)) return;
    if (checkinAttempted.has(googleHandle)) return;
    checkinAttempted.add(googleHandle);

    const body = { googleHandle, meetCode, joinTime: new Date().toISOString() };
    const resp = await fetch(`${API_BASE_URL}/api/auto-checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).catch(() => null);

    const result = await resp?.json().catch(() => ({ ok: false })) ?? { ok: false };

    if (result.ok) {
      checkedInKeys.add(key);
      chrome.storage.local.set({ checkedInKeys: [...checkedInKeys] });
      emailMappings[googleHandle] = { ...emailMappings[googleHandle], checkinStatus: 'checked_in' };
      setTimeout(updateUI, 50);
    } else if (result.status === 'failed' || result.status === 'handle_not_linked') {
      checkinAttempted.delete(googleHandle);
    }
    // session_not_found: stays in attempted — no retry until popup reopens
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function isDevMode() {
    return document.body.classList.contains('dev-mode');
  }

  function showToast(message, type = 'error') {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed; bottom: 12px; left: 12px; right: 12px;
      padding: 8px 12px; border-radius: 4px; font-size: 12px;
      background: ${type === 'error' ? '#ea4335' : '#34a853'}; color: #fff;
      z-index: 9999; text-align: center;
      animation: fadeIn 0.15s ease;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  async function fetchBackendProbeResults(sessionId) {
    if (!isDevMode() || !sessionId) return [];
    try {
      const response = await fetch(`${API_BASE_URL}/api/sessions/${encodeURIComponent(sessionId)}`);
      if (response.status === 404) {
        return backendProbeCache.get(sessionId) || [];
      }
      if (!response.ok) throw new Error(`Session ${response.status}`);
      const data = await response.json();
      const results = Array.isArray(data?.session?.identityProbeResults) ? data.session.identityProbeResults : [];
      const previous = backendProbeCache.get(sessionId) || [];
      const nextSerialized = JSON.stringify(results);
      const prevSerialized = JSON.stringify(previous);
      backendProbeCache.set(sessionId, results);
      if (nextSerialized !== prevSerialized) {
        sendToBackground({ type: 'sync-probe-results', results }, () => {});
      }
      return results;
    } catch (error) {
      console.warn('[Popup] Failed to fetch probe results:', error.message);
      return backendProbeCache.get(sessionId) || [];
    }
  }

  function mergeProbeDebug(group, backendProbeResults) {
    const local = group?.probeDebug || null;
    if (!local) return null;
    const backendByCandidateId = new Map(
      (backendProbeResults || [])
        .map((entry) => [String(entry?.candidateId || ''), entry])
        .filter(([candidateId]) => !!candidateId)
    );
    const backend = local.candidateId ? backendByCandidateId.get(local.candidateId) : null;
    if (!backend) return local;
    return {
      ...local,
      ...backend,
      probeStatus: backend.probeStatus || backend.finalVerdict || local.probeStatus,
      participantType: backend.participantType || local.participantType,
      signedinUserUser: backend.signedinUserUser || local.signedinUserUser,
      canonicalIdentityType: backend.canonicalIdentityType || local.canonicalIdentityType,
      canonicalIdentityValue: backend.canonicalIdentityValue || local.canonicalIdentityValue,
      finalVerdict: backend.finalVerdict || local.finalVerdict,
      lastProbedAt: backend.lastProbedAt || local.lastProbedAt
    };
  }

  function renderProbeDebug(debug) {
    if (!debug) return '';
    const candidateId = debug.candidateId || '-';
    const probeStatus = debug.probeStatus || 'unknown';
    const participantType = debug.participantType || '-';
    const signedinUserUser = debug.signedinUserUser || '-';
    const provisionalParticipantKey = debug.provisionalParticipantKey || '-';
    const lastProbedAt = debug.lastProbedAt ? new Date(debug.lastProbedAt).toLocaleTimeString() : '-';
    return `
      <div class="probe-debug dev-only">
        <div class="probe-debug-row"><span class="probe-debug-label">candidate</span><span class="probe-debug-value">${escapeHtml(candidateId)}</span></div>
        <div class="probe-debug-row"><span class="probe-debug-label">prov key</span><span class="probe-debug-value">${escapeHtml(provisionalParticipantKey)}</span></div>
        <div class="probe-debug-row"><span class="probe-debug-label">probe</span><span class="probe-debug-value">${escapeHtml(probeStatus)}</span></div>
        <div class="probe-debug-row"><span class="probe-debug-label">type</span><span class="probe-debug-value">${escapeHtml(participantType)}</span></div>
        <div class="probe-debug-row"><span class="probe-debug-label">signin id</span><span class="probe-debug-value">${escapeHtml(signedinUserUser)}</span></div>
        <div class="probe-debug-row"><span class="probe-debug-label">last</span><span class="probe-debug-value">${escapeHtml(lastProbedAt)}</span></div>
      </div>
    `;
  }

  function renderEmailRow(mergedProbeDebug, isDebug) {
    if (isDebug) return '';
    const signedinUserUser = mergedProbeDebug?.signedinUserUser;
    if (!signedinUserUser || signedinUserUser === '-') return '';
    const existing = emailMappings[signedinUserUser];
    const currentEmail = existing?.studentEmail || '';
    const isLinked = !!currentEmail;
    const checkinStatus = emailMappings[signedinUserUser]?.checkinStatus || 'idle';
    const role = mergedProbeDebug?.participantType === 'mentor' ? 'mentor' : 'student';
    return `
      <div class="email-row${isLinked ? ' linked' : ''}" data-signin-user="${escapeHtml(signedinUserUser)}" data-role="${escapeHtml(role)}">
        <input type="email" class="email-input" placeholder="student@email.com" value="${escapeHtml(currentEmail)}">
        <button class="email-link-btn${isLinked ? ' is-linked' : ''}" ${!currentEmail ? 'disabled' : ''}>
          ${isLinked ? '&#10003;' : 'Link'}
        </button>
        ${isLinked ? `<button class="checkin-btn${checkinStatus === 'checked_in' ? ' is-checked-in' : checkinStatus === 'failed' ? ' is-failed' : ''}" data-signin-user="${escapeHtml(signedinUserUser)}">${checkinStatus === 'checked_in' ? '&#10003; In' : 'Check In'}</button>` : ''}
      </div>
    `;
  }

  function renderSavedRow(group, isDebug, backendProbeResults) {
    const streamIds = group.allStreamIds || [group.streamId];
    const mergedProbeDebug = mergeProbeDebug(group, backendProbeResults);
    return `
      <div class="student-item ${isDebug && !group.name ? 'debug-stream' : 'saved-stream'}" data-stream-ids="${escapeHtml(streamIds.join('|'))}">
        <div class="stream-id">${escapeHtml(String(group.streamId || '').substring(0, 6))}</div>
        <input type="text" class="student-name" value="${escapeHtml(group.name || '')}" placeholder="Student name">
        <button class="save-btn manual-save">&#10003;</button>
        ${renderEmailRow(mergedProbeDebug, isDebug)}
        ${renderProbeDebug(mergedProbeDebug)}
      </div>
    `;
  }

  function bindStudentActions(response) {
    studentList.querySelectorAll('.manual-save').forEach((button) => {
      const saveManual = () => {
        const row = button.closest('.student-item');
        const input = row?.querySelector('.student-name');
        const streamIds = row?.dataset.streamIds?.split('|').filter(Boolean) || [];
        const name = input?.value.trim();
        if (!name || streamIds.length === 0) return;
        sendToBackground({
          type: 'set-participant-name',
          streamId: streamIds[0],
          streamIds,
          name
        }, () => {
          input.classList.add('saved');
          input.blur();
          setTimeout(updateUI, 300);
        });
      };
      button.addEventListener('click', saveManual);
      const input = button.closest('.student-item')?.querySelector('.student-name');
      if (input) {
        input.addEventListener('keypress', (e) => {
          if (e.key === 'Enter') saveManual();
        });
      }
    });

    studentList.querySelectorAll('.email-row').forEach((emailRow) => {
      const signedinUserUser = emailRow.dataset.signinUser;
      if (!signedinUserUser) return;
      const input = emailRow.querySelector('.email-input');
      const btn = emailRow.querySelector('.email-link-btn');

      input.addEventListener('input', () => {
        btn.disabled = !input.value.trim();
        btn.classList.remove('is-linked');
        btn.innerHTML = 'Link';
        emailRow.classList.remove('linked');
      });

      btn.addEventListener('click', async () => {
        const email = input.value.trim();
        if (!email) return;
        const displayName = emailRow.closest('.student-item')?.querySelector('.student-name')?.value || '';
        const role = emailRow.dataset.role || 'student';
        btn.disabled = true;
        await saveEmailMapping(signedinUserUser, email, displayName, role);
        btn.classList.add('is-linked');
        btn.innerHTML = '&#10003;';
        btn.disabled = false;
        emailRow.classList.add('linked');
        input.classList.add('saved');
        setTimeout(() => input.classList.remove('saved'), 1500);
        checkinAttempted.delete(signedinUserUser);
        tryAutoCheckin(signedinUserUser, response?.meetingId || '');
      });
    });

    const meetCode = response?.meetingId || '';
    studentList.querySelectorAll('.checkin-btn').forEach((checkinBtn) => {
      const suHandle = checkinBtn.dataset.signinUser;
      checkinBtn.addEventListener('click', async () => {
        checkinBtn.disabled = true;
        checkinBtn.textContent = '...';
        await tryAutoCheckin(suHandle, meetCode);
        // tryAutoCheckin updates emailMappings + triggers updateUI
      });
    });
  }

  function renderStudents(response, backendProbeResults) {
    const active = document.activeElement;
    if (active?.classList?.contains('student-name') || active?.classList?.contains('email-input')) return;

    const participants = response.participantNames || [];
    const saved = participants.filter(p => p.name);
    const debug = showAllStreamsCheckbox.checked
      ? participants.filter(p => !p.name)
      : [];
    studentCountSpan.textContent = `(${saved.length})`;

    const html = [
      ...saved.map(group => renderSavedRow(group, false, backendProbeResults)),
      ...debug.map(group => renderSavedRow(group, true, backendProbeResults))
    ].join('');

    studentList.innerHTML = html || '<div class="placeholder">Waiting for participants...</div>';
    bindStudentActions(response);

    participants.forEach((group) => {
      const signedinUserUser = group?.probeDebug?.signedinUserUser;
      if (!signedinUserUser || signedinUserUser === '-') return;
      fetchHandleMapping(signedinUserUser); // populate email from DB (fire-and-forget, next render cycle picks it up)
      tryAutoCheckin(signedinUserUser, response?.meetingId || '');
    });
  }

  function updateUI() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      activeTabId = tabs[0].id;

      sendToBackground({ type: 'get-session-state', showAll: showAllStreamsCheckbox.checked }, async (response) => {
        if (!response) return;

        if (response.mentorLabel && !mentorNameInput.value) {
          mentorNameInput.value = response.mentorLabel;
          mentorCheckinBtn.disabled = false;
        }

        const meetCode = response.meetingId || '-';
        meetingIdDiv.textContent = meetCode;
        eventCountDiv.textContent = response.eventCount || 0;
        queueSizeDiv.textContent = response.queueSize || 0;

        const hasEvents = (response.eventCount || 0) > 0;
        const queueEmpty = (response.queueSize || 0) === 0;
        clearSessionBtn.disabled = !(hasEvents && queueEmpty);

        tryMentorAutoCheckin(mentorNameInput.value.trim(), meetCode);

        const backendProbeResults = await fetchBackendProbeResults(response.sessionId);
        renderStudents(response, backendProbeResults);
      });
    });
  }

  // Load persisted state then start polling — ensures checkedInKeys is ready before first updateUI
  chrome.storage.local.get(['mentorLabel', 'checkedInKeys'], (data) => {
    if (data?.mentorLabel) { mentorNameInput.value = data.mentorLabel; mentorCheckinBtn.disabled = false; }
    if (data?.checkedInKeys) checkedInKeys = new Set(data.checkedInKeys);
    startPolling();
  });

  function saveMentorName() {
    const label = mentorNameInput.value.trim();
    if (!label) return;
    sendToBackground({ type: 'set-mentor-label', label }, () => {
      mentorNameInput.classList.add('saved');
      setTimeout(() => mentorNameInput.classList.remove('saved'), 1500);
    });
  }

  mentorNameInput.addEventListener('blur', saveMentorName);
  mentorNameInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveMentorName(); }
  });

  let mentorCheckinAttempted = false;

  async function tryMentorAutoCheckin(email, meetCode) {
    if (!email || !meetCode || meetCode === '-') return;
    const key = `mentor:${email}:${meetCode}`;
    if (checkedInKeys.has(key)) {
      mentorCheckinBtn.textContent = '✓ In';
      mentorCheckinBtn.classList.add('is-checked-in');
      return;
    }
    if (mentorCheckinAttempted) return;
    mentorCheckinAttempted = true;

    mentorCheckinBtn.disabled = true;
    mentorCheckinBtn.textContent = '...';

    const resp = await fetch(`${API_BASE_URL}/api/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetCode, participantEmail: email, participantType: 'mentor', joinTime: new Date().toISOString() })
    }).catch(() => null);

    const result = await resp?.json().catch(() => ({ ok: false })) ?? { ok: false };
    if (result.ok) {
      checkedInKeys.add(key);
      chrome.storage.local.set({ checkedInKeys: [...checkedInKeys] });
      mentorCheckinBtn.textContent = '✓ In';
      mentorCheckinBtn.classList.add('is-checked-in');
    } else {
      mentorCheckinBtn.textContent = 'Check In';
      mentorCheckinBtn.disabled = false;
      mentorCheckinAttempted = false;
    }
  }

  mentorNameInput.addEventListener('input', () => {
    const hasEmail = !!mentorNameInput.value.trim();
    mentorCheckinBtn.disabled = !hasEmail;
    mentorCheckinAttempted = false; // reset so new email can checkin
  });

  mentorCheckinBtn.addEventListener('click', () => {
    mentorCheckinAttempted = false; // allow manual retry
    tryMentorAutoCheckin(mentorNameInput.value.trim(), meetingIdDiv.textContent?.trim());
  });

  showAllStreamsCheckbox.addEventListener('change', () => {
    updateUI();
  });

  viewerBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
  });

  forceUploadBtn.addEventListener('click', () => {
    sendToBackground({ type: 'force-upload' }, () => {
      forceUploadBtn.textContent = 'Uploading...';
      setTimeout(() => { forceUploadBtn.textContent = 'Upload Now'; updateUI(); }, 1500);
    });
  });

  clearSessionBtn.addEventListener('click', () => {
    sendToBackground({ type: 'clear-session' }, (resp) => {
      if (resp?.ok) {
        clearSessionBtn.textContent = 'Cleared';
        setTimeout(() => { clearSessionBtn.textContent = 'Clear'; updateUI(); }, 800);
      }
    });
  });

  function startPolling() {
    updateUI();
    let pollInterval = setInterval(() => {
      updateUI();
      if (meetingIdDiv.textContent !== '-' && meetingIdDiv.textContent !== 'unknown') {
        clearInterval(pollInterval);
        setInterval(updateUI, 2000);
      }
    }, 500);
  }
})();
