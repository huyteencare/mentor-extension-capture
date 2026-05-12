(function() {
  'use strict';

  const marker = '__meetCaptureV2Hooked';
  if (window[marker]) return;
  window[marker] = true;

  const NativeRTCPeerConnection = window.RTCPeerConnection;
  if (typeof NativeRTCPeerConnection !== 'function') return;

  const activeRecorders = new Map();
  const activeStreams = new Map();
  const participantNames = new Map();
  const manuallyNamed = new Set();
  const trackToStreamId = new Map(); // track.id → streamId (for DOM scan matching)
  let chunkIndex = 0;

  function sendMessage(type, payload) {
    try {
      window.postMessage({ source: 'meet-capture-hook', type, payload }, '*');
    } catch (e) {}
  }

  function createRecorder(streamId, stream, kind) {
    const key = `${streamId}-${kind}`;
    if (activeRecorders.has(key)) return;

    const types = kind === 'video'
      ? ['video/webm;codecs=vp8', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm'];
    const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';

    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      let isFirstChunk = true;

      recorder.ondataavailable = (e) => {
        try {
          if (!e.data || e.data.size === 0) return;
          const isInit = isFirstChunk;
          isFirstChunk = false;
          const idx = chunkIndex++;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const participantId = participantNames.get(streamId) || streamId;
              sendMessage('chunk', {
                streamId,
                participantId,
                kind,
                data: reader.result,
                initChunk: isInit,
                index: idx
              });
            } catch (err) {
              console.error('[Hook] chunk send error:', err);
            }
          };
          reader.onerror = (err) => console.error('[Hook] FileReader error:', err);
          reader.readAsDataURL(e.data);
        } catch (err) {
          console.error('[Hook] ondataavailable error:', err);
        }
      };

      recorder.onerror = (e) => console.error('[Hook] MediaRecorder error:', e);
      recorder.start(10000);
      activeRecorders.set(key, recorder);
      sendMessage('recorder-started', { streamId, kind });
    } catch (e) {
      console.error('[Hook] createRecorder error:', e);
    }
  }

  function startCapture(streamId, track) {
    try {
      if (!activeStreams.has(streamId)) {
        activeStreams.set(streamId, { audio: false, video: false });
      }
      const seen = activeStreams.get(streamId);
      const kind = track.kind;

      // Always store track ID → streamId so DOM scan can match via getTracks()
      trackToStreamId.set(track.id, streamId);

      if (kind === 'audio' && !seen.audio) {
        seen.audio = true;
        createRecorder(streamId, new MediaStream([track]), 'audio');
        sendMessage('track-captured', { streamId, kind: 'audio' });
      } else if (kind === 'video' && !seen.video) {
        seen.video = true;
        createRecorder(streamId, new MediaStream([track]), 'video');
        sendMessage('track-captured', { streamId, kind: 'video' });
      }
    } catch (e) {
      console.error('[Hook] startCapture error:', e);
    }
  }

  function wrapPeerConnection(pc) {
    try {
      const pcId = `pc-${++state.peerCount}`;
      sendMessage('peer-created', { pcId });
      console.log('[Hook] peer-created', pcId);

      pc.addEventListener('track', (e) => {
        try {
          const streamId = (e.streams && e.streams[0]) ? e.streams[0].id : e.track.id;
          console.log('[Hook] track event', { pcId, streamId, kind: e.track.kind, streamsLen: e.streams?.length });
          startCapture(streamId, e.track);
          sendMessage('remote-track', { pcId, streamId, kind: e.track.kind });
        } catch (err) {
          console.error('[Hook] track event error:', err);
        }
      });
    } catch (e) {
      console.error('[Hook] wrapPeerConnection error:', e);
    }
    return pc;
  }

  const state = { peerCount: 0 };

  function RTCPeerConnectionPatched(...args) {
    try {
      const pc = new NativeRTCPeerConnection(...args);
      return wrapPeerConnection(pc);
    } catch (e) {
      console.error('[Hook] RTCPeerConnection constructor error:', e);
      throw e; // re-throw so Meet gets the real error
    }
  }

  RTCPeerConnectionPatched.prototype = NativeRTCPeerConnection.prototype;
  Object.setPrototypeOf(RTCPeerConnectionPatched, NativeRTCPeerConnection);
  window.RTCPeerConnection = RTCPeerConnectionPatched;

  // ── DOM scanning: map video srcObject stream IDs → participant names ──────

  const NOISE = /^(mute|you|reframe|default|camera|microphone|speaker|more options|turn on captions|pin)$/i;
  const ICON_NOISE = /keep_outline|more_vert|mic_none|mic_off|frame_person/i;

  function cleanName(text) {
    try {
      if (!text) return null;
      let s = String(text).trim()
        .replace(ICON_NOISE, ' ')
        .replace(/\bpin\b|\bmute\b|\bmore options\b/gi, ' ')
        .replace(/\s+/g, ' ').trim();
      if (!s || s.length < 2 || s.length > 40) return null;
      if (NOISE.test(s)) return null;
      if (/\b(to your|main screen|presenting|is sharing)\b/i.test(s)) return null;
      if (/^[a-z0-9_-]{18,}$/i.test(s)) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function guessNameFromVideo(video) {
    try {
      const tile = video.closest(
        '[data-participant-id],[data-self-name],[data-participant-name],[role="listitem"],[role="button"]'
      ) || video.parentElement || video;

      for (const attr of ['data-participant-name', 'data-self-name']) {
        const n = cleanName(tile.getAttribute(attr));
        if (n) return n;
      }

      const nodes = tile.querySelectorAll('[data-participant-name],[data-self-name],span,div');
      for (const node of nodes) {
        for (const attr of ['data-participant-name', 'data-self-name']) {
          const n = cleanName(node.getAttribute(attr));
          if (n) return n;
        }
      }

      // aria-label fallback
      for (const node of nodes) {
        const n = cleanName(node.getAttribute('aria-label'));
        if (n) return n;
      }

      // Text only from leaf nodes — container textContent concatenates all
      // children without spaces, producing "DucchuyDucchuy" style artifacts
      for (const node of nodes) {
        if (node.children.length === 0) {
          const n = cleanName(node.textContent);
          if (n) return n;
        }
      }
    } catch (e) {
      console.error('[Hook] guessNameFromVideo error:', e);
    }
    return null;
  }

  function scanParticipantNames() {
    try {
      const videos = document.querySelectorAll('video');
      for (const video of videos) {
        try {
          const stream = video.srcObject;
          if (!(stream instanceof MediaStream)) continue;

          // Match ALL tracks in this video element's srcObject. Meet re-wraps tracks
          // so match by track.id, not stream.id. Naming each matched stream here
          // scopes propagation to one student per video tile — no cross-student bleed.
          const matchedStreamIds = new Set();
          for (const track of stream.getTracks()) {
            if (trackToStreamId.has(track.id)) {
              matchedStreamIds.add(trackToStreamId.get(track.id));
            }
          }
          if (matchedStreamIds.size === 0) continue;

          const name = guessNameFromVideo(video);
          if (!name) continue;

          for (const sid of matchedStreamIds) {
            if (manuallyNamed.has(sid)) continue;
            if (participantNames.get(sid) !== name) {
              participantNames.set(sid, name);
              sendMessage('participant-name-detected', { streamId: sid, name });
              console.log('[Hook] Detected name from DOM:', sid, '->', name);
            }
          }
        } catch (e) {
          console.error('[Hook] scanParticipantNames video error:', e);
        }
      }
    } catch (e) {
      console.error('[Hook] scanParticipantNames error:', e);
    }
  }

  setInterval(scanParticipantNames, 2000);

  // ─────────────────────────────────────────────────────────────────────────

  sendMessage('hook-installed', { timestamp: Date.now() });
  console.log('[Hook] RTCPeerConnection patched (v1 pattern)');

  window.addEventListener('message', (e) => {
    try {
      if (e.source !== window) return;
      if (!e.data || e.data.source !== 'meet-capture-control') return;
      if (e.data.type === 'set-participant-name') {
        const { streamId, name } = e.data.payload || {};
        if (streamId) {
          participantNames.set(streamId, name);
          manuallyNamed.add(streamId);
          sendMessage('participant-renamed', { streamId, name });
        }
      }
    } catch (err) {
      console.error('[Hook] message listener error:', err);
    }
  });
})();
