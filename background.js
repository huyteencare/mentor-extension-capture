(function() {
  'use strict';

  const API_URL = 'http://localhost:8787/api/capture/batch';
  const UPLOAD_INTERVAL_MS = 8000;
  const TAG_JOIN_SETTLE_MS = 1500;
  const TAG_JOIN_VIDEO_ONLY_MS = 5000;
  const TAG_JOIN_TIMEOUT_MS = 30000;

  // Session state per tab
  const sessions = new Map();

  function extractMeetingId(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'meet.google.com') {
        const match = u.pathname.match(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}/) ||
                      u.pathname.match(/\/[a-z\-]+/);
        return match ? match[0].substring(1) : 'unknown';
      }
    } catch (e) {}
    return 'unknown';
  }

  function createSession(tabId, url) {
    const sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}-tab-${tabId}`;
    const session = {
      tabId,
      sessionId,
      meetingId: extractMeetingId(url),
      mentorLabel: savedMentorLabel,
      capturedParticipants: [],
      participantNames: new Map(),
      manuallyNamed: new Set(), // stream IDs named by mentor — never overwritten by DOM scan
      streamRecords: new Map(), // streamId -> { streamId, kind, firstSeenAt, lastSeenAt, assignedName }
      tagJoin: {
        lastResetAt: Date.now(),
        savedCount: 0
      },
      events: [],
      uploadQueue: [],
      uploadTimer: null,
      lastUploadTime: 0
    };
    sessions.set(tabId, session);
    return session;
  }

  function getSession(tabId) {
    if (sessions.has(tabId)) {
      return sessions.get(tabId);
    }

    const session = createSession(tabId, 'unknown');

    // Get actual tab URL for meeting ID extraction (only if valid tab ID)
    if (tabId && tabId > 0) {
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.url) {
          const activeSession = sessions.get(tabId);
          if (activeSession && activeSession.meetingId === 'unknown') {
            activeSession.meetingId = extractMeetingId(tab.url);
            console.log('[Meet Capture] Updated meeting ID:', activeSession.meetingId);
          }
        }
      });
    }

    return session;
  }

  function queueEvent(tabId, type, payload) {
    const session = getSession(tabId);
    const now = Date.now();
    const event = {
      type,
      at: now,
      payload
    };
    session.events.push(event);
    session.uploadQueue.push(event);

    // Auto-register new stream IDs so they appear in the popup immediately
    if ((type === 'track-captured' || type === 'recorder-started') && payload?.streamId) {
      if (!session.participantNames.has(payload.streamId)) {
        session.participantNames.set(payload.streamId, '');
      }
      registerStream(session, payload.streamId, payload.kind, now);
    }

    console.log(`[Meet Capture] Queued event: ${type} (total: ${session.events.length})`);

    scheduleUpload(session);
  }

  function registerStream(session, streamId, kind, seenAt) {
    if (!streamId || !kind) return;
    const existing = session.streamRecords.get(streamId);
    if (existing) {
      existing.lastSeenAt = seenAt;
      if (!existing.kind) existing.kind = kind;
      return;
    }
    session.streamRecords.set(streamId, {
      streamId,
      kind,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      assignedName: ''
    });
  }

  function getTagJoinCandidate(session) {
    const streams = Array.from(session.streamRecords.values())
      .filter(s => !s.assignedName && s.firstSeenAt >= session.tagJoin.lastResetAt)
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt);

    const audio = streams.filter(s => s.kind === 'audio');
    const video = streams.filter(s => s.kind === 'video');
    const streamIds = streams.map(s => s.streamId);
    const now = Date.now();
    const lastSeenAt = streams.length > 0 ? Math.max(...streams.map(s => s.lastSeenAt)) : 0;
    const stableForMs = lastSeenAt ? now - lastSeenAt : 0;
    const hasTimedOut = streams.length > 0 && now - session.tagJoin.lastResetAt > TAG_JOIN_TIMEOUT_MS;
    const hasAudioVideo = audio.length > 0 && video.length > 0;
    const videoOnlyFallback = session.tagJoin.savedCount > 0 &&
      audio.length === 0 &&
      video.length > 0 &&
      stableForMs >= TAG_JOIN_VIDEO_ONLY_MS;
    const ready = (hasAudioVideo && stableForMs >= TAG_JOIN_SETTLE_MS) || videoOnlyFallback;

    let status = 'waiting';
    if (streams.length === 0) status = 'waiting';
    else if (videoOnlyFallback) status = 'ready-video-only';
    else if (audio.length === 0) status = 'waiting-audio';
    else if (video.length === 0) status = 'waiting-video';
    else if (!ready) status = 'settling';
    else status = 'ready';

    return {
      status,
      ready,
      streamIds,
      audioStreamIds: audio.map(s => s.streamId),
      videoStreamIds: video.map(s => s.streamId),
      audioCount: audio.length,
      videoCount: video.length,
      firstSeenAt: streams.length > 0 ? streams[0].firstSeenAt : null,
      lastSeenAt: lastSeenAt || null,
      stableForMs,
      settleMs: TAG_JOIN_SETTLE_MS,
      videoOnlyMs: TAG_JOIN_VIDEO_ONLY_MS,
      videoOnly: videoOnlyFallback,
      timedOut: hasTimedOut,
      savedCount: session.tagJoin.savedCount
    };
  }

  function assignNameToStreams(session, tabId, streamIds, name) {
    for (const sid of streamIds) {
      const record = session.streamRecords.get(sid);
      if (record) record.assignedName = name;
      session.participantNames.set(sid, name);
      session.manuallyNamed.add(sid);
      queueEvent(tabId, 'participant-renamed', { streamId: sid, name });
      chrome.tabs.sendMessage(tabId, {
        target: 'hook',
        type: 'set-participant-name',
        payload: { streamId: sid, name }
      }).catch(() => {});
    }
  }

  function scheduleUpload(session) {
    if (session.uploadTimer) return;

    session.uploadTimer = setTimeout(() => {
      uploadBatch(session);
    }, UPLOAD_INTERVAL_MS);
  }

  async function uploadBatch(session) {
    if (session.uploadTimer) {
      clearTimeout(session.uploadTimer);
      session.uploadTimer = null;
    }

    if (session.uploadQueue.length === 0) return;

    const batch = {
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      captureRole: 'mentor',
      mentorLabel: session.mentorLabel,
      pageUrl: '',
      userAgent: navigator.userAgent,
      capturedParticipants: Array.from(session.participantNames.entries())
        .filter(([id, name]) => {
          const record = session.streamRecords.get(id);
          return name && (!!record?.assignedName || session.manuallyNamed.has(id));
        })
        .map(([id, name]) => ({
          participantKey: id,
          participantName: name,
          mappingConfidence: 'high',
          labelSource: 'manual'
        })),
      manualParticipantOverrides: {},
      trackStats: {
        remoteAudioTracks: 0,
        remoteVideoTracks: 0,
        localAudioTracks: 1,
        localVideoTracks: 0
      },
      uploadAttempts: 1,
      events: session.uploadQueue.map(e => ({
        type: e.type,
        at: e.at,
        pageUrl: '',
        payload: e.payload
      }))
    };

    try {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });

      if (response.ok) {
        const result = await response.json();
        session.uploadQueue = [];
        session.lastUploadTime = Date.now();
        console.log(`[Meet Capture] Uploaded ${result.savedEventCount} events`);

        // Broadcast upload success to popup
        chrome.tabs.sendMessage(session.tabId, {
          type: 'upload-success',
          savedCount: result.savedEventCount
        }).catch(() => {});
      } else {
        console.warn(`[Meet Capture] Upload failed: ${response.status}`);
      }
    } catch (e) {
      console.error('[Meet Capture] Upload error:', e);
    }

    // Schedule next upload if queue has items
    if (session.uploadQueue.length > 0) {
      scheduleUpload(session);
    }
  }

  // Listen to content script messages
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
      // Popup sends tabId explicitly; content scripts have sender.tab
      const tabId = request.tabId || sender.tab?.id || 0;

      // Hook events - just queue them
      if (request.type === 'content-ready') {
        getSession(tabId);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'chunk' || request.type === 'error' ||
          request.type === 'recorder-started' || request.type === 'track-captured' ||
          request.type === 'peer-created' || request.type === 'hook-installed' ||
          request.type === 'remote-track' || request.type === 'local-track') {
        queueEvent(tabId, request.type, request.payload);
        sendResponse({ ok: true });
        return true;
      }

      // Auto-detected name from DOM scan — never overwrite a manually saved name
      if (request.type === 'participant-name-detected') {
        const session = getSession(tabId);
        const { streamId, name } = request.payload || {};
        if (streamId && name && !session.manuallyNamed.has(streamId)) {
          session.participantNames.set(streamId, name);
        }
        sendResponse({ ok: true });
        return true;
      }

      // Popup requests
      if (request.type === 'get-session-state') {
        const session = getSession(tabId);

        // Group streams by name. Only named streams are shown by default —
        // unnamed streams are SFU infrastructure/background tracks that Meet
        // creates even with no real participants. The popup can opt-in to
        // showing all streams via showAll flag for manual fallback tagging.
        const showAll = request.showAll || false;
        const nameToGroup = new Map(); // name → { streamId, name, allStreamIds }
        const groups = [];

        for (const [streamId, name] of session.participantNames.entries()) {
          const record = session.streamRecords.get(streamId);
          const isManuallyAssigned = !!record?.assignedName || session.manuallyNamed.has(streamId);
          if (name && isManuallyAssigned && nameToGroup.has(name)) {
            nameToGroup.get(name).allStreamIds.push(streamId);
          } else if (name && isManuallyAssigned) {
            const entry = { streamId, name, allStreamIds: [streamId] };
            groups.push(entry);
            nameToGroup.set(name, entry);
          } else if (showAll) {
            groups.push({ streamId, name: '', allStreamIds: [streamId] });
          }
        }

        sendResponse({
          sessionId: session.sessionId,
          meetingId: session.meetingId,
          mentorLabel: session.mentorLabel,
          participantNames: groups,
          tagJoin: getTagJoinCandidate(session),
          eventCount: session.events.length,
          uploadedSize: 0,
          queueSize: session.uploadQueue.length
        });
        return true;
      }

      if (request.type === 'set-mentor-label') {
        const session = getSession(tabId);
        session.mentorLabel = request.label;
        chrome.storage.local.set({ mentorLabel: request.label }, () => {
          console.log('[Meet Capture] Saved mentor label:', request.label);
        });
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'set-participant-name') {
        const session = getSession(tabId);
        // Apply name to every stream in the group (covers separate audio+video streams)
        const streamIds = request.streamIds || [request.streamId];
        assignNameToStreams(session, tabId, streamIds, request.name);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'tag-join-save') {
        const session = getSession(tabId);
        const name = String(request.name || '').trim();
        const candidate = getTagJoinCandidate(session);
        if (!name) {
          sendResponse({ ok: false, error: 'missing-name' });
          return true;
        }
        if (!candidate.ready || candidate.streamIds.length === 0) {
          sendResponse({ ok: false, error: 'candidate-not-ready', candidate });
          return true;
        }
        assignNameToStreams(session, tabId, candidate.streamIds, name);
        session.tagJoin.savedCount += 1;
        session.tagJoin.lastResetAt = Date.now();
        sendResponse({ ok: true, assignedStreamIds: candidate.streamIds });
        return true;
      }

      if (request.type === 'force-upload') {
        const session = getSession(tabId);
        uploadBatch(session);
        sendResponse({ ok: true });
        return true;
      }

      sendResponse({ ok: false });
    } catch (err) {
      console.error('[Meet Capture] Message error:', err);
      try {
        sendResponse({ ok: false, error: err.message });
      } catch (e) {
        // Ignore
      }
    }
  });

  // Cleanup on tab close
  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = sessions.get(tabId);
    if (session) {
      if (session.uploadTimer) {
        clearTimeout(session.uploadTimer);
      }
      // Upload remaining events before cleanup
      uploadBatch(session);
      sessions.delete(tabId);
    }
  });

  // Load saved mentor label so new sessions inherit it immediately
  let savedMentorLabel = '';
  chrome.storage.local.get('mentorLabel', (data) => {
    if (data && data.mentorLabel) {
      savedMentorLabel = data.mentorLabel;
      console.log('[Meet Capture] Loaded mentor label:', savedMentorLabel);
    }
  });
})();
