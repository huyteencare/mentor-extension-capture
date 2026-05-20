(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

  function queueEvent(context, tabId, type, payload) {
    const session = context.sessionStore.getSession(context, tabId);
    const now = Date.now();
    if (type === 'chunk' && payload?.streamId) {
      const ownerId = session.streamToOwner.get(payload.streamId);
      if (ownerId) payload = { ...payload, ownerId };
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
      context.mapping.maybeAutoAssignKnownVideoStream(context, session, tabId, payload.streamId);
      if (payload.mediaRole !== 'mentor-audio') {
        context.tagJoin.scheduleToastChecks(context, session, tabId);
      }
    }

    console.log(`[Meet Capture] Queued event: ${type} (total: ${session.events.length})`);
    context.upload.scheduleUpload(context, session);
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

    return groups;
  }

  function handleParticipantNameDetected(context, tabId, payload, sendResponse) {
    const session = context.sessionStore.getSession(context, tabId);
    const { streamId, name } = payload || {};
    if (streamId && name && !session.manuallyNamed.has(streamId)) {
      session.participantNames.set(streamId, name);
      const record = session.streamRecords.get(streamId);
      const existingAssigned = context.mapping.findAssignedByDomName(session, name);
      if (record &&
          !record.assignedName &&
          record.kind === 'video' &&
          record.mediaRole === 'student-video') {
        const resolvedName = existingAssigned?.assignedName || name;
        context.mapping.assignNameToStreams(context, session, tabId, [streamId], resolvedName);
        const savedOwner = context.mapping.getOrCreateOwner(session, resolvedName, name);
        if (savedOwner) {
          savedOwner.domName = name;
        }
        session.tagJoin.savedCount += 1;
        session.tagJoin.lastResetAt = Date.now();
        session.toast.shown = false;
        session.toast.suppressed = false;
        context.tagJoin.maybeEmitAttendanceCandidate(
          context,
          session,
          tabId,
          context.tagJoin.getTagJoinCandidate(context, session)
        );
      }
    }
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
          request.type === 'peer-created' || request.type === 'hook-installed' ||
          request.type === 'remote-track' || request.type === 'local-track') {
        queueEvent(context, tabId, request.type, request.payload);
        sendResponse({ ok: true });
        return true;
      }

      if (request.type === 'participant-name-detected') {
        return handleParticipantNameDetected(context, tabId, request.payload, sendResponse);
      }

      if (request.type === 'get-session-state') {
        const session = context.sessionStore.getSession(context, tabId);
        const showAll = request.showAll || false;
        sendResponse({
          sessionId: session.sessionId,
          meetingId: session.meetingId,
          mentorLabel: session.mentorLabel,
          participantNames: buildParticipantGroups(session, showAll),
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
        context.mapping.assignNameToStreams(context, session, tabId, streamIds, request.name);
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
        context.mapping.assignNameToStreams(context, session, tabId, candidate.streamIds, name);
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
