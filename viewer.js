(function() {
  'use strict';

  const API_BASE = 'http://localhost:8787';
  const sessionList = document.getElementById('sessionList');
  const sessionDetail = document.getElementById('sessionDetail');
  const welcome = document.getElementById('welcome');
  const sessionTitle = document.getElementById('sessionTitle');
  const sessionInfo = document.getElementById('sessionInfo');
  const participantsDiv = document.getElementById('participants');

  let currentSession = null;

  async function loadSessions() {
    try {
      const response = await fetch(`${API_BASE}/api/sessions`);
      if (!response.ok) throw new Error('Failed to load sessions');

      const data = await response.json();
      const sessions = data.sessions || [];

      if (sessions.length === 0) {
        sessionList.innerHTML = '<div class="no-sessions">No sessions yet</div>';
        return;
      }

      sessionList.innerHTML = sessions.map(s => {
        const isV2 = s.sessionId.startsWith('session-');
        return `
          <div class="session-item${isV2 ? '' : ' legacy'}" data-session-id="${s.sessionId}">
            <div class="session-name">${s.meetingId}${isV2 ? '' : ' <span class="legacy-tag">v1</span>'}</div>
            <div class="session-meta">${s.mentorLabel || 'No mentor label'} &bull; ${s.eventCount} events</div>
            <div class="session-time">${new Date(s.updatedAt).toLocaleDateString()}</div>
          </div>
        `;
      }).join('');

      sessionList.querySelectorAll('.session-item').forEach(el => {
        el.addEventListener('click', () => loadSessionDetail(el.dataset.sessionId));
      });
    } catch (e) {
      console.error('Error loading sessions:', e);
      sessionList.innerHTML = '<div class="error">Failed to load sessions</div>';
    }
  }

  async function loadSessionDetail(sessionId) {
    try {
      const response = await fetch(`${API_BASE}/api/sessions/${sessionId}`);
      if (!response.ok) throw new Error('Session not found');

      const data = await response.json();
      const session = data.session || data;
      currentSession = session;

      sessionTitle.textContent = session.meetingId;
      sessionInfo.textContent = `${session.mentorLabel || 'Mentor'} • ${new Date(session.updatedAt).toLocaleString()}`;

      const allEvents = session.events || [];
      const isLegacy = allEvents.some(e =>
        ['remote-media-recording', 'remote-audio-recording', 'pc-hook-installed'].includes(e.type)
      );

      if (isLegacy) {
        participantsDiv.innerHTML = '<div class="no-data">Legacy session (v1 extension) — not playable in this viewer.<br>Only sessions captured with v2 of the extension can be played back.</div>';
        welcome.style.display = 'none';
        sessionDetail.style.display = 'block';
        return;
      }

      // Manual rename events are authoritative and apply retroactively to older
      // chunks from the same stream. This keeps late mentor tagging from leaving
      // early chunks under raw stream IDs or noisy DOM labels.
      const nameByStreamId = {};
      (session.capturedParticipants || []).forEach(p => {
        const streamId = p.participantKey;
        const name = p.participantName;
        if (streamId && name) nameByStreamId[streamId] = name;
      });
      allEvents.forEach(event => {
        if (event.type !== 'participant-renamed') return;
        const meta = event.metadata || event.payload || {};
        if (meta.streamId && meta.name) nameByStreamId[meta.streamId] = meta.name;
      });

      // Group chunks by streamId (stable) rather than participantId (changes as
      // names are assigned). Prefer authoritative stream-name mappings, then
      // fall back to non-raw participantId labels.
      const streamGroups = {};   // streamId → { displayName, audio[], video[] }
      allEvents.forEach(event => {
        if (event.type === 'chunk') {
          const meta = event.metadata || event.payload || {};
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
        }
      });

      // Merge streams that share the same display name (same student, separate
      // audio/video streams from Meet's SFU)
      const participantGroups = {};
      Object.values(streamGroups).forEach(({ displayName, audio, video }) => {
        if (!participantGroups[displayName]) {
          participantGroups[displayName] = { audio: [], video: [], sharedAudio: false };
        }
        participantGroups[displayName].audio.push(...audio);
        participantGroups[displayName].video.push(...video);
      });

      // Merge unnamed audio-only streams into named participants that have video but
      // no audio. Meet's SFU creates multiple redundant audio streams per participant.
      // Match them to the correct student using first-chunk timestamp proximity —
      // audio and video from the same student start at the same time (when they join).
      const unnamedAudioKeys = Object.keys(participantGroups).filter(name => {
        const sg = streamGroups[name]; // unnamed: participantGroups key === raw streamId
        return sg && sg.displayName === sg.streamId && sg.video.length === 0;
      });
      if (unnamedAudioKeys.length > 0) {
        const videoOnlyParticipants = Object.entries(participantGroups)
          .filter(([n, g]) => !unnamedAudioKeys.includes(n) && g.video.length > 0 && g.audio.length === 0)
          .sort(([, a], [, b]) => Math.min(...a.video.map(c => c.at)) - Math.min(...b.video.map(c => c.at)));

        const assigned = new Set();
        for (const [, targetGroup] of videoOnlyParticipants) {
          const videoStart = Math.min(...targetGroup.video.map(c => c.at));
          let bestKey = null, bestDiff = Infinity;

          for (const k of unnamedAudioKeys) {
            if (assigned.has(k)) continue;
            const audioStart = Math.min(...participantGroups[k].audio.map(c => c.at));
            const diff = Math.abs(audioStart - videoStart);
            if (diff < bestDiff) { bestDiff = diff; bestKey = k; }
          }

          if (bestKey !== null && bestDiff < 30000) {
            const bestAudioStart = Math.min(...participantGroups[bestKey].audio.map(c => c.at));
            targetGroup.audio.push(...participantGroups[bestKey].audio);
            assigned.add(bestKey);
            // Also mark SFU duplicates (within 5s of the assigned stream) as consumed
            for (const k of unnamedAudioKeys) {
              if (assigned.has(k)) continue;
              const audioStart = Math.min(...participantGroups[k].audio.map(c => c.at));
              if (Math.abs(audioStart - bestAudioStart) < 5000) assigned.add(k);
            }
          }
        }
        for (const k of unnamedAudioKeys) delete participantGroups[k];
      }

      // If Meet exposes audio as shared/mixed downlink streams, later students may
      // get new video tracks but no new audio tracks. Reuse one stable audio stream
      // so every named video participant can at least play the meeting audio.
      const sharedAudioSource = Object.values(participantGroups)
        .filter(g => g.audio.length > 0)
        .sort((a, b) => b.audio.length - a.audio.length)[0];
      if (sharedAudioSource) {
        const sharedAudioChunks = selectPrimaryAudioStream(sharedAudioSource.audio);
        Object.values(participantGroups).forEach(group => {
          if (group.video.length > 0 && group.audio.length === 0 && sharedAudioChunks.length > 0) {
            group.audio = sharedAudioChunks;
            group.sharedAudio = true;
          }
        });
      }

      // Render participant players
      const html = Object.entries(participantGroups).map(([name, chunks]) => {
        const videoChunks = chunks.video.sort((a, b) => a.at - b.at);
        const audioChunks = selectPrimaryAudioStream(chunks.audio);
        chunks._playbackAudio = audioChunks;

        return `
          <div class="participant">
            <h3>${name === '__local__' ? 'Mentor (You)' : name}</h3>
            ${videoChunks.length > 0 ? `
              <div class="player-section">
                <label>Video (${videoChunks.length} chunks)</label>
                <video controls width="400" data-participant="${name}" data-kind="video"></video>
              </div>
            ` : ''}
            ${audioChunks.length > 0 ? `
              <div class="player-section">
                <label>${chunks.sharedAudio ? 'Shared Audio' : 'Audio'} (${audioChunks.length} chunks)</label>
                <audio controls style="width: 100%;" data-participant="${name}" data-kind="audio"></audio>
              </div>
            ` : ''}
          </div>
        `;
      }).join('');

      participantsDiv.innerHTML = html || '<div class="no-data">No media captured yet</div>';

      // Setup video/audio players
      document.querySelectorAll('[data-kind="video"]').forEach(video => {
        const participant = video.dataset.participant;
        const chunks = participantGroups[participant].video;
        setupVideoPlayer(video, chunks);
      });

      document.querySelectorAll('[data-kind="audio"]').forEach(audio => {
        const participant = audio.dataset.participant;
        const chunks = participantGroups[participant]._playbackAudio || [];
        setupAudioPlayer(audio, chunks);
      });

      welcome.style.display = 'none';
      sessionDetail.style.display = 'block';
    } catch (e) {
      console.error('Error loading session:', e);
      participantsDiv.innerHTML = `<div class="error">Failed to load session: ${e.message}</div>`;
    }
  }

  function selectPrimaryAudioStream(chunks) {
    const byStream = {};
    chunks.forEach(chunk => {
      const streamId = chunk._meta?.streamId;
      if (!streamId) return;
      if (!byStream[streamId]) byStream[streamId] = [];
      byStream[streamId].push(chunk);
    });

    const streams = Object.values(byStream).map(streamChunks =>
      streamChunks.sort((a, b) => {
        const ai = Number.isFinite(a._meta?.index) ? a._meta.index : a.at;
        const bi = Number.isFinite(b._meta?.index) ? b._meta.index : b.at;
        return ai - bi;
      })
    );

    if (streams.length === 0) return chunks.sort((a, b) => a.at - b.at);
    return streams.sort((a, b) => {
      const initDiff = Number(!!b[0]?._meta?.initChunk) - Number(!!a[0]?._meta?.initChunk);
      if (initDiff !== 0) return initDiff;
      return b.length - a.length;
    })[0];
  }

  async function appendBuffer(sb, arrayBuf) {
    return new Promise((resolve, reject) => {
      sb.addEventListener('update', resolve, { once: true });
      sb.addEventListener('error', reject, { once: true });
      sb.appendBuffer(arrayBuf);
    });
  }

  function setupVideoPlayer(videoEl, chunks) {
    const mimeType = 'video/webm;codecs="vp8"';
    const ms = new MediaSource();
    videoEl.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', async () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        for (const chunk of chunks) {
          const data = chunk._meta.data;
          if (!data) continue;
          const arrayBuf = await dataUrlToArrayBuffer(data);
          await appendBuffer(sb, arrayBuf);
        }
        if (ms.readyState === 'open') ms.endOfStream();
      } catch (e) {
        console.error('Video player error:', e);
      }
    });
  }

  function setupAudioPlayer(audioEl, chunks) {
    const mimeType = 'audio/webm;codecs=opus';
    const ms = new MediaSource();
    audioEl.src = URL.createObjectURL(ms);

    ms.addEventListener('sourceopen', async () => {
      try {
        const sb = ms.addSourceBuffer(mimeType);
        for (const chunk of chunks) {
          const data = chunk._meta.data;
          if (!data) continue;
          const arrayBuf = await dataUrlToArrayBuffer(data);
          await appendBuffer(sb, arrayBuf);
        }
        if (ms.readyState === 'open') ms.endOfStream();
      } catch (e) {
        console.error('Audio player error:', e);
      }
    });
  }

  async function dataUrlToArrayBuffer(dataUrl) {
    const base64 = dataUrl.split(',')[1];
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Load sessions on startup
  loadSessions();
  setInterval(loadSessions, 5000); // Refresh every 5 seconds
})();
