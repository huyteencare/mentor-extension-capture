(function() {
  'use strict';

  const serverUrlInput = document.getElementById('serverUrl');
  serverUrlInput.value = (typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://localhost:8787').replace(/\/$/, '');

  const getApiBase = () => serverUrlInput.value.trim().replace(/\/$/, '') || 'http://localhost:8787';

  serverUrlInput.addEventListener('change', () => loadSessions());

  const sessionList = document.getElementById('sessionList');
  const sessionDetail = document.getElementById('sessionDetail');
  const welcome = document.getElementById('welcome');
  const sessionTitle = document.getElementById('sessionTitle');
  const sessionInfo = document.getElementById('sessionInfo');
  const participantsDiv = document.getElementById('participants');

  let currentSession = null;
  let activeObjectUrls = [];
  let activeSources = [];
  let loadGeneration = 0;

  const cleanupPlayers = () => {
    loadGeneration++;
    document.querySelectorAll('video, audio').forEach((el) => {
      el.pause();
      el.removeAttribute('src');
      el.load();
    });
    activeSources.forEach((ms) => {
      if (ms.readyState === 'open') try { ms.endOfStream(); } catch {}
    });
    activeSources = [];
    activeObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    activeObjectUrls = [];
  };

  async function loadSessions() {
    try {
      const response = await fetch(`${getApiBase()}/api/sessions`);
      if (!response.ok) throw new Error('Failed to load sessions');

      const data = await response.json();
      const sessions = data.sessions || [];

      if (sessions.length === 0) {
        sessionList.innerHTML = '<div class="no-sessions">No sessions yet</div>';
        return;
      }

      sessionList.innerHTML = sessions.map((session) => {
        const isV2 = session.sessionId.startsWith('session-');
        return `
          <div class="session-item${isV2 ? '' : ' legacy'}" data-session-id="${escapeHtml(session.sessionId)}">
            <div class="session-name">${escapeHtml(session.meetingId)}${isV2 ? '' : ' <span class="legacy-tag">v1</span>'}</div>
            <div class="session-meta">${escapeHtml(session.mentorLabel || 'No mentor label')} &bull; ${session.eventCount} events</div>
            <div class="session-time">${new Date(session.updatedAt).toLocaleDateString()}</div>
          </div>
        `;
      }).join('');

      sessionList.querySelectorAll('.session-item').forEach((el) => {
        el.addEventListener('click', () => loadSessionDetail(el.dataset.sessionId));
      });
    } catch (error) {
      console.error('Error loading sessions:', error);
      sessionList.innerHTML = '<div class="error">Failed to load sessions</div>';
    }
  }

  async function loadSessionDetail(sessionId) {
    cleanupPlayers();
    try {
      const response = await fetch(`${getApiBase()}/api/sessions/${sessionId}`);
      if (!response.ok) throw new Error('Session not found');

      const data = await response.json();
      const session = data.session || data;
      currentSession = session;

      sessionTitle.textContent = session.meetingId;
      sessionInfo.textContent = `${session.mentorLabel || 'Mentor'} • ${new Date(session.updatedAt).toLocaleString()}`;

      const allEvents = session.events || [];
      const isLegacy = allEvents.some((event) =>
        ['remote-media-recording', 'remote-audio-recording', 'pc-hook-installed'].includes(event.type)
      );

      if (isLegacy) {
        participantsDiv.innerHTML = '<div class="no-data">Legacy session (v1 extension) — not playable in this viewer.<br>Only sessions captured with v2 of the extension can be played back.</div>';
        welcome.style.display = 'none';
        sessionDetail.style.display = 'block';
        return;
      }

      const chunkEvents = allEvents.filter((event) => event.type === 'chunk');
      const hasMediaRoles = chunkEvents.some((event) => {
        const meta = getEventMeta(event);
        return !!meta.mediaRole;
      });

      const generation = loadGeneration;
      const markup = hasMediaRoles
        ? renderRoleAwareSession(session, allEvents, generation)
        : renderLegacySession(allEvents, generation);

      participantsDiv.innerHTML = markup.html;
      markup.bind();

      welcome.style.display = 'none';
      sessionDetail.style.display = 'block';
    } catch (error) {
      console.error('Error loading session:', error);
      participantsDiv.innerHTML = `<div class="error">Failed to load session: ${escapeHtml(error.message)}</div>`;
    }
  }

  function renderRoleAwareSession(session, allEvents, generation) {
    const nameByStreamId = buildNameByStreamId(session, allEvents);
    const sharedAudio = [];
    const mentorAudio = [];
    const participantGroups = {};

    allEvents.forEach((event) => {
      if (event.type !== 'chunk') return;
      const meta = getEventMeta(event);
      const streamId = meta.streamId;
      if (!streamId) return;

      const chunk = { ...event, _meta: meta };
      const mediaRole = meta.mediaRole || inferLegacyRole(meta, nameByStreamId);

      if (mediaRole === 'mentor-audio') {
        mentorAudio.push(chunk);
        return;
      }

      if (mediaRole === 'shared-audio') {
        sharedAudio.push(chunk);
        return;
      }

      const groupKey = meta.ownerId || nameByStreamId[streamId] || normalizeParticipantName(meta.participantId, streamId);
      const displayName = nameByStreamId[streamId] || normalizeParticipantName(meta.participantId, streamId);
      if (!participantGroups[groupKey]) {
        participantGroups[groupKey] = { displayName, video: [] };
      } else if (displayName !== groupKey && participantGroups[groupKey].displayName === groupKey) {
        // Upgrade display name from ownerId to human name once we see it
        participantGroups[groupKey].displayName = displayName;
      }
      participantGroups[groupKey].video.push(chunk);
    });

    const sections = [];
    const bindings = [];
    const studentSummaries = (session.captureSummary?.studentVideoParticipants || [])
      .filter((s) => s.videoChunkCount > 0 || !/^[a-f0-9-]{8,}$/.test(s.participantName));

    if (studentSummaries.length > 0) {
      sections.push(`
        <div class="participant session-summary-card">
          <h3>Capture Stability</h3>
          <div class="summary-grid">
            ${studentSummaries.map((student) => `
              <div class="summary-item">
                <div class="summary-name">${escapeHtml(student.participantName)}</div>
                <div class="summary-meta">Joined ${escapeHtml(formatTimestamp(student.joinObservedAt))}</div>
                <div class="summary-meta">Last seen ${escapeHtml(formatTimestamp(student.leaveObservedAt))}</div>
                <div class="summary-meta">Actual video ${escapeHtml(student.actualVideoDurationLabel || '0:00')}</div>
                <div class="summary-meta">${escapeHtml(String(student.videoChunkCount || 0))} chunks · ${escapeHtml(String((student.streamIds || []).length))} streams</div>
              </div>
            `).join('')}
          </div>
        </div>
      `);
    }

    const sharedChunks = selectPrimaryAudioStream(sharedAudio);
    const mentorChunks = selectPrimaryAudioStream(mentorAudio);
    if (sharedChunks.length > 0 || mentorChunks.length > 0) {
      sections.push(`
        <div class="participant session-audio-card">
          <h3>Session Audio</h3>
          ${sharedChunks.length > 0 ? `
            <div class="player-section">
              <label>Shared Student Audio (${sharedChunks.length} chunks)</label>
              <audio controls style="width: 100%;" data-session-media="shared-audio"></audio>
            </div>
          ` : ''}
          ${mentorChunks.length > 0 ? `
            <div class="player-section">
              <label>Mentor Audio (${mentorChunks.length} chunks)</label>
              <audio controls style="width: 100%;" data-session-media="mentor-audio"></audio>
            </div>
          ` : ''}
        </div>
      `);

      if (sharedChunks.length > 0) {
        bindings.push(() => {
          const el = document.querySelector('[data-session-media="shared-audio"]');
          if (el) setupAudioPlayer(el, sharedChunks, generation);
        });
      }

      if (mentorChunks.length > 0) {
        bindings.push(() => {
          const el = document.querySelector('[data-session-media="mentor-audio"]');
          if (el) setupAudioPlayer(el, mentorChunks, generation);
        });
      }
    }

    const participantMarkup = Object.entries(participantGroups)
      .sort(([, left], [, right]) => {
        const leftStart = Math.min(...left.video.map((chunk) => chunk.at));
        const rightStart = Math.min(...right.video.map((chunk) => chunk.at));
        return leftStart - rightStart;
      })
      .map(([key, chunks]) => {
        const PREVIEW_LIMIT_MS = 2 * 60 * 1000; // show first 2 min as preview
        const videoChunks = chunks.video.sort(sortChunks);
        const playerId = `video-${sanitizeDomId(key)}`;
        const totalDurationMs = videoChunks.reduce((s, c) => s + (c._meta?.durationMs || 0), 0);
        const totalMin = Math.round(totalDurationMs / 60000);

        // Slice to first PREVIEW_LIMIT_MS worth of chunks
        const previewChunks = [];
        let previewMs = 0;
        for (const chunk of videoChunks) {
          previewChunks.push(chunk);
          previewMs += chunk._meta?.durationMs || 0;
          if (previewMs >= PREVIEW_LIMIT_MS) break;
        }
        const isTruncated = previewChunks.length < videoChunks.length;
        const previewMin = Math.round(previewMs / 60000);

        bindings.push(() => {
          const video = document.querySelector(`[data-player-id="${playerId}"]`);
          if (video) setupVideoPlayer(video, previewChunks, generation);
        });

        return `
          <div class="participant">
            <h3>${escapeHtml(chunks.displayName || key)}</h3>
            <div class="player-section">
              <label>Video · ${videoChunks.length} chunks · ~${totalMin} min total
                ${isTruncated ? `<span class="preview-badge">preview: first ~${previewMin} min</span>` : ''}
              </label>
              <video controls width="400" data-player-id="${playerId}"></video>
            </div>
          </div>
        `;
      });

    if (participantMarkup.length === 0 && sections.length === 0) {
      sections.push('<div class="no-data">No media captured yet</div>');
    }

    return {
      html: [...sections, ...participantMarkup].join(''),
      bind() {
        bindings.forEach((fn) => fn());
      }
    };
  }

  function renderLegacySession(allEvents, generation) {
    const nameByStreamId = buildNameByStreamId(currentSession, allEvents);
    const streamGroups = {};

    allEvents.forEach((event) => {
      if (event.type !== 'chunk') return;
      const meta = getEventMeta(event);
      const streamId = meta.streamId;
      if (!streamId) return;

      if (!streamGroups[streamId]) {
        streamGroups[streamId] = { streamId, displayName: streamId, audio: [], video: [] };
      }
      if (nameByStreamId[streamId]) {
        streamGroups[streamId].displayName = nameByStreamId[streamId];
      } else if (meta.participantId && meta.participantId !== streamId) {
        streamGroups[streamId].displayName = meta.participantId;
      }
      const enriched = { ...event, _meta: meta };
      if (meta.kind === 'audio') {
        streamGroups[streamId].audio.push(enriched);
      } else if (meta.kind === 'video') {
        streamGroups[streamId].video.push(enriched);
      }
    });

    const participantGroups = {};
    Object.values(streamGroups).forEach(({ displayName, audio, video }) => {
      if (!participantGroups[displayName]) {
        participantGroups[displayName] = { audio: [], video: [], sharedAudio: false };
      }
      participantGroups[displayName].audio.push(...audio);
      participantGroups[displayName].video.push(...video);
    });

    const unnamedAudioKeys = Object.keys(participantGroups).filter((name) => {
      const sg = streamGroups[name];
      return sg && sg.displayName === sg.streamId && sg.video.length === 0;
    });

    if (unnamedAudioKeys.length > 0) {
      const videoOnlyParticipants = Object.entries(participantGroups)
        .filter(([name, group]) => !unnamedAudioKeys.includes(name) && group.video.length > 0 && group.audio.length === 0)
        .sort(([, left], [, right]) => Math.min(...left.video.map((chunk) => chunk.at)) - Math.min(...right.video.map((chunk) => chunk.at)));

      const assigned = new Set();
      for (const [, targetGroup] of videoOnlyParticipants) {
        const videoStart = Math.min(...targetGroup.video.map((chunk) => chunk.at));
        let bestKey = null;
        let bestDiff = Infinity;

        for (const key of unnamedAudioKeys) {
          if (assigned.has(key)) continue;
          const audioStart = Math.min(...participantGroups[key].audio.map((chunk) => chunk.at));
          const diff = Math.abs(audioStart - videoStart);
          if (diff < bestDiff) {
            bestDiff = diff;
            bestKey = key;
          }
        }

        if (bestKey !== null && bestDiff < 30000) {
          const bestAudioStart = Math.min(...participantGroups[bestKey].audio.map((chunk) => chunk.at));
          targetGroup.audio.push(...participantGroups[bestKey].audio);
          assigned.add(bestKey);
          for (const key of unnamedAudioKeys) {
            if (assigned.has(key)) continue;
            const audioStart = Math.min(...participantGroups[key].audio.map((chunk) => chunk.at));
            if (Math.abs(audioStart - bestAudioStart) < 5000) assigned.add(key);
          }
        }
      }

      for (const key of unnamedAudioKeys) delete participantGroups[key];
    }

    const sharedAudioSource = Object.values(participantGroups)
      .filter((group) => group.audio.length > 0)
      .sort((left, right) => right.audio.length - left.audio.length)[0];

    if (sharedAudioSource) {
      const sharedAudioChunks = selectPrimaryAudioStream(sharedAudioSource.audio);
      Object.values(participantGroups).forEach((group) => {
        if (group.video.length > 0 && group.audio.length === 0 && sharedAudioChunks.length > 0) {
          group.audio = sharedAudioChunks;
          group.sharedAudio = true;
        }
      });
    }

    const bindings = [];
    const html = Object.entries(participantGroups).map(([name, chunks]) => {
      const videoChunks = chunks.video.sort(sortChunks);
      const audioChunks = selectPrimaryAudioStream(chunks.audio);
      const videoPlayerId = `video-${sanitizeDomId(name)}`;
      const audioPlayerId = `audio-${sanitizeDomId(name)}`;

      if (videoChunks.length > 0) {
        bindings.push(() => {
          const video = document.querySelector(`[data-player-id="${videoPlayerId}"]`);
          if (video) setupVideoPlayer(video, videoChunks, generation);
        });
      }

      if (audioChunks.length > 0) {
        bindings.push(() => {
          const audio = document.querySelector(`[data-player-id="${audioPlayerId}"]`);
          if (audio) setupAudioPlayer(audio, audioChunks, generation);
        });
      }

      return `
        <div class="participant">
          <h3>${escapeHtml(name === '__local__' ? 'Mentor (You)' : name)}</h3>
          ${videoChunks.length > 0 ? `
            <div class="player-section">
              <label>Video (${videoChunks.length} chunks)</label>
              <video controls width="400" data-player-id="${videoPlayerId}"></video>
            </div>
          ` : ''}
          ${audioChunks.length > 0 ? `
            <div class="player-section">
              <label>${chunks.sharedAudio ? 'Shared Audio' : 'Audio'} (${audioChunks.length} chunks)</label>
              <audio controls style="width: 100%;" data-player-id="${audioPlayerId}"></audio>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    return {
      html: html || '<div class="no-data">No media captured yet</div>',
      bind() {
        bindings.forEach((fn) => fn());
      }
    };
  }

  function buildNameByStreamId(session, allEvents) {
    const nameByStreamId = {};
    (session.capturedParticipants || []).forEach((participant) => {
      if (participant.participantKey && participant.participantName) {
        nameByStreamId[participant.participantKey] = participant.participantName;
      }
    });
    allEvents.forEach((event) => {
      if (event.type !== 'participant-renamed') return;
      const meta = getEventMeta(event);
      if (meta.streamId && meta.name) {
        nameByStreamId[meta.streamId] = meta.name;
      }
    });
    return nameByStreamId;
  }

  function getEventMeta(event) {
    return event.metadata || event.payload || {};
  }

  function inferLegacyRole(meta, nameByStreamId) {
    if (meta.kind === 'video') return 'student-video';
    if (meta.participantId === '__mentor__') return 'mentor-audio';
    if (meta.streamId && nameByStreamId[meta.streamId]) return 'shared-audio';
    return 'shared-audio';
  }

  function normalizeParticipantName(participantId, streamId) {
    if (!participantId || participantId === streamId || participantId === '__shared_audio__') return streamId;
    if (participantId === '__mentor__') return 'Mentor Audio';
    return participantId;
  }

  function sortChunks(left, right) {
    const leftIndex = Number.isFinite(left._meta?.index) ? left._meta.index : left.at;
    const rightIndex = Number.isFinite(right._meta?.index) ? right._meta.index : right.at;
    return leftIndex - rightIndex;
  }

  function selectPrimaryAudioStream(chunks) {
    const byStream = {};
    chunks.forEach((chunk) => {
      const streamId = chunk._meta?.streamId;
      if (!streamId) return;
      if (!byStream[streamId]) byStream[streamId] = [];
      byStream[streamId].push(chunk);
    });

    const streams = Object.values(byStream).map((streamChunks) => streamChunks.sort(sortChunks));
    if (streams.length === 0) return chunks.sort(sortChunks);

    return streams.sort((left, right) => {
      const initDiff = Number(!!right[0]?._meta?.initChunk) - Number(!!left[0]?._meta?.initChunk);
      if (initDiff !== 0) return initDiff;
      return right.length - left.length;
    })[0];
  }

  async function appendBuffer(sourceBuffer, arrayBuf) {
    return new Promise((resolve, reject) => {
      sourceBuffer.addEventListener('update', resolve, { once: true });
      sourceBuffer.addEventListener('error', reject, { once: true });
      sourceBuffer.appendBuffer(arrayBuf);
    });
  }

  function setupVideoPlayer(videoEl, chunks, generation) {
    const sortedChunks = chunks.sort(sortChunks);
    const mimeType = sortedChunks.find((c) => c._meta?.mimeType)?._meta?.mimeType || 'video/webm;codecs="vp8"';
    const mediaSource = new MediaSource();
    activeSources.push(mediaSource);
    const objectUrl = URL.createObjectURL(mediaSource);
    activeObjectUrls.push(objectUrl);
    videoEl.src = objectUrl;

    mediaSource.addEventListener('sourceopen', async () => {
      if (generation !== loadGeneration) return;
      let sourceBuffer;
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      } catch (err) {
        console.error('[Viewer] addSourceBuffer failed:', err);
        return;
      }
      sourceBuffer.mode = 'sequence';

      let firstChunkSeen = false;
      let skipped = 0;

      for (const chunk of sortedChunks) {
        if (generation !== loadGeneration) return;
        const arrayBuf = await loadChunkBuffer(chunk);
        if (!arrayBuf) continue;

        const isInit = Boolean(chunk._meta?.initChunk);
        if (isInit && firstChunkSeen && typeof sourceBuffer.changeType === 'function') {
          try { sourceBuffer.changeType(mimeType); } catch {}
        }
        firstChunkSeen = true;

        try {
          await appendBuffer(sourceBuffer, arrayBuf);
        } catch {
          skipped++;
          if (typeof sourceBuffer.changeType === 'function') {
            try { sourceBuffer.changeType(mimeType); } catch {}
          }
        }
      }

      if (skipped > 0) console.warn(`[Viewer] Video: skipped ${skipped} bad chunks`);
      if (generation === loadGeneration && mediaSource.readyState === 'open') mediaSource.endOfStream();
    });
  }

  function setupAudioPlayer(audioEl, chunks, generation) {
    const sortedChunks = chunks.sort(sortChunks);
    const mimeType = sortedChunks.find((c) => c._meta?.mimeType)?._meta?.mimeType || 'audio/webm;codecs=opus';
    const mediaSource = new MediaSource();
    activeSources.push(mediaSource);
    const objectUrl = URL.createObjectURL(mediaSource);
    activeObjectUrls.push(objectUrl);
    audioEl.src = objectUrl;

    mediaSource.addEventListener('sourceopen', async () => {
      if (generation !== loadGeneration) return;
      try {
        const sourceBuffer = mediaSource.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        let firstChunkSeen = false;
        for (const chunk of sortedChunks) {
          if (generation !== loadGeneration) return;
          const arrayBuf = await loadChunkBuffer(chunk);
          if (!arrayBuf) continue;
          if (chunk._meta?.initChunk && firstChunkSeen) {
            if (typeof sourceBuffer.changeType === 'function') {
              sourceBuffer.changeType(mimeType);
            }
          }
          firstChunkSeen = true;
          await appendBuffer(sourceBuffer, arrayBuf);
        }
        if (generation === loadGeneration && mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch (error) {
        console.error('Audio player error:', error);
      }
    });
  }

  async function loadChunkBuffer(chunk) {
    const meta = chunk._meta || {};
    if (meta.data) {
      return dataUrlToArrayBuffer(meta.data);
    }

    // Prefer pre-signed S3 URL (files deleted from EC2 disk after upload)
    const s3Url = chunk.fileUrls?.recording;
    if (s3Url) {
      const s3Res = await fetch(s3Url);
      if (!s3Res.ok) {
        console.warn(`[Viewer] Skipping missing S3 chunk (${s3Res.status})`);
        return null;
      }
      return s3Res.arrayBuffer();
    }

    const recordingPath = chunk.files?.recording;
    if (!recordingPath || !currentSession?.captureBaseUrl) return null;

    const response = await fetch(`${getApiBase()}${currentSession.captureBaseUrl}/${recordingPath}`);
    if (!response.ok) {
      console.warn(`[Viewer] Skipping missing chunk (${response.status}): ${recordingPath}`);
      return null;
    }
    return response.arrayBuffer();
  }

  async function dataUrlToArrayBuffer(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i += 1) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function sanitizeDomId(value) {
    return String(value || 'player').replace(/[^a-zA-Z0-9_-]/g, '-');
  }

  function formatTimestamp(value) {
    const timestamp = Number(value || 0);
    if (!timestamp) return '-';
    return new Date(timestamp).toLocaleTimeString();
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

  loadSessions();
  setInterval(loadSessions, 5000);
})();
