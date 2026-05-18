importScripts('config.js');

(function() {
  'use strict';

  const API_URL = `${API_BASE_URL}/api/capture/batch`;
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

  function isActiveMeetingId(meetingId) {
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(String(meetingId || ''));
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
      manuallyNamed: new Set(),  // stream IDs named by mentor — never overwritten by DOM scan
      streamRecords: new Map(),  // streamId -> { streamId, kind, firstSeenAt, lastSeenAt, assignedName, ownerId }
      ownerRecords: new Map(),     // ownerId -> { ownerId, name, streamIds: [] }
      streamToOwner: new Map(),    // streamId -> ownerId
      ownerCounter: 0,
      tagJoin: {
        lastResetAt: Date.now(),
        savedCount: 0,
        lastPeerCreatedAt: 0
      },
      toast: {
        shown: false,       // toast is currently visible on the Meet tab
        suppressed: false,  // mentor clicked Skip — don't re-show for this candidate cycle
      },
      trackStats: {
        remoteAudioTracks: new Set(),
        remoteVideoTracks: new Set(),
        localAudioTracks: new Set(),
        localVideoTracks: new Set()
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

  async function rotateSessionForTab(tabId, url) {
    const existing = sessions.get(tabId);
    if (existing) {
      await uploadBatch(existing);
      if (existing.uploadTimer) {
        clearTimeout(existing.uploadTimer);
      }
      sessions.delete(tabId);
    }
    return createSession(tabId, url);
  }

  function queueEvent(tabId, type, payload) {
    const session = getSession(tabId);
    const now = Date.now();
    if (type === 'chunk' && payload?.streamId) {
      const ownerId = session.streamToOwner.get(payload.streamId);
      if (ownerId) payload = { ...payload, ownerId };
    }
    const event = {
      type,
      at: now,
      payload
    };
    session.events.push(event);
    session.uploadQueue.push(event);

    observeTrackStats(session, payload);
    if (type === 'peer-created') {
      session.tagJoin.lastPeerCreatedAt = now;
    }

    // Auto-register new stream IDs so they appear in the popup immediately
    if ((type === 'track-captured' || type === 'recorder-started') && payload?.streamId) {
      if (payload.mediaRole !== 'mentor-audio' && !session.participantNames.has(payload.streamId)) {
        session.participantNames.set(payload.streamId, '');
      }
      registerStream(session, payload.streamId, payload.kind, now, payload.mediaRole, payload.trackSource);
      maybeAutoAssignKnownVideoStream(session, tabId, payload.streamId);
      if (payload.mediaRole !== 'mentor-audio') {
        scheduleToastChecks(session, tabId);
      }
    }

    console.log(`[Meet Capture] Queued event: ${type} (total: ${session.events.length})`);

    scheduleUpload(session);
  }

  function observeTrackStats(session, payload) {
    if (!payload?.streamId || !payload?.kind) return;
    const trackSource = payload.trackSource || (payload.mediaRole === 'mentor-audio' ? 'local' : 'remote');
    const kindKey = payload.kind === 'video' ? 'Video' : 'Audio';
    const sourceKey = trackSource === 'local' ? 'local' : 'remote';
    const statKey = `${sourceKey}${kindKey}Tracks`;
    session.trackStats?.[statKey]?.add(payload.streamId);
  }

  function registerStream(session, streamId, kind, seenAt, mediaRole, trackSource) {
    if (!streamId || !kind) return;
    const existing = session.streamRecords.get(streamId);
    if (existing) {
      existing.lastSeenAt = seenAt;
      if (!existing.kind) existing.kind = kind;
      if (!existing.mediaRole && mediaRole) existing.mediaRole = mediaRole;
      if (!existing.trackSource && trackSource) existing.trackSource = trackSource;
      return;
    }
    session.streamRecords.set(streamId, {
      streamId,
      kind,
      mediaRole: mediaRole || '',
      trackSource: trackSource || '',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      assignedName: ''
    });
  }

  function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function maybeAutoAssignKnownVideoStream(session, tabId, streamId) {
    const record = session.streamRecords.get(streamId);
    if (!record || record.assignedName) return;
    if (record.kind !== 'video' || record.mediaRole !== 'student-video') return;

    const name = String(session.participantNames.get(streamId) || '').trim();
    if (!name) return;

    const existingAssigned = findAssignedParticipantByName(session, name);
    if (existingAssigned) {
      assignNameToStreams(session, tabId, [streamId], existingAssigned.assignedName || name);
    }
  }

  function getTagJoinCandidate(session) {
    const streams = Array.from(session.streamRecords.values())
      .filter((record) => {
        if (record.assignedName) return false;
        if (record.firstSeenAt < session.tagJoin.lastResetAt) return false;
        if (record.mediaRole === 'mentor-audio') return false;
        if (record.mediaRole === 'shared-audio') return false;
        if (record.trackSource === 'local') return false;

        const detectedName = String(session.participantNames.get(record.streamId) || '').trim();
        const existingAssigned = detectedName ? findAssignedByDomName(session, detectedName) : null;
        if (record.kind === 'video' && existingAssigned) {
          return false;
        }

        return true;
      })
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt);

    const audio = streams.filter(s => s.kind === 'audio');
    const video = streams.filter(s => s.kind === 'video');
    const streamIds = streams.map(s => s.streamId);
    const now = Date.now();
    const lastSeenAt = streams.length > 0 ? Math.max(...streams.map(s => s.lastSeenAt)) : 0;
    const stableForMs = lastSeenAt ? now - lastSeenAt : 0;
    const hasTimedOut = streams.length > 0 && now - session.tagJoin.lastResetAt > TAG_JOIN_TIMEOUT_MS;
    const hasAudioVideo = audio.length > 0 && video.length > 0;
    const peerCreatedAfterReset = session.tagJoin.lastPeerCreatedAt >= session.tagJoin.lastResetAt;
    const candidateNames = Array.from(new Set(
      video
        .map((record) => String(session.participantNames.get(record.streamId) || '').trim())
        .filter((name) => name && name !== 'unknown')
    ));
    const suggestedName = candidateNames.length === 1 ? candidateNames[0] : '';
    const existingAssigned = suggestedName ? findAssignedByDomName(session, suggestedName) : null;
    const hasDistinctSuggestedName = !!(suggestedName && !existingAssigned);
    // Trigger video-only when name is new (distinct) OR when peer was created but no name yet.
    // Do NOT trigger on peerCreatedAfterReset alone when the detected name is already a known
    // participant — that is a rejoin, not a new student.
    const videoOnlyFallback = session.tagJoin.savedCount > 0 &&
      audio.length === 0 &&
      video.length > 0 &&
      (hasDistinctSuggestedName || (peerCreatedAfterReset && !suggestedName)) &&
      stableForMs >= TAG_JOIN_VIDEO_ONLY_MS;
    const ready = (hasAudioVideo && stableForMs >= TAG_JOIN_SETTLE_MS) || videoOnlyFallback;

    let status = 'waiting';
    if (streams.length === 0) status = 'waiting';
    // Only call it a refresh (not a new student) when there's no strong "new student" signal.
    // peerCreatedAfterReset is reliable: tab switches reuse the existing PC; new students create one.
    else if (audio.length === 0 && video.length > 0 && !peerCreatedAfterReset && !hasDistinctSuggestedName) status = 'replacement-video';
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
      peerCreatedAfterReset,
      suggestedName,
      hasDistinctSuggestedName,
      timedOut: hasTimedOut,
      savedCount: session.tagJoin.savedCount
    };
  }

  function assignNameToStreams(session, tabId, streamIds, name) {
    const owner = getOrCreateOwner(session, name);
    for (const sid of streamIds) {
      const record = session.streamRecords.get(sid);
      if (record) {
        record.assignedName = name;
        record.ownerId = owner ? owner.ownerId : undefined;
      }
      if (owner && !owner.streamIds.includes(sid)) owner.streamIds.push(sid);
      if (owner) session.streamToOwner.set(sid, owner.ownerId);
      session.participantNames.set(sid, name);
      session.manuallyNamed.add(sid);
      queueEvent(tabId, 'participant-renamed', { streamId: sid, name, ownerId: owner?.ownerId });
      chrome.tabs.sendMessage(tabId, {
        target: 'hook',
        type: 'set-participant-name',
        payload: { streamId: sid, name }
      }).catch(() => {});
    }
  }

  function findAssignedParticipantByName(session, name) {
    const target = normalizeName(name);
    if (!target) return null;
    for (const record of session.streamRecords.values()) {
      if (normalizeName(record.assignedName) === target) {
        return record;
      }
    }
    return null;
  }

  // Like findAssignedParticipantByName but also resolves through the owner's DOM identity.
  // Handles renames: 'Ducchuy' tagged as 'Huy Tablet' → owner.domName='Ducchuy', owner.name='Huy Tablet'.
  // On rejoin, DOM sends 'Ducchuy' → findOwnerByDomName matches → returns any assigned stream for that owner.
  function findAssignedByDomName(session, domName) {
    const direct = findAssignedParticipantByName(session, domName);
    if (direct) return direct;
    const owner = findOwnerByDomName(session, domName);
    if (!owner) return null;
    for (const streamId of owner.streamIds) {
      const record = session.streamRecords.get(streamId);
      if (record && record.assignedName) return record;
    }
    return null;
  }

  function createOwner(session, name, domName) {
    const ownerId = `student-${++session.ownerCounter}`;
    const record = { ownerId, name, domName: domName || name, streamIds: [] };
    session.ownerRecords.set(ownerId, record);
    return record;
  }

  function getOrCreateOwner(session, name, domName) {
    const target = normalizeName(name);
    if (!target) return null;
    for (const o of session.ownerRecords.values()) {
      if (normalizeName(o.name) === target) return o;
    }
    return createOwner(session, name, domName);
  }

  // Find an owner whose Meet DOM display name matches — used for rejoin detection.
  // Handles renames: student 'Ducchuy' tagged as 'Huy Tablet' still has domName='Ducchuy'.
  function findOwnerByDomName(session, domName) {
    const target = normalizeName(domName);
    if (!target) return null;
    for (const o of session.ownerRecords.values()) {
      if (normalizeName(o.domName || o.name) === target) return o;
    }
    return null;
  }

  function maybeShowToast(session, tabId) {
    if (session.toast.shown || session.toast.suppressed) return;
    const candidate = getTagJoinCandidate(session);
    if (!candidate.ready) return;
    session.toast.shown = true;
    chrome.tabs.sendMessage(tabId, {
      type: 'show-tag-toast',
      candidate: {
        suggestedName: candidate.suggestedName || '',
        streamIds: candidate.streamIds,
        videoOnly: candidate.videoOnly
      }
    }).catch(() => {});
  }

  function scheduleToastChecks(session, tabId) {
    // Check at increasing delays: candidate needs TAG_JOIN_SETTLE_MS (1.5s) to become ready,
    // and DOM scan runs every 2s — so spread checks to catch both timing paths.
    [2000, 4000, 7000, 12000].forEach((delay) => {
      setTimeout(() => {
        if (!sessions.has(tabId)) return;
        maybeShowToast(session, tabId);
      }, delay);
    });
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
        remoteAudioTracks: session.trackStats.remoteAudioTracks.size,
        remoteVideoTracks: session.trackStats.remoteVideoTracks.size,
        localAudioTracks: session.trackStats.localAudioTracks.size,
        localVideoTracks: session.trackStats.localVideoTracks.size
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
      console.error(`[Meet Capture] Upload error (${API_URL}):`, e);
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
          const record = session.streamRecords.get(streamId);
          const existingAssigned = findAssignedByDomName(session, name);
          if (record &&
              !record.assignedName &&
              existingAssigned &&
              record.kind === 'video' &&
              record.mediaRole === 'student-video') {
            // Use the previously assigned name (handles renames: DOM sends 'Ducchuy' but
            // the mentor had renamed them to 'Huy Tablet' — preserve that manual name).
            const resolvedName = existingAssigned.assignedName || name;
            assignNameToStreams(session, tabId, [streamId], resolvedName);
            // Rejoin auto-assign: dismiss any prematurely shown toast and free the slot
            // so the next genuinely new student can be detected normally.
            session.tagJoin.savedCount += 1;
            session.tagJoin.lastResetAt = Date.now();
            session.toast.shown = false;
            session.toast.suppressed = false;
            chrome.tabs.sendMessage(tabId, { type: 'hide-tag-toast' }).catch(() => {});
          } else {
            // DOM scan just found a name — candidate may now be ready with a suggestedName
            setTimeout(() => maybeShowToast(session, tabId), 500);
          }
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
        // Store the DOM display name as the owner's stable identity so rejoins are recognised
        // even if the mentor gave a different label (e.g. 'Ducchuy' tagged as 'Huy Tablet').
        const savedOwner = getOrCreateOwner(session, name);
        if (savedOwner && candidate.suggestedName) {
          savedOwner.domName = candidate.suggestedName;
        }
        session.tagJoin.savedCount += 1;
        session.tagJoin.lastResetAt = Date.now();
        session.toast.shown = false;
        session.toast.suppressed = false;
        chrome.tabs.sendMessage(tabId, { type: 'hide-tag-toast' }).catch(() => {});
        sendResponse({ ok: true, assignedStreamIds: candidate.streamIds });
        return true;
      }

      if (request.type === 'toast-skipped') {
        const session = getSession(tabId);
        session.toast.shown = false;
        session.toast.suppressed = true;
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'force-upload') {
        const session = getSession(tabId);
        uploadBatch(session);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'clear-session') {
        const session = getSession(tabId);
        if (session.uploadQueue.length > 0) {
          sendResponse({ ok: false, error: 'queue-not-empty' });
          return true;
        }
        session.sessionId = `session-${new Date().toISOString().replace(/[:.]/g, '-')}-tab-${tabId}`;
        session.events = [];
        session.participantNames = new Map();
        session.manuallyNamed = new Set();
        session.streamRecords = new Map();
        session.ownerRecords = new Map();
        session.streamToOwner = new Map();
        session.ownerCounter = 0;
        session.tagJoin = { lastResetAt: Date.now(), savedCount: 0, lastPeerCreatedAt: 0 };
        session.toast = { shown: false, suppressed: false };
        session.trackStats = {
          remoteAudioTracks: new Set(),
          remoteVideoTracks: new Set(),
          localAudioTracks: new Set(),
          localVideoTracks: new Set()
        };
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

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (typeof changeInfo.url !== 'string') return;
    if (!changeInfo.url.startsWith('https://meet.google.com/')) return;

    const existing = sessions.get(tabId);
    if (!existing) return;

    const nextMeetingId = extractMeetingId(changeInfo.url);
    if (nextMeetingId === existing.meetingId) return;

    const leavingActiveMeeting = isActiveMeetingId(existing.meetingId) && !isActiveMeetingId(nextMeetingId);
    const switchingMeetings = isActiveMeetingId(existing.meetingId) && isActiveMeetingId(nextMeetingId);
    const enteringFirstMeeting = !isActiveMeetingId(existing.meetingId) && isActiveMeetingId(nextMeetingId);

    if (leavingActiveMeeting || switchingMeetings || enteringFirstMeeting) {
      rotateSessionForTab(tabId, tab?.url || changeInfo.url).catch((err) => {
        console.error('[Meet Capture] Failed to rotate session:', err);
      });
      return;
    }

    existing.meetingId = nextMeetingId;
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
