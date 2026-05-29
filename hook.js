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
  const videoManualHints = new WeakMap();
  const capturedLocalTrackIds = new Set();
  let chunkIndex = 0;
  const VIDEO_MANUAL_HINT_TTL_MS = 15000;

  function sendMessage(type, payload) {
    try {
      window.postMessage({ source: 'meet-capture-hook', type, payload }, '*');
    } catch (e) {}
  }

  function stopRecorder(streamId, kind) {
    const key = `${streamId}-${kind}`;
    const recorder = activeRecorders.get(key);
    if (!recorder) return;

    try {
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    } catch (e) {
      console.error('[Hook] stopRecorder error:', e);
    } finally {
      activeRecorders.delete(key);
    }
  }

  function createRecorder(streamId, stream, kind, options = {}) {
    const key = `${streamId}-${kind}`;
    if (activeRecorders.has(key)) return;

    const types = kind === 'video'
      ? ['video/webm;codecs=vp8', 'video/webm']
      : ['audio/webm;codecs=opus', 'audio/webm'];
    const mimeType = types.find(t => MediaRecorder.isTypeSupported(t)) || '';

    try {
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      let isFirstChunk = true;
      let segmentStartedAt = Date.now();

      recorder.ondataavailable = (e) => {
        try {
          if (!e.data || e.data.size === 0) return;
          const isInit = isFirstChunk;
          isFirstChunk = false;
          const chunkEndedAt = Date.now();
          const chunkStartedAt = segmentStartedAt;
          const durationMs = Math.max(0, chunkEndedAt - chunkStartedAt);
          segmentStartedAt = chunkEndedAt;
          const idx = chunkIndex++;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const participantId = options.participantId || streamId;
              sendMessage('chunk', {
                streamId,
                participantId,
                kind,
                mediaRole: options.mediaRole || (kind === 'video' ? 'student-video' : 'shared-audio'),
                trackSource: options.trackSource || 'remote',
                mimeType: e.data.type || mimeType || '',
                chunkStartedAt,
                chunkEndedAt,
                durationMs,
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
      recorder.start(3000);
      activeRecorders.set(key, recorder);
      sendMessage('recorder-started', {
        streamId,
        kind,
        mediaRole: options.mediaRole || (kind === 'video' ? 'student-video' : 'shared-audio'),
        trackSource: options.trackSource || 'remote',
        participantId: options.participantId || streamId,
        mimeType
      });
    } catch (e) {
      console.error('[Hook] createRecorder error:', e);
    }
  }

  function startCapture(streamId, track, options = {}) {
    try {
      if (!activeStreams.has(streamId)) {
        activeStreams.set(streamId, {
          audioTrackId: null,
          videoTrackId: null
        });
      }
      const seen = activeStreams.get(streamId);
      const kind = track.kind;
      const trackKey = kind === 'audio' ? 'audioTrackId' : 'videoTrackId';
      const previousTrackId = seen[trackKey];

      // Always store track ID → streamId so DOM scan can match via getTracks()
      trackToStreamId.set(track.id, streamId);

      if (previousTrackId === track.id) {
        return;
      }

      if (previousTrackId && previousTrackId !== track.id) {
        console.log('[Hook] track replaced', { streamId, kind, previousTrackId, nextTrackId: track.id });
        sendMessage('track-replaced', {
          streamId,
          kind,
          previousTrackId,
          nextTrackId: track.id,
          mediaRole: options.mediaRole || (kind === 'video' ? 'student-video' : 'shared-audio'),
          trackSource: options.trackSource || 'remote',
          participantId: options.participantId || streamId
        });
        stopRecorder(streamId, kind);
      }

      seen[trackKey] = track.id;

      if (kind === 'audio') {
        createRecorder(streamId, new MediaStream([track]), 'audio', options);
        sendMessage('track-captured', {
          streamId,
          kind: 'audio',
          mediaRole: options.mediaRole || 'shared-audio',
          trackSource: options.trackSource || 'remote',
          participantId: options.participantId || streamId
        });
      } else if (kind === 'video') {
        createRecorder(streamId, new MediaStream([track]), 'video', options);
        sendMessage('track-captured', {
          streamId,
          kind: 'video',
          mediaRole: options.mediaRole || 'student-video',
          trackSource: options.trackSource || 'remote',
          participantId: options.participantId || streamId
        });
      }
    } catch (e) {
      console.error('[Hook] startCapture error:', e);
    }
  }

  function captureLocalAudioTrack(track, pcId) {
    try {
      if (!track || track.kind !== 'audio') return;
      if (capturedLocalTrackIds.has(track.id)) return;
      capturedLocalTrackIds.add(track.id);

      const streamId = `mentor-local-audio-${track.id}`;
      participantNames.set(streamId, '__mentor__');
      startCapture(streamId, track, {
        mediaRole: 'mentor-audio',
        participantId: '__mentor__',
        trackSource: 'local'
      });
      sendMessage('local-track', {
        pcId,
        streamId,
        kind: 'audio',
        mediaRole: 'mentor-audio',
        participantId: '__mentor__',
        trackSource: 'local'
      });
    } catch (e) {
      console.error('[Hook] captureLocalAudioTrack error:', e);
    }
  }

  function inspectLocalSenders(pc, pcId) {
    try {
      const senders = typeof pc.getSenders === 'function' ? pc.getSenders() : [];
      senders.forEach((sender) => captureLocalAudioTrack(sender?.track, pcId));
    } catch (e) {
      console.error('[Hook] inspectLocalSenders error:', e);
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
          startCapture(streamId, e.track, {
            mediaRole: e.track.kind === 'video' ? 'student-video' : 'shared-audio',
            trackSource: 'remote'
          });
          sendMessage('remote-track', {
            pcId,
            streamId,
            kind: e.track.kind,
            mediaRole: e.track.kind === 'video' ? 'student-video' : 'shared-audio',
            trackSource: 'remote'
          });
        } catch (err) {
          console.error('[Hook] track event error:', err);
        }
      });

      const inspectSoon = () => setTimeout(() => inspectLocalSenders(pc, pcId), 0);
      inspectSoon();
      setTimeout(() => inspectLocalSenders(pc, pcId), 1500);
      setTimeout(() => inspectLocalSenders(pc, pcId), 5000);
      setTimeout(() => inspectLocalSenders(pc, pcId), 10000);

      pc.addEventListener('negotiationneeded', inspectSoon);
      pc.addEventListener('signalingstatechange', inspectSoon);
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

  const NOISE = /^(mute|you|reframe|default|camera|microphone|speaker|more options|turn on captions|pin|raise hand|lower hand|admit|remove|report|block)$/i;
  const ICON_NOISE = /keep_outline|more_vert|mic_none|mic_off|frame_person/i;
  const ACTION_LABEL_PREFIX = /^(tuỳ chọn khác cho|tuy chon khac cho|more options for|options for|action for)\b/i;

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
      if (/\b(can'?t unmute someone else|unmute someone else)\b/i.test(s)) return null;
      if (/you can'?t remotely\b/i.test(s)) return null;
      if (/^(tắt tiếng|bật tiếng|ghim video|bỏ ghim|đặt làm tiêu điểm|hủy đặt làm tiêu điểm|xóa tiêu điểm)$/i.test(s)) return null;
      if (/bạn không thể bật tiếng|không thể tắt tiếng của người khác/i.test(s)) return null;
      if (ACTION_LABEL_PREFIX.test(s)) return null;
      if (/\bfor\s+[^\s].*$/i.test(s) && /\b(options?|actions?)\b/i.test(s)) return null;
      if (/^for\s+\p{L}/u.test(s)) return null;
      if (/^[a-z0-9_-]{18,}$/i.test(s)) return null;
      return s;
    } catch (e) {
      return null;
    }
  }

  function getSingleName(values) {
    const names = Array.from(new Set(
      values
        .map((value) => cleanName(value))
        .filter(Boolean)
    ));
    return names.length === 1 ? names[0] : '';
  }

  function rememberManualVideoHint(video, name) {
    const clean = cleanName(name);
    if (!video || !clean) return;
    videoManualHints.set(video, { name: clean, seenAt: Date.now() });
  }

  function getManualVideoHint(video) {
    const hint = videoManualHints.get(video);
    if (!hint) return '';
    if (Date.now() - hint.seenAt > VIDEO_MANUAL_HINT_TTL_MS) {
      videoManualHints.delete(video);
      return '';
    }
    return hint.name || '';
  }

  function buildDetectedName(name, source, confidence) {
    const clean = cleanName(name);
    if (!clean) return null;
    return {
      name: clean,
      source,
      confidence
    };
  }

  function guessNameFromVideo(video) {
    try {
      const tile = video.closest(
        '[data-participant-id],[data-self-name],[data-participant-name],[role="listitem"],[role="button"]'
      ) || video.parentElement || video;

      for (const attr of ['data-participant-name', 'data-self-name']) {
        const detected = buildDetectedName(tile.getAttribute(attr), 'data-attribute', 'high');
        if (detected) return detected;
      }

      const nodes = tile.querySelectorAll('[data-participant-name],[data-self-name],span,div');
      for (const node of nodes) {
        for (const attr of ['data-participant-name', 'data-self-name']) {
          const detected = buildDetectedName(node.getAttribute(attr), 'data-attribute', 'high');
          if (detected) return detected;
        }
      }

      // Text only from leaf nodes — container textContent concatenates all
      // children without spaces, producing "DucchuyDucchuy" style artifacts
      for (const node of nodes) {
        if (node.children.length === 0) {
          const detected = buildDetectedName(node.textContent, 'leaf-text', 'medium');
          if (detected) return detected;
        }
      }

      // aria-label fallback is intentionally last and low-confidence because
      // Meet often uses action labels such as "More options for ...".
      for (const node of nodes) {
        const detected = buildDetectedName(node.getAttribute('aria-label'), 'aria-label', 'low');
        if (detected) return detected;
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

          const manualInheritedName = getSingleName(
            Array.from(matchedStreamIds)
              .filter((sid) => manuallyNamed.has(sid))
              .map((sid) => participantNames.get(sid))
          );
          if (manualInheritedName) {
            rememberManualVideoHint(video, manualInheritedName);
          }

          const detectedName = manualInheritedName
            ? { name: manualInheritedName, source: 'manual', confidence: 'high' }
            : guessNameFromVideo(video) || (getManualVideoHint(video) ? { name: getManualVideoHint(video), source: 'manual', confidence: 'high' } : null);
          if (!detectedName?.name) continue;

          for (const sid of matchedStreamIds) {
            if (manuallyNamed.has(sid)) continue;
            if (participantNames.get(sid) !== detectedName.name) {
              participantNames.set(sid, detectedName.name);
              sendMessage('participant-name-detected', {
                streamId: sid,
                name: detectedName.name,
                source: detectedName.source,
                confidence: detectedName.confidence
              });
              console.log('[Hook] Detected name from DOM:', sid, '->', detectedName.name, detectedName.source);
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
