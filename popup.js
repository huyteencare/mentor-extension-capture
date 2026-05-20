(function() {
  'use strict';

  const mentorNameInput = document.getElementById('mentorName');
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
        });
      });
    }
  });

  let activeTabId = null;

  function sendToBackground(msg, cb) {
    chrome.runtime.sendMessage({ ...msg, tabId: activeTabId }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[Popup] sendMessage error:', chrome.runtime.lastError.message);
        return;
      }
      if (cb) cb(resp);
    });
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

  function renderSavedRow(group, isDebug) {
    const streamIds = group.allStreamIds || [group.streamId];
    return `
      <div class="student-item ${isDebug && !group.name ? 'debug-stream' : 'saved-stream'}" data-stream-ids="${escapeHtml(streamIds.join('|'))}">
        <div class="stream-id">${escapeHtml(String(group.streamId || '').substring(0, 6))}</div>
        <input type="text" class="student-name" value="${escapeHtml(group.name || '')}" placeholder="Student name">
        <button class="save-btn manual-save">&#10003;</button>
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
  }

  function renderStudents(response) {
    if (document.activeElement?.classList?.contains('student-name')) return;

    const participants = response.participantNames || [];
    const saved = participants.filter(p => p.name);
    const debug = showAllStreamsCheckbox.checked
      ? participants.filter(p => !p.name)
      : [];
    studentCountSpan.textContent = `(${saved.length})`;

    const html = [
      ...saved.map(group => renderSavedRow(group, false)),
      ...debug.map(group => renderSavedRow(group, true))
    ].join('');

    studentList.innerHTML = html || '<div class="placeholder">Waiting for participants...</div>';
    bindStudentActions(response);
  }

  function updateUI() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return;
      activeTabId = tabs[0].id;

      sendToBackground({ type: 'get-session-state', showAll: showAllStreamsCheckbox.checked }, (response) => {
        if (!response) return;

        if (response.mentorLabel && !mentorNameInput.value) {
          mentorNameInput.value = response.mentorLabel;
        }

        meetingIdDiv.textContent = response.meetingId || '-';
        eventCountDiv.textContent = response.eventCount || 0;
        queueSizeDiv.textContent = response.queueSize || 0;

        const hasEvents = (response.eventCount || 0) > 0;
        const queueEmpty = (response.queueSize || 0) === 0;
        clearSessionBtn.disabled = !(hasEvents && queueEmpty);

        renderStudents(response);
      });
    });
  }

  // Load saved mentor name on startup
  chrome.storage.local.get('mentorLabel', (data) => {
    if (data && data.mentorLabel) {
      mentorNameInput.value = data.mentorLabel;
    }
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

  // Poll for updates; start fast then slow down once meeting ID resolves
  let pollInterval = setInterval(() => {
    updateUI();
    if (meetingIdDiv.textContent !== '-' && meetingIdDiv.textContent !== 'unknown') {
      clearInterval(pollInterval);
      setInterval(updateUI, 2000);
    }
  }, 500);
  updateUI();
})();
