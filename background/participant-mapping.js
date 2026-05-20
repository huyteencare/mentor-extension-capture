(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

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

  function findOwnerByDomName(session, domName) {
    const target = normalizeName(domName);
    if (!target) return null;
    for (const owner of session.ownerRecords.values()) {
      if (normalizeName(owner.domName || owner.name) === target) return owner;
    }
    return null;
  }

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
    for (const owner of session.ownerRecords.values()) {
      if (normalizeName(owner.name) === target) return owner;
    }
    return createOwner(session, name, domName);
  }

  function assignNameToStreams(context, session, tabId, streamIds, name) {
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
      context.messages.queueEvent(context, tabId, 'participant-renamed', { streamId: sid, name, ownerId: owner?.ownerId });
      chrome.tabs.sendMessage(tabId, {
        target: 'hook',
        type: 'set-participant-name',
        payload: { streamId: sid, name }
      }).catch(() => {});
    }
  }

  function maybeAutoAssignKnownVideoStream(context, session, tabId, streamId) {
    const record = session.streamRecords.get(streamId);
    if (!record || record.assignedName) return;
    if (record.kind !== 'video' || record.mediaRole !== 'student-video') return;

    const name = String(session.participantNames.get(streamId) || '').trim();
    if (!name) return;

    const existingAssigned = findAssignedParticipantByName(session, name);
    if (existingAssigned) {
      assignNameToStreams(context, session, tabId, [streamId], existingAssigned.assignedName || name);
    }
  }

  root.participantMapping = {
    observeTrackStats,
    registerStream,
    normalizeName,
    findAssignedParticipantByName,
    findOwnerByDomName,
    findAssignedByDomName,
    createOwner,
    getOrCreateOwner,
    assignNameToStreams,
    maybeAutoAssignKnownVideoStream
  };
})();
