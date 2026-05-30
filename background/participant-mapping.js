(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};
  const identity = root.identityModel;

  function ensureOwnerRuntimeState(owner) {
    if (!owner) return owner;
    if (!(owner.activeVideoStreamIds instanceof Set)) owner.activeVideoStreamIds = new Set(owner.activeVideoStreamIds || []);
    if (!(owner.recentVideoStreamIds instanceof Set)) owner.recentVideoStreamIds = new Set(owner.recentVideoStreamIds || []);
    owner.lastVideoSeenAt = Number(owner.lastVideoSeenAt || 0);
    owner.lastVideoReplacementWindowAt = Number(owner.lastVideoReplacementWindowAt || 0);
    return owner;
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
      if (!Number.isFinite(existing.trackGeneration)) existing.trackGeneration = 1;
      return;
    }
    session.streamRecords.set(streamId, {
      streamId,
      kind,
      mediaRole: mediaRole || '',
      trackSource: trackSource || '',
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      assignedName: '',
      ownerId: '',
      participantStorageKey: '',
      replacedAt: 0,
      trackGeneration: 1
    });
  }

  function ensureParticipantStorageKey(record, owner, preferredDisplayName) {
    if (!record) return '';
    if (owner) {
      if (!owner.participantStorageKey) {
        const displayName = String(preferredDisplayName || owner.displayName || owner.name || record.assignedName || '').trim();
        const ownerStorageKey = identity.buildParticipantStorageKey({
          displayName,
          canonicalIdentityValue: owner.canonicalIdentityValue || null,
          streamId: record.streamId
        });
        if (ownerStorageKey) {
          owner.participantStorageKey = ownerStorageKey;
        }
      }
      if (owner.participantStorageKey) {
        record.participantStorageKey = owner.participantStorageKey;
        return record.participantStorageKey;
      }
    }
    if (record.participantStorageKey) {
      return record.participantStorageKey;
    }
    return record.participantStorageKey || '';
  }

  function touchStreamActivity(session, streamId, seenAt) {
    const record = session.streamRecords.get(streamId);
    if (!record) return null;
    const observedAt = Number(seenAt || Date.now());
    record.lastSeenAt = observedAt;
    const owner = getOwnerByStreamId(session, streamId);
    if (owner && record.kind === 'video' && record.mediaRole === 'student-video') {
      ensureOwnerRuntimeState(owner);
      owner.activeVideoStreamIds.add(streamId);
      owner.recentVideoStreamIds.add(streamId);
      owner.lastVideoSeenAt = Math.max(Number(owner.lastVideoSeenAt || 0), observedAt);
    }
    return record;
  }

  function findAssignedParticipantByName(session, name) {
    const target = identity.normalizeName(name);
    if (!target) return null;
    for (const record of session.streamRecords.values()) {
      if (identity.normalizeName(record.assignedName) === target) {
        return record;
      }
    }
    return null;
  }

  function findOwnerByDomName(session, domName) {
    const target = identity.normalizeName(domName);
    if (!target) return null;
    for (const owner of session.ownerRecords.values()) {
      ensureOwnerRuntimeState(owner);
      if (identity.normalizeName(owner.domName || owner.name) === target) return owner;
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

  function createOwner(session, name, domName, options = {}) {
    const ownerId = `student-${++session.ownerCounter}`;
    const record = ensureOwnerRuntimeState({
      ownerId,
      name,
      domName: domName || name,
      displayName: options.displayName || domName || name,
      participantStorageKey: options.participantStorageKey || '',
      provisionalParticipantKey: options.provisionalParticipantKey || null,
      canonicalIdentityType: options.canonicalIdentityType || null,
      canonicalIdentityValue: options.canonicalIdentityValue || null,
      streamIds: []
    });
    session.ownerRecords.set(ownerId, record);
    return record;
  }

  function getOrCreateOwner(session, name, domName, options = {}) {
    const target = identity.normalizeName(name);
    if (!target) return null;
    for (const owner of session.ownerRecords.values()) {
      ensureOwnerRuntimeState(owner);
      if (identity.normalizeName(owner.name) === target) {
        if (domName) owner.domName = domName;
        if (options.displayName) owner.displayName = options.displayName;
        if (options.participantStorageKey && !owner.participantStorageKey) owner.participantStorageKey = options.participantStorageKey;
        if (options.provisionalParticipantKey) owner.provisionalParticipantKey = options.provisionalParticipantKey;
        if (options.canonicalIdentityType) owner.canonicalIdentityType = options.canonicalIdentityType;
        if (options.canonicalIdentityValue) owner.canonicalIdentityValue = options.canonicalIdentityValue;
        return owner;
      }
    }
    return createOwner(session, name, domName, options);
  }

  function getOwnerByStreamId(session, streamId) {
    const ownerId = session.streamToOwner.get(streamId);
    return ownerId ? ensureOwnerRuntimeState(session.ownerRecords.get(ownerId) || null) : null;
  }

  function findOwnerByCanonicalIdentity(session, canonicalIdentityType, canonicalIdentityValue) {
    const type = String(canonicalIdentityType || '').trim();
    const value = String(canonicalIdentityValue || '').trim();
    if (!type || !value) return null;
    for (const owner of session.ownerRecords.values()) {
      ensureOwnerRuntimeState(owner);
      if (owner.canonicalIdentityType === type && owner.canonicalIdentityValue === value) {
        return owner;
      }
    }
    return null;
  }

  function getReplacementWindowKey(ownerId, streamId) {
    const normalizedOwnerId = String(ownerId || '').trim();
    const normalizedStreamId = String(streamId || '').trim();
    if (!normalizedOwnerId) return '';
    return normalizedStreamId ? `${normalizedOwnerId}::${normalizedStreamId}` : normalizedOwnerId;
  }

  function openReplacementWindow(session, owner, streamId, seenAt, reason) {
    const runtimeOwner = ensureOwnerRuntimeState(owner);
    if (!runtimeOwner) return null;
    const openedAt = Number(seenAt || Date.now());
    const key = getReplacementWindowKey(runtimeOwner.ownerId, streamId);
    const windowRecord = {
      key,
      ownerId: runtimeOwner.ownerId,
      streamId: String(streamId || '').trim() || null,
      openedAt,
      resolvedAt: 0,
      reason: String(reason || '').trim() || 'continuity'
    };
    runtimeOwner.lastVideoReplacementWindowAt = openedAt;
    if (streamId) {
      runtimeOwner.activeVideoStreamIds.delete(streamId);
      runtimeOwner.recentVideoStreamIds.add(streamId);
    }
    session.replacementWindows.set(key, windowRecord);
    return windowRecord;
  }

  function resolveReplacementWindowsForOwner(session, owner, replacementStreamIds = []) {
    const runtimeOwner = ensureOwnerRuntimeState(owner);
    if (!runtimeOwner) return;
    const resolvedAt = Date.now();
    for (const windowRecord of session.replacementWindows.values()) {
      if (windowRecord.ownerId !== runtimeOwner.ownerId || windowRecord.resolvedAt) continue;
      windowRecord.resolvedAt = resolvedAt;
      if (Array.isArray(replacementStreamIds) && replacementStreamIds.length > 0) {
        windowRecord.replacementStreamIds = replacementStreamIds.map((streamId) => String(streamId));
      }
    }
  }

  function attachStreamsToOwner(context, session, tabId, streamIds, owner, options = {}) {
    if (!owner) return false;
    ensureOwnerRuntimeState(owner);
    const ownerName = owner.name || options.name || '';
    if (!ownerName) return false;
    assignNameToStreams(context, session, tabId, streamIds, ownerName, {
      domName: options.domName || owner.domName || ownerName,
      displayName: options.displayName || owner.displayName || ownerName,
      provisionalParticipantKey: options.provisionalParticipantKey || owner.provisionalParticipantKey || null,
      canonicalIdentityType: owner.canonicalIdentityType || null,
      canonicalIdentityValue: owner.canonicalIdentityValue || null
    });
    resolveReplacementWindowsForOwner(session, owner, streamIds);
    return true;
  }

  function findContinuityOwners(context, session, candidate) {
    if (!candidate || candidate.status !== 'replacement-video') return [];
    const candidateFirstSeenAt = Number(candidate.firstSeenAt || 0);
    const continuityWindowMs = Number(context.constants.REPLACEMENT_CONTINUITY_WINDOW_MS || 0);
    if (!candidateFirstSeenAt || !continuityWindowMs) return [];

    const matches = [];
    for (const owner of session.ownerRecords.values()) {
      const runtimeOwner = ensureOwnerRuntimeState(owner);
      const openWindows = Array.from(session.replacementWindows.values()).filter((windowRecord) => (
        windowRecord.ownerId === runtimeOwner.ownerId &&
        !windowRecord.resolvedAt &&
        candidateFirstSeenAt >= Number(windowRecord.openedAt || 0) &&
        candidateFirstSeenAt - Number(windowRecord.openedAt || 0) <= continuityWindowMs
      ));
      if (openWindows.length === 0) continue;

      const lastWindowAt = Math.max(...openWindows.map((entry) => Number(entry.openedAt || 0)));
      matches.push({
        owner: runtimeOwner,
        reason: 'continuity-window',
        continuityDistanceMs: Math.max(0, candidateFirstSeenAt - lastWindowAt)
      });
    }

    matches.sort((a, b) => a.continuityDistanceMs - b.continuityDistanceMs);
    return matches;
  }

  function reconcileReplacementCandidate(context, session, tabId, candidate) {
    if (!candidate || candidate.status !== 'replacement-video' || !Array.isArray(candidate.streamIds) || candidate.streamIds.length === 0) {
      return { matched: false, reason: 'not-replacement-video' };
    }

    const suggestedName = String(candidate.suggestedName || '').trim();
    if (suggestedName) {
      const ownerByName = findOwnerByDomName(session, suggestedName);
      if (ownerByName) {
        attachStreamsToOwner(context, session, tabId, candidate.streamIds, ownerByName, {
          domName: suggestedName,
          displayName: suggestedName,
          provisionalParticipantKey: ownerByName.provisionalParticipantKey || candidate.provisionalParticipantKey
        });
        return { matched: true, reason: 'dom-name', owner: ownerByName };
      }
    }

    const continuityOwners = findContinuityOwners(context, session, candidate);
    if (continuityOwners.length === 1) {
      const continuityMatch = continuityOwners[0];
      attachStreamsToOwner(context, session, tabId, candidate.streamIds, continuityMatch.owner, {
        displayName: continuityMatch.owner.displayName || continuityMatch.owner.name,
        provisionalParticipantKey: continuityMatch.owner.provisionalParticipantKey || candidate.provisionalParticipantKey
      });
      return {
        matched: true,
        reason: continuityMatch.reason,
        owner: continuityMatch.owner,
        continuityDistanceMs: continuityMatch.continuityDistanceMs
      };
    }
    if (continuityOwners.length > 1) {
      return {
        matched: false,
        reason: 'ambiguous-owner-match',
        competingOwnerIds: continuityOwners.map((entry) => entry.owner.ownerId)
      };
    }

    const ownerByCanonical = findOwnerByCanonicalIdentity(
      session,
      candidate.canonicalIdentityType,
      candidate.canonicalIdentityValue
    );
    if (ownerByCanonical) {
      attachStreamsToOwner(context, session, tabId, candidate.streamIds, ownerByCanonical, {
        displayName: ownerByCanonical.displayName || ownerByCanonical.name,
        provisionalParticipantKey: ownerByCanonical.provisionalParticipantKey || candidate.provisionalParticipantKey
      });
      return { matched: true, reason: 'canonical-identity', owner: ownerByCanonical };
    }

    return { matched: false, reason: 'no-owner-match' };
  }

  function bindCanonicalIdentityToOwner(session, owner, canonicalIdentityType, canonicalIdentityValue) {
    if (!owner) return false;
    const type = String(canonicalIdentityType || '').trim();
    const value = String(canonicalIdentityValue || '').trim();
    if (!type || !value) return false;
    if (owner.canonicalIdentityType === type && owner.canonicalIdentityValue === value) {
      return false;
    }
    owner.canonicalIdentityType = type;
    owner.canonicalIdentityValue = value;
    for (const streamId of owner.streamIds || []) {
      const record = session.streamRecords.get(streamId);
      ensureParticipantStorageKey(record, owner, owner.displayName || owner.name);
    }
    return true;
  }

  function bindCanonicalIdentityFromProbeEntry(session, entry) {
    const canonicalIdentityType = String(entry?.canonicalIdentityType || '').trim();
    const canonicalIdentityValue = String(entry?.canonicalIdentityValue || '').trim();
    if (!canonicalIdentityType || !canonicalIdentityValue) return null;

    let owner = null;
    const streamIds = Array.isArray(entry?.streamIds) ? entry.streamIds.map((streamId) => String(streamId)) : [];
    for (const streamId of streamIds) {
      owner = getOwnerByStreamId(session, streamId);
      if (owner) break;
    }

    if (!owner) {
      const participantDisplayName = String(entry?.participantDisplayName || '').trim();
      if (participantDisplayName) {
        owner = findOwnerByDomName(session, participantDisplayName) || getOrCreateOwner(session, participantDisplayName, participantDisplayName, {
          displayName: participantDisplayName,
          provisionalParticipantKey: entry?.provisionalParticipantKey || null
        });
      }
    }

    if (!owner) return null;
    return bindCanonicalIdentityToOwner(session, owner, canonicalIdentityType, canonicalIdentityValue) ? owner : null;
  }

  function assignNameToStreams(context, session, tabId, streamIds, name, options = {}) {
    const owner = getOrCreateOwner(session, name, options.domName, {
      displayName: options.displayName || name,
      provisionalParticipantKey: options.provisionalParticipantKey || null,
      canonicalIdentityType: options.canonicalIdentityType || null,
      canonicalIdentityValue: options.canonicalIdentityValue || null
    });
    ensureOwnerRuntimeState(owner);
    for (const sid of streamIds) {
      const record = session.streamRecords.get(sid);
      if (record) {
        record.assignedName = name;
        record.ownerId = owner ? owner.ownerId : undefined;
        if (record.kind === 'video' && record.mediaRole === 'student-video') {
          owner.activeVideoStreamIds.add(sid);
          owner.recentVideoStreamIds.add(sid);
          owner.lastVideoSeenAt = Math.max(Number(owner.lastVideoSeenAt || 0), Number(record.lastSeenAt || Date.now()));
        }
        ensureParticipantStorageKey(record, owner, options.displayName || name);
      }
      if (owner && !owner.streamIds.includes(sid)) owner.streamIds.push(sid);
      if (owner) session.streamToOwner.set(sid, owner.ownerId);
      session.participantNames.set(sid, name);
      session.participantNameMeta.set(sid, {
        name,
        source: String(options.displayNameSource || '').trim() || (session.manuallyNamed.has(sid) ? 'manual' : 'unknown'),
        confidence: String(options.displayNameConfidence || '').trim() || (session.manuallyNamed.has(sid) ? 'high' : 'low')
      });
      session.manuallyNamed.add(sid);
      context.messages.queueEvent(context, tabId, 'participant-renamed', {
        streamId: sid,
        name,
        ownerId: owner?.ownerId,
        provisionalParticipantKey: owner?.provisionalParticipantKey || null,
        canonicalIdentityType: owner?.canonicalIdentityType || null,
        canonicalIdentityValue: owner?.canonicalIdentityValue || null
      });
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
      context.debugLog.logIdentityDebug(context, 'existing-owner-match', {
        source: 'background/participant-mapping',
        meetingId: session.meetingId,
        sessionId: session.sessionId,
        tabId,
        participantDisplayName: name,
        payload: {
          reason: 'auto-assign-known-video-stream',
          streamId,
          matchedAssignedName: existingAssigned.assignedName || name
        }
      });
      assignNameToStreams(context, session, tabId, [streamId], existingAssigned.assignedName || name);
    }
  }

  function observeTrackReplacement(session, payload, seenAt) {
    const streamId = String(payload?.streamId || '').trim();
    if (!streamId || String(payload?.kind || '').trim() !== 'video') return null;
    const record = session.streamRecords.get(streamId);
    if (!record) return null;
    record.replacedAt = Number(seenAt || Date.now());
    record.trackGeneration = Number(record.trackGeneration || 1) + 1;
    const owner = getOwnerByStreamId(session, streamId);
    if (!owner) return null;
    return openReplacementWindow(session, owner, streamId, seenAt, 'track-replaced');
  }

  root.participantMapping = {
    observeTrackStats,
    registerStream,
    touchStreamActivity,
    findAssignedParticipantByName,
    findOwnerByDomName,
    findOwnerByCanonicalIdentity,
    findAssignedByDomName,
    createOwner,
    getOrCreateOwner,
    getOwnerByStreamId,
    attachStreamsToOwner,
    reconcileReplacementCandidate,
    bindCanonicalIdentityToOwner,
    bindCanonicalIdentityFromProbeEntry,
    assignNameToStreams,
    maybeAutoAssignKnownVideoStream,
    observeTrackReplacement
  };
})();
