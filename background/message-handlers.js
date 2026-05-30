(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};
  const identity = root.identityModel;

  function buildManualAttendanceCandidate(session, streamIds, name) {
    const records = (streamIds || [])
      .map((streamId) => session.streamRecords.get(streamId))
      .filter(Boolean);
    if (records.length === 0) return null;

    const audioRecords = records.filter((record) => record.kind === 'audio');
    const videoRecords = records.filter((record) => record.kind === 'video');
    const firstSeenAt = Math.min(...records.map((record) => Number(record.firstSeenAt || Date.now())));
    const lastSeenAt = Math.max(...records.map((record) => Number(record.lastSeenAt || Date.now())));
    const candidateJoinKey = identity.buildCandidateJoinKey({
      firstSeenAt,
      streamIds: records.map((record) => record.streamId),
      videoStreamIds: videoRecords.map((record) => record.streamId)
    });

    return {
      status: 'manual-save',
      ready: true,
      streamIds: records.map((record) => record.streamId),
      audioStreamIds: audioRecords.map((record) => record.streamId),
      videoStreamIds: videoRecords.map((record) => record.streamId),
      audioCount: audioRecords.length,
      videoCount: videoRecords.length,
      firstSeenAt,
      lastSeenAt,
      stableForMs: Math.max(0, Date.now() - lastSeenAt),
      videoOnly: audioRecords.length === 0,
      peerCreatedAfterReset: session.tagJoin.lastPeerCreatedAt >= session.tagJoin.lastResetAt,
      suggestedName: String(name || '').trim(),
      displayName: identity.displayNameOrUnknown(name),
      displayNameSource: 'manual',
      displayNameConfidence: 'high',
      candidateJoinKey,
      provisionalParticipantKey: identity.buildProvisionalParticipantKey({
        suggestedName: name,
        candidateJoinKey
      }),
      hasDistinctSuggestedName: !!String(name || '').trim(),
      nameWaitExpired: true,
      timedOut: false,
      savedCount: session.tagJoin.savedCount
    };
  }

  function updateKnownCandidateIdentity(session, candidateId, candidateShape, resolvedName) {
    if (!candidateId || !resolvedName) return;
    const existing = session.attendanceCandidates.get(candidateId);
    if (existing) {
      session.attendanceCandidates.set(candidateId, {
        ...existing,
        participantDisplayName: resolvedName,
        displayName: resolvedName,
        provisionalParticipantKey: candidateShape?.provisionalParticipantKey || existing.provisionalParticipantKey || null
      });
    }
    root.probeDebug.upsertIdentityProbeDebug(session, {
      candidateId,
      participantDisplayName: resolvedName,
      provisionalParticipantKey: candidateShape?.provisionalParticipantKey || null,
      evidence: { streamIds: candidateShape?.streamIds || [] },
      matchType: 'confident_present'
    }, {
      participantDisplayName: resolvedName,
      provisionalParticipantKey: candidateShape?.provisionalParticipantKey || null,
      lastProbedAt: new Date().toISOString()
    });
  }

  function queueEvent(context, tabId, type, payload) {
    const session = context.sessionStore.getSession(context, tabId);
    const now = Date.now();
    if (type === 'chunk' && payload?.streamId) {
      const chunkSeenAt = Number(payload.chunkEndedAt || payload.chunkStartedAt || now);
      const record = context.mapping.touchStreamActivity(session, payload.streamId, chunkSeenAt);
      const ownerId = session.streamToOwner.get(payload.streamId);
      if (ownerId) {
        const owner = session.ownerRecords.get(ownerId);
        payload = {
          ...payload,
          ownerId,
          participantStorageKey: record?.participantStorageKey || null,
          provisionalParticipantKey: owner?.provisionalParticipantKey || null,
          canonicalIdentityType: owner?.canonicalIdentityType || null,
          canonicalIdentityValue: owner?.canonicalIdentityValue || null
        };
      }
    }
    const event = { type, at: now, payload };
    session.events.push(event);
    session.uploadQueue.push(event);

    context.mapping.observeTrackStats(session, payload);
    if (type === 'peer-created') {
      session.tagJoin.lastPeerCreatedAt = now;
    }

    if ((type === 'track-captured' || type === 'recorder-started') && payload?.streamId) {
      if (payload.mediaRole !== 'mentor-audio' && !session.participantNames.has(payload.streamId)) {
        session.participantNames.set(payload.streamId, '');
      }
      context.mapping.registerStream(session, payload.streamId, payload.kind, now, payload.mediaRole, payload.trackSource);
      context.mapping.touchStreamActivity(session, payload.streamId, now);
      context.mapping.maybeAutoAssignKnownVideoStream(context, session, tabId, payload.streamId);
      if (payload.mediaRole !== 'mentor-audio') {
        context.tagJoin.scheduleToastChecks(context, session, tabId);
      }
    }

    if (type === 'track-replaced' && payload?.streamId) {
      context.mapping.observeTrackReplacement(session, payload, now);
      context.tagJoin.scheduleToastChecks(context, session, tabId);
    }

    console.log(`[Meet Capture] Queued event: ${type} (total: ${session.events.length})`);
    context.upload.scheduleUpload(context, session);
  }

  function findProbeDebugForGroup(session, group) {
    const streamIds = Array.isArray(group?.allStreamIds) ? group.allStreamIds.map((streamId) => String(streamId)) : [];
    const name = String(group?.name || '').trim().toLowerCase();
    const probeEntries = Array.from(session.identityProbeDebug.values());
    const matches = probeEntries.filter((entry) => {
      const entryStreamIds = Array.isArray(entry?.streamIds) ? entry.streamIds.map((streamId) => String(streamId)) : [];
      const streamOverlap = streamIds.some((streamId) => entryStreamIds.includes(streamId));
      const nameMatch = !!name && String(entry?.participantDisplayName || '').trim().toLowerCase() === name;
      return streamOverlap || nameMatch;
    });
    if (matches.length > 0) {
      return root.probeDebug.sortProbeDebugEntries(matches)[0];
    }

    const records = streamIds.map((streamId) => session.streamRecords.get(streamId)).filter(Boolean);
    const hasVideo = records.some((record) => record.kind === 'video');
    const hasAudio = records.some((record) => record.kind === 'audio');

    return {
      candidateId: null,
      participantDisplayName: group?.name || 'unknown',
      provisionalParticipantKey: null,
      canonicalIdentityType: null,
      canonicalIdentityValue: null,
      probeStatus: !hasVideo && hasAudio ? 'manual_fallback' : hasVideo ? 'waiting_auto_probe' : 'unknown',
      participantType: null,
      signedinUserUser: null,
      finalVerdict: null,
      lastProbedAt: null,
      streamIds,
      matchType: !hasVideo && hasAudio ? 'audio_only' : hasVideo ? 'video_waiting' : 'unknown'
    };
  }

  function buildParticipantGroups(session, showAll) {
    const nameToGroup = new Map();
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

    return groups.map((group) => ({
      ...group,
      probeDebug: findProbeDebugForGroup(session, group)
    }));
  }

  function handleParticipantNameDetected(context, tabId, payload, sendResponse) {
    const session = context.sessionStore.getSession(context, tabId);
    const { streamId, name } = payload || {};
    const displayNameSource = String(payload?.source || '').trim() || 'unknown';
    const displayNameConfidence = String(payload?.confidence || '').trim() || 'low';
    if (streamId && name && !session.manuallyNamed.has(streamId)) {
      context.debugLog.logIdentityDebug(context, 'dom-name-detected', {
        source: 'background/message-handlers',
        meetingId: session.meetingId,
        sessionId: session.sessionId,
        tabId,
        participantDisplayName: name,
        payload: { streamId }
      });
      session.participantNames.set(streamId, name);
      session.participantNameMeta.set(streamId, {
        name,
        source: displayNameSource,
        confidence: displayNameConfidence
      });
      const record = session.streamRecords.get(streamId);
      const existingAssigned = context.mapping.findAssignedByDomName(session, name);
      if (existingAssigned) {
        context.debugLog.logIdentityDebug(context, 'existing-owner-match', {
          source: 'background/message-handlers',
          meetingId: session.meetingId,
          sessionId: session.sessionId,
          tabId,
          participantDisplayName: name,
          payload: {
            reason: 'dom-name-detected',
            streamId,
            matchedAssignedName: existingAssigned.assignedName || name
          }
        });
      }
      if (record &&
          !record.assignedName &&
          record.kind === 'video' &&
          record.mediaRole === 'student-video') {
        const manualCandidate = buildManualAttendanceCandidate(session, [streamId], name);
        const resolvedName = existingAssigned?.assignedName || name;
        context.mapping.assignNameToStreams(context, session, tabId, [streamId], resolvedName, {
          domName: name,
          displayName: resolvedName,
          displayNameSource,
          displayNameConfidence,
          provisionalParticipantKey: manualCandidate?.provisionalParticipantKey || null
        });
        const savedOwner = context.mapping.getOrCreateOwner(session, resolvedName, name);
        if (savedOwner) {
          savedOwner.domName = name;
        }
        if (manualCandidate) {
          context.tagJoin.maybeEmitAttendanceCandidate(context, session, tabId, manualCandidate);
          const candidateId = context.tagJoin.buildAttendanceCandidateId(session, manualCandidate);
          context.tagJoin.mergeAttendanceCandidateIdentity(session, candidateId, {
            participantDisplayName: resolvedName,
            displayName: resolvedName,
            provisionalParticipantKey: manualCandidate.provisionalParticipantKey
          });
          updateKnownCandidateIdentity(session, candidateId, manualCandidate, resolvedName);
          context.debugLog.logIdentityDebug(context, 'candidate-upgraded-to-named', {
            source: 'background/message-handlers',
            meetingId: session.meetingId,
            sessionId: session.sessionId,
            tabId,
            candidateId,
            provisionalParticipantKey: manualCandidate.provisionalParticipantKey,
            participantDisplayName: resolvedName,
            payload: {
              trigger: 'dom-name-detected',
              streamIds: manualCandidate.streamIds
            }
          });
        }
        session.tagJoin.savedCount += 1;
        session.tagJoin.lastResetAt = Date.now();
        session.toast.shown = false;
        session.toast.suppressed = false;
      }
      context.tagJoin.scheduleToastChecks(context, session, tabId);
    }
    sendResponse({ ok: true });
    return true;
  }

  function syncProbeResults(context, tabId, request, sendResponse) {
    const session = context.sessionStore.getSession(context, tabId);
    const results = Array.isArray(request.results) ? request.results : [];
    results.forEach((entry) => {
      const candidateId = String(entry?.candidateId || '').trim();
      if (!candidateId) return;
      const currentCandidate = session.attendanceCandidates.get(candidateId);
      const attendanceCandidate = currentCandidate || {
        candidateId,
        participantDisplayName: String(entry?.participantDisplayName || '').trim() || 'unknown',
        provisionalParticipantKey: entry?.provisionalParticipantKey || null,
        evidence: { streamIds: Array.isArray(entry?.streamIds) ? entry.streamIds : [] },
        matchType: 'mismatch_review'
      };
      const nextDebug = root.probeDebug.upsertIdentityProbeDebug(session, attendanceCandidate, entry);
      if (nextDebug?.canonicalIdentityType && nextDebug?.canonicalIdentityValue) {
        const owner = context.mapping.bindCanonicalIdentityFromProbeEntry(session, nextDebug);
        if (owner) {
          context.debugLog.logIdentityDebug(context, 'owner-canonical-identity-bound', {
            source: 'background/message-handlers',
            meetingId: session.meetingId,
            sessionId: session.sessionId,
            tabId,
            candidateId,
            provisionalParticipantKey: nextDebug.provisionalParticipantKey || null,
            participantDisplayName: owner.displayName || owner.name || nextDebug.participantDisplayName,
            canonicalIdentityType: owner.canonicalIdentityType || null,
            canonicalIdentityValue: owner.canonicalIdentityValue || null,
            payload: {
              ownerId: owner.ownerId,
              streamIds: owner.streamIds || []
            }
          });
        }
      }
    });
    sendResponse({ ok: true });
    return true;
  }

  function handleMessage(context, request, sender, sendResponse) {
    try {
      const tabId = request.tabId || sender.tab?.id || 0;

      if (request.type === 'content-ready') {
        context.sessionStore.getSession(context, tabId);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'chunk' || request.type === 'error' ||
          request.type === 'recorder-started' || request.type === 'track-captured' ||
          request.type === 'track-replaced' || request.type === 'peer-created' || request.type === 'hook-installed' ||
          request.type === 'remote-track' || request.type === 'local-track') {
        queueEvent(context, tabId, request.type, request.payload);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'participant-name-detected') {
        return handleParticipantNameDetected(context, tabId, request.payload, sendResponse);
      }

      if (request.type === 'sync-probe-results') {
        return syncProbeResults(context, tabId, request, sendResponse);
      }

      if (request.type === 'get-session-state') {
        const session = context.sessionStore.getSession(context, tabId);
        const showAll = request.showAll || false;
        sendResponse({
          sessionId: session.sessionId,
          meetingId: session.meetingId,
          mentorLabel: session.mentorLabel,
          participantNames: buildParticipantGroups(session, showAll),
          probeDebugEntries: root.probeDebug.sortProbeDebugEntries(Array.from(session.identityProbeDebug.values())),
          tagJoin: context.tagJoin.getTagJoinCandidate(context, session),
          eventCount: session.events.length,
          uploadedSize: 0,
          queueSize: session.uploadQueue.length
        });
        return true;
      }

      if (request.type === 'set-mentor-label') {
        const session = context.sessionStore.getSession(context, tabId);
        session.mentorLabel = request.label;
        chrome.storage.local.set({ mentorLabel: request.label }, () => {
          console.log('[Meet Capture] Saved mentor label:', request.label);
        });
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'set-participant-name') {
        const session = context.sessionStore.getSession(context, tabId);
        const streamIds = request.streamIds || [request.streamId];
        const manualCandidate = buildManualAttendanceCandidate(session, streamIds, request.name);
        context.mapping.assignNameToStreams(context, session, tabId, streamIds, request.name, {
          displayName: request.name,
          displayNameSource: 'manual',
          displayNameConfidence: 'high',
          provisionalParticipantKey: manualCandidate?.provisionalParticipantKey || null
        });
        if (manualCandidate) {
          context.tagJoin.maybeEmitAttendanceCandidate(context, session, tabId, manualCandidate);
          const candidateId = context.tagJoin.buildAttendanceCandidateId(session, manualCandidate);
          context.tagJoin.mergeAttendanceCandidateIdentity(session, candidateId, {
            participantDisplayName: request.name,
            displayName: request.name,
            provisionalParticipantKey: manualCandidate.provisionalParticipantKey
          });
          updateKnownCandidateIdentity(session, candidateId, manualCandidate, request.name);
          context.debugLog.logIdentityDebug(context, 'candidate-upgraded-to-named', {
            source: 'background/message-handlers',
            meetingId: session.meetingId,
            sessionId: session.sessionId,
            tabId,
            candidateId,
            provisionalParticipantKey: manualCandidate.provisionalParticipantKey,
            participantDisplayName: request.name,
            payload: {
              trigger: 'set-participant-name',
              streamIds: manualCandidate.streamIds
            }
          });
        }
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'tag-join-save') {
        const session = context.sessionStore.getSession(context, tabId);
        const name = String(request.name || '').trim();
        const candidate = context.tagJoin.getTagJoinCandidate(context, session);
        if (!name) {
          sendResponse({ ok: false, error: 'missing-name' });
          return true;
        }
        if (candidate.streamIds.length === 0) {
          sendResponse({ ok: false, error: 'candidate-not-ready', candidate });
          return true;
        }
        context.mapping.assignNameToStreams(context, session, tabId, candidate.streamIds, name, {
          displayName: name,
          displayNameSource: 'manual',
          displayNameConfidence: 'high',
          provisionalParticipantKey: candidate.provisionalParticipantKey || null
        });
        const namedCandidate = {
          ...candidate,
          ready: true,
          suggestedName: name,
          displayName: name
        };
        context.tagJoin.maybeEmitAttendanceCandidate(context, session, tabId, namedCandidate);
        const candidateId = context.tagJoin.buildAttendanceCandidateId(session, namedCandidate);
        context.tagJoin.mergeAttendanceCandidateIdentity(session, candidateId, {
          participantDisplayName: name,
          displayName: name,
          provisionalParticipantKey: namedCandidate.provisionalParticipantKey || null
        });
        updateKnownCandidateIdentity(session, candidateId, namedCandidate, name);
        context.debugLog.logIdentityDebug(context, 'candidate-upgraded-to-named', {
          source: 'background/message-handlers',
          meetingId: session.meetingId,
          sessionId: session.sessionId,
          tabId,
          candidateId,
          provisionalParticipantKey: namedCandidate.provisionalParticipantKey || null,
          participantDisplayName: name,
          payload: {
            trigger: 'tag-join-save',
            streamIds: namedCandidate.streamIds
          }
        });
        const savedOwner = context.mapping.getOrCreateOwner(session, name);
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
        const session = context.sessionStore.getSession(context, tabId);
        session.toast.shown = false;
        session.toast.suppressed = true;
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'force-upload') {
        const session = context.sessionStore.getSession(context, tabId);
        context.upload.uploadBatch(context, session);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'clear-session') {
        const session = context.sessionStore.getSession(context, tabId);
        if (session.uploadQueue.length > 0) {
          sendResponse({ ok: false, error: 'queue-not-empty' });
          return true;
        }
        context.sessionStore.resetSessionState(session, tabId);
        sendResponse({ ok: true });
        return true;
      }

      sendResponse({ ok: false });
    } catch (err) {
      console.error('[Meet Capture] Message error:', err);
      try {
        sendResponse({ ok: false, error: err.message });
      } catch (e) {}
    }
  }

  root.messages = {
    queueEvent,
    buildParticipantGroups,
    handleParticipantNameDetected,
    handleMessage
  };
})();
