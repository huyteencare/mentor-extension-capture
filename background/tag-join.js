(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};
  const identity = root.identityModel;

  function getTagJoinCandidate(context, session) {
    const streams = Array.from(session.streamRecords.values())
      .filter((record) => {
        if (record.assignedName) return false;
        if (record.firstSeenAt < session.tagJoin.lastResetAt) return false;
        if (record.mediaRole === 'mentor-audio') return false;
        if (record.mediaRole === 'shared-audio') return false;
        if (record.trackSource === 'local') return false;

        const detectedName = String(session.participantNames.get(record.streamId) || '').trim();
        const existingAssigned = detectedName
          ? context.mapping.findAssignedByDomName(session, detectedName)
          : null;
        if (record.kind === 'video' && existingAssigned) {
          return false;
        }

        return true;
      })
      .sort((a, b) => a.firstSeenAt - b.firstSeenAt);

    const audio = streams.filter((stream) => stream.kind === 'audio');
    const video = streams.filter((stream) => stream.kind === 'video');
    const streamIds = streams.map((stream) => stream.streamId);
    const now = Date.now();
    const lastSeenAt = streams.length > 0 ? Math.max(...streams.map((stream) => stream.lastSeenAt)) : 0;
    const stableForMs = lastSeenAt ? now - lastSeenAt : 0;
    const hasTimedOut = streams.length > 0 && now - session.tagJoin.lastResetAt > context.constants.TAG_JOIN_TIMEOUT_MS;
    const hasVideo = video.length > 0;
    const peerCreatedAfterReset = session.tagJoin.lastPeerCreatedAt >= session.tagJoin.lastResetAt;
    const firstSeenAt = streams.length > 0 ? streams[0].firstSeenAt : null;
    const candidateNames = Array.from(new Set(
      video
        .map((record) => String(session.participantNames.get(record.streamId) || '').trim())
        .filter((name) => name && name !== 'unknown')
    ));
    const suggestedName = candidateNames.length === 1 ? candidateNames[0] : '';
    const suggestedNameMeta = suggestedName
      ? video
        .map((record) => session.participantNameMeta.get(record.streamId))
        .find((meta) => meta && meta.name === suggestedName)
      : null;
    const existingAssigned = suggestedName ? context.mapping.findAssignedByDomName(session, suggestedName) : null;
    const hasDistinctSuggestedName = !!(suggestedName && !existingAssigned);
    const nameWaitExpired = !!firstSeenAt && now - firstSeenAt >= context.constants.TAG_JOIN_NAME_WAIT_MS;
    const isReplacementVideo = audio.length === 0 && video.length > 0 && !peerCreatedAfterReset && !hasDistinctSuggestedName;
    const videoOnlyFallback = hasVideo && stableForMs >= context.constants.TAG_JOIN_SETTLE_MS && nameWaitExpired && !isReplacementVideo;
    const ready = hasVideo &&
      stableForMs >= context.constants.TAG_JOIN_SETTLE_MS &&
      (hasDistinctSuggestedName || nameWaitExpired) &&
      (!isReplacementVideo || hasTimedOut);
    const candidateJoinKey = identity.buildCandidateJoinKey({
      firstSeenAt,
      streamIds,
      videoStreamIds: video.map((stream) => stream.streamId)
    });
    const provisionalParticipantKey = identity.buildProvisionalParticipantKey({
      suggestedName,
      candidateJoinKey
    });

    let status = 'waiting';
    if (streams.length === 0) status = 'waiting';
    else if (isReplacementVideo) status = 'replacement-video';
    else if (!hasDistinctSuggestedName && !nameWaitExpired) status = 'waiting-name';
    else if (videoOnlyFallback) status = 'ready-video-only';
    else if (audio.length === 0) status = 'waiting-audio';
    else if (video.length === 0) status = 'waiting-video';
    else if (!ready) status = 'settling';
    else status = 'ready';

    return {
      status,
      ready,
      streamIds,
      audioStreamIds: audio.map((stream) => stream.streamId),
      videoStreamIds: video.map((stream) => stream.streamId),
      audioCount: audio.length,
      videoCount: video.length,
      firstSeenAt,
      lastSeenAt: lastSeenAt || null,
      stableForMs,
      settleMs: context.constants.TAG_JOIN_SETTLE_MS,
      nameWaitMs: context.constants.TAG_JOIN_NAME_WAIT_MS,
      videoOnlyMs: context.constants.TAG_JOIN_VIDEO_ONLY_MS,
      videoOnly: videoOnlyFallback,
      peerCreatedAfterReset,
      suggestedName,
      displayName: identity.displayNameOrUnknown(suggestedName),
      candidateJoinKey,
      provisionalParticipantKey,
      canonicalIdentityType: null,
      canonicalIdentityValue: null,
      displayNameSource: suggestedNameMeta?.source || 'unknown',
      displayNameConfidence: suggestedNameMeta?.confidence || 'low',
      hasDistinctSuggestedName,
      nameWaitExpired,
      timedOut: hasTimedOut,
      savedCount: session.tagJoin.savedCount
    };
  }

  function buildAttendanceCandidateId(session, candidate) {
    const base = [
      session.meetingId || 'unknown',
      candidate.candidateJoinKey || identity.buildCandidateJoinKey(candidate) || Date.now()
    ].join('::');
    return base.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 240);
  }

  function buildAttendanceCandidate(session, candidate) {
    if (!candidate?.ready || !Array.isArray(candidate.streamIds) || candidate.streamIds.length === 0) {
      return null;
    }

    const participantDisplayName = String(candidate.suggestedName || '').trim();
    const hasConfidentName =
      !!participantDisplayName &&
      candidate.videoCount === 1 &&
      candidate.streamIds.length <= 2;
    const matchType = hasConfidentName ? 'confident_present' : 'mismatch_review';
    const confidence = hasConfidentName ? (candidate.videoOnly ? 0.82 : 0.98) : candidate.videoOnly ? 0.45 : 0.58;

    return {
      candidateId: buildAttendanceCandidateId(session, candidate),
      matchType,
      confidence,
      participantDisplayName: participantDisplayName || 'unknown',
      displayName: identity.displayNameOrUnknown(candidate.displayName || participantDisplayName),
      displayNameSource: String(candidate.displayNameSource || '').trim() || 'unknown',
      displayNameConfidence: String(candidate.displayNameConfidence || '').trim() || 'low',
      provisionalParticipantKey: candidate.provisionalParticipantKey || identity.buildProvisionalParticipantKey({
        suggestedName: participantDisplayName,
        candidateJoinKey: candidate.candidateJoinKey || identity.buildCandidateJoinKey(candidate)
      }),
      canonicalIdentityType: null,
      canonicalIdentityValue: null,
      joinObservedAt: new Date(candidate.firstSeenAt || Date.now()).toISOString(),
      leaveObservedAt: null,
      evidence: {
        streamIds: candidate.streamIds,
        audioStreamIds: candidate.audioStreamIds || [],
        videoStreamIds: candidate.videoStreamIds || [],
        audioCount: candidate.audioCount || 0,
        videoCount: candidate.videoCount || 0,
        videoOnly: !!candidate.videoOnly,
        stableForMs: candidate.stableForMs || 0,
        peerCreatedAfterReset: !!candidate.peerCreatedAfterReset
      }
    };
  }

  function buildAttendanceFingerprint(session, candidate) {
    return buildAttendanceCandidateId(session, candidate);
  }

  function shouldIgnoreReplacementCandidate(session, candidate) {
    if (!candidate || candidate.status !== 'replacement-video') return false;
    const fingerprint = buildAttendanceFingerprint(session, candidate);
    return !!(fingerprint && session.ignoredReplacementFingerprints.has(fingerprint));
  }

  function mergeAttendanceCandidateIdentity(session, candidateId, patch) {
    if (!candidateId || !patch) return null;
    const existing = session.attendanceCandidates.get(candidateId);
    if (!existing) return null;
    const next = { ...existing, ...patch };
    session.attendanceCandidates.set(candidateId, next);
    return next;
  }

  function maybeEmitAttendanceCandidate(context, session, tabId, candidate) {
    const candidateCheck = {
      meetingId: session.meetingId || 'unknown',
      tabId,
      status: candidate?.status || 'none',
      ready: !!candidate?.ready,
      streamIds: candidate?.streamIds || [],
      audioCount: candidate?.audioCount || 0,
      videoCount: candidate?.videoCount || 0,
      stableForMs: candidate?.stableForMs || 0,
      suggestedName: candidate?.suggestedName || '',
      provisionalParticipantKey: candidate?.provisionalParticipantKey || '',
      nameWaitExpired: !!candidate?.nameWaitExpired,
      hasDistinctSuggestedName: !!candidate?.hasDistinctSuggestedName,
      peerCreatedAfterReset: !!candidate?.peerCreatedAfterReset,
      timedOut: !!candidate?.timedOut
    };
    console.log('[Meet Capture] Tag join candidate check', candidateCheck);
    context.debugLog.logIdentityDebug(context, 'candidate-check', {
      source: 'background/tag-join',
      meetingId: session.meetingId || 'unknown',
      sessionId: session.sessionId,
      tabId,
      provisionalParticipantKey: candidate?.provisionalParticipantKey || null,
      participantDisplayName: candidate?.suggestedName || null,
      payload: candidateCheck
    });
    const attendanceCandidate = buildAttendanceCandidate(session, candidate);
    if (!attendanceCandidate) {
      context.debugLog.logIdentityDebug(context, 'candidate-skipped', {
        source: 'background/tag-join',
        meetingId: session.meetingId || 'unknown',
        sessionId: session.sessionId,
        tabId,
        provisionalParticipantKey: candidate?.provisionalParticipantKey || null,
        participantDisplayName: candidate?.suggestedName || null,
        payload: {
          reason: 'not-ready-or-empty',
          status: candidate?.status || 'none',
          ready: !!candidate?.ready,
          streamIds: candidate?.streamIds || []
        }
      });
      return;
    }
    const fingerprint = buildAttendanceFingerprint(session, candidate);
    if (fingerprint && session.emittedAttendanceFingerprints.has(fingerprint)) {
      context.debugLog.logIdentityDebug(context, 'candidate-skipped', {
        source: 'background/tag-join',
        meetingId: session.meetingId || 'unknown',
        sessionId: session.sessionId,
        tabId,
        candidateId: attendanceCandidate.candidateId,
        provisionalParticipantKey: attendanceCandidate.provisionalParticipantKey,
        participantDisplayName: attendanceCandidate.participantDisplayName,
        payload: {
          reason: 'fingerprint-already-emitted',
          fingerprint
        }
      });
      return;
    }
    if (session.attendanceCandidates.has(attendanceCandidate.candidateId)) {
      context.debugLog.logIdentityDebug(context, 'candidate-skipped', {
        source: 'background/tag-join',
        meetingId: session.meetingId || 'unknown',
        sessionId: session.sessionId,
        tabId,
        candidateId: attendanceCandidate.candidateId,
        provisionalParticipantKey: attendanceCandidate.provisionalParticipantKey,
        participantDisplayName: attendanceCandidate.participantDisplayName,
        payload: {
          reason: 'candidate-id-already-known'
        }
      });
      return;
    }
    session.attendanceCandidates.set(attendanceCandidate.candidateId, attendanceCandidate);
    if (fingerprint) session.emittedAttendanceFingerprints.add(fingerprint);
    context.probeDebug.upsertIdentityProbeDebug(session, attendanceCandidate, {
      probeStatus: 'pending',
      lastProbedAt: new Date().toISOString()
    });
    console.log('[Meet Capture] Attendance candidate emitted', {
      meetingId: session.meetingId || 'unknown',
      candidateId: attendanceCandidate.candidateId,
      participantDisplayName: attendanceCandidate.participantDisplayName,
      provisionalParticipantKey: attendanceCandidate.provisionalParticipantKey,
      joinObservedAt: attendanceCandidate.joinObservedAt,
      streamIds: attendanceCandidate.evidence?.streamIds || [],
      confidence: attendanceCandidate.confidence,
      matchType: attendanceCandidate.matchType
    });
    context.debugLog.logIdentityDebug(context, 'candidate-emitted', {
      source: 'background/tag-join',
      meetingId: session.meetingId || 'unknown',
      sessionId: session.sessionId,
      tabId,
      candidateId: attendanceCandidate.candidateId,
      provisionalParticipantKey: attendanceCandidate.provisionalParticipantKey,
      participantDisplayName: attendanceCandidate.participantDisplayName,
      payload: {
        status: candidate?.status || 'none',
        ready: !!candidate?.ready,
        streamIds: attendanceCandidate.evidence?.streamIds || [],
        confidence: attendanceCandidate.confidence,
        matchType: attendanceCandidate.matchType,
        fallbackJoinKey: attendanceCandidate.participantDisplayName === 'unknown' ? attendanceCandidate.provisionalParticipantKey : null
      }
    });
    context.messages.queueEvent(context, tabId, 'attendance-candidate', attendanceCandidate);
  }

  function maybeShowToast(context, session, tabId) {
    const candidate = getTagJoinCandidate(context, session);
    if (candidate.status === 'replacement-video') {
      const replacementFingerprint = buildAttendanceFingerprint(session, candidate);
      if (shouldIgnoreReplacementCandidate(session, candidate)) {
        context.debugLog.logIdentityDebug(context, 'replacement-candidate-ignored', {
          source: 'background/tag-join',
          meetingId: session.meetingId || 'unknown',
          sessionId: session.sessionId,
          tabId,
          provisionalParticipantKey: candidate.provisionalParticipantKey || null,
          participantDisplayName: candidate.suggestedName || null,
          payload: {
            reason: 'already-ignored',
            streamIds: candidate.streamIds
          }
        });
        return;
      }
      context.debugLog.logIdentityDebug(context, 'replacement-candidate-detected', {
        source: 'background/tag-join',
        meetingId: session.meetingId || 'unknown',
        sessionId: session.sessionId,
        tabId,
        provisionalParticipantKey: candidate.provisionalParticipantKey || null,
        participantDisplayName: candidate.suggestedName || null,
        payload: {
          streamIds: candidate.streamIds,
          stableForMs: candidate.stableForMs,
          nameWaitExpired: !!candidate.nameWaitExpired,
          timedOut: !!candidate.timedOut
        }
      });
      const reconciliation = context.mapping.reconcileReplacementCandidate(context, session, tabId, candidate);
      if (reconciliation.matched) {
        context.debugLog.logIdentityDebug(context, 'replacement-reconcile-match', {
          source: 'background/tag-join',
          meetingId: session.meetingId || 'unknown',
          sessionId: session.sessionId,
          tabId,
          provisionalParticipantKey: candidate.provisionalParticipantKey || null,
          participantDisplayName: reconciliation.owner?.displayName || reconciliation.owner?.name || candidate.suggestedName || null,
          canonicalIdentityType: reconciliation.owner?.canonicalIdentityType || null,
          canonicalIdentityValue: reconciliation.owner?.canonicalIdentityValue || null,
          payload: {
            reason: reconciliation.reason,
            streamIds: candidate.streamIds,
            competingOwnerIds: reconciliation.competingOwnerIds || []
          }
        });
        return;
      }
      context.debugLog.logIdentityDebug(context, 'replacement-reconcile-miss', {
        source: 'background/tag-join',
        meetingId: session.meetingId || 'unknown',
        sessionId: session.sessionId,
        tabId,
        provisionalParticipantKey: candidate.provisionalParticipantKey || null,
        participantDisplayName: candidate.suggestedName || null,
        payload: {
          reason: reconciliation.reason,
          streamIds: candidate.streamIds,
          competingOwnerIds: reconciliation.competingOwnerIds || []
        }
      });
      if (candidate.timedOut && replacementFingerprint) {
        session.ignoredReplacementFingerprints.add(replacementFingerprint);
      }
      context.debugLog.logIdentityDebug(context, candidate.timedOut ? 'replacement-candidate-ignored' : 'replacement-candidate-waiting', {
        source: 'background/tag-join',
        meetingId: session.meetingId || 'unknown',
        sessionId: session.sessionId,
        tabId,
        provisionalParticipantKey: candidate.provisionalParticipantKey || null,
        participantDisplayName: candidate.suggestedName || null,
        payload: {
          reason: reconciliation.reason,
          streamIds: candidate.streamIds,
          competingOwnerIds: reconciliation.competingOwnerIds || [],
          timedOut: !!candidate.timedOut
        }
      });
      return;
    }
    if (!candidate.ready) return;
    maybeEmitAttendanceCandidate(context, session, tabId, candidate);
  }

  function scheduleToastChecks(context, session, tabId) {
    if (!session || !tabId) return;
    session.tagJoin.pollUntilAt = Math.max(
      Number(session.tagJoin.pollUntilAt || 0),
      Date.now() + context.constants.TAG_JOIN_POLL_WINDOW_MS
    );
    if (session.tagJoin.pollTimer) return;

    const runCheck = () => {
      session.tagJoin.pollTimer = null;
      const activeSession = context.sessions.get(tabId);
      if (!activeSession || activeSession !== session) return;

      maybeShowToast(context, session, tabId);

      const candidate = getTagJoinCandidate(context, session);
      const fingerprint = buildAttendanceFingerprint(session, candidate);
      const alreadyEmitted = fingerprint && session.emittedAttendanceFingerprints.has(fingerprint);
      const alreadyIgnoredReplacement = shouldIgnoreReplacementCandidate(session, candidate);
      const shouldContinue =
        Date.now() < Number(session.tagJoin.pollUntilAt || 0) &&
        !alreadyEmitted &&
        !alreadyIgnoredReplacement;

      if (!shouldContinue) return;

      session.tagJoin.pollTimer = setTimeout(runCheck, context.constants.TAG_JOIN_POLL_INTERVAL_MS);
    };

    session.tagJoin.pollTimer = setTimeout(runCheck, 0);
  }

  root.tagJoin = {
    getTagJoinCandidate,
    buildAttendanceCandidateId,
    buildAttendanceCandidate,
    buildAttendanceFingerprint,
    mergeAttendanceCandidateIdentity,
    maybeEmitAttendanceCandidate,
    maybeShowToast,
    scheduleToastChecks
  };
})();
