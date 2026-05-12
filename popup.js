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
  const showAllStreamsCheckbox = document.getElementById('showAllStreams');

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

  function getCandidateMessage(candidate) {
    if (!candidate || candidate.status === 'waiting') return 'Admit one student, then wait for audio and video.';
    if (candidate.timedOut && !candidate.ready) return 'Still missing audio or video. Check Meet, or use show all streams.';
    if (candidate.status === 'ready-video-only') return 'Video ready. Meet did not expose a new audio stream for this student.';
    if (candidate.status === 'waiting-audio') return 'Video found. Waiting for audio stream.';
    if (candidate.status === 'waiting-video') return 'Audio found. Waiting for video stream.';
    if (candidate.status === 'settling') return 'Audio and video found. Stabilizing streams...';
    if (candidate.status === 'ready' && candidate.videoCount > 1) return 'Ready. Multiple video streams detected; confirm only one student was admitted.';
    if (candidate.status === 'ready') return 'Ready to name this student.';
    return 'Waiting for student media.';
  }

  function renderTagJoinRow(candidate) {
    const ready = !!candidate?.ready;
    const streamIds = candidate?.streamIds || [];
    const existingInput = document.querySelector('.tag-join-input');
    const preserveValue = existingInput && document.activeElement === existingInput
      ? existingInput.value
      : '';

    const streamSummary = streamIds.length > 0
      ? `${candidate.videoCount || 0} video / ${candidate.audioCount || 0} audio${candidate.videoOnly ? ' · video-only' : ''}`
      : 'No new streams';
    const disabledAttr = ready ? '' : 'disabled';
    const inputValue = ready ? preserveValue : '';

    return `
      <div class="tag-join-item ${ready ? 'ready' : 'waiting'} ${candidate?.videoOnly ? 'video-only' : ''}">
        <div class="tag-join-main">
          <div class="tag-join-title">Next student</div>
          <div class="tag-join-status">${escapeHtml(getCandidateMessage(candidate))}</div>
        </div>
        <div class="tag-join-meta">${escapeHtml(streamSummary)}</div>
        <input type="text" class="student-name tag-join-input" value="${escapeHtml(inputValue)}" placeholder="Student name" ${disabledAttr}>
        <button class="save-btn tag-join-save" ${disabledAttr}>&#10003;</button>
      </div>
    `;
  }

  function renderSavedRow(group, isDebug) {
    const streamIds = group.allStreamIds || [group.streamId];
    const inputAttrs = group.name
      ? `value="${escapeHtml(group.name)}" readonly`
      : 'value="" placeholder="Student name"';
    return `
      <div class="student-item ${isDebug && !group.name ? 'debug-stream' : 'saved-stream'}" data-stream-ids="${escapeHtml(streamIds.join('|'))}">
        <div class="stream-id">${escapeHtml(String(group.streamId || '').substring(0, 6))}</div>
        <input type="text" class="student-name" ${inputAttrs}>
        ${group.name ? '<span class="saved-label">saved</span>' : '<button class="save-btn manual-save">&#10003;</button>'}
      </div>
    `;
  }

  function bindStudentActions(response) {
    const tagInput = studentList.querySelector('.tag-join-input');
    const tagButton = studentList.querySelector('.tag-join-save');
    const saveTagJoin = () => {
      if (!tagInput || tagInput.disabled) return;
      const name = tagInput.value.trim();
      if (!name) return;
      sendToBackground({ type: 'tag-join-save', name }, (resp) => {
        if (resp?.ok) {
          tagInput.classList.add('saved');
          tagInput.blur();
          setTimeout(updateUI, 300);
        } else {
          tagInput.classList.add('error');
          setTimeout(() => tagInput.classList.remove('error'), 1200);
        }
      });
    };
    if (tagButton) tagButton.addEventListener('click', saveTagJoin);
    if (tagInput) tagInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') saveTagJoin();
    });

    studentList.querySelectorAll('.manual-save').forEach((button) => {
      button.addEventListener('click', () => {
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
      });
    });
  }

  function renderStudents(response) {
    if (document.activeElement?.classList?.contains('student-name')) return;

    const participants = response.participantNames || [];
    const candidateIds = new Set(response.tagJoin?.streamIds || []);
    const saved = participants.filter(p => p.name);
    const debug = showAllStreamsCheckbox.checked
      ? participants.filter(p => !p.name && !candidateIds.has(p.streamId))
      : [];
    const activeCount = response.tagJoin?.streamIds?.length ? 1 : 0;
    studentCountSpan.textContent = `(${saved.length + activeCount})`;

    const html = [
      renderTagJoinRow(response.tagJoin),
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
