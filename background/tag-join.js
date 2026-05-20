(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

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
    const candidateNames = Array.from(new Set(
      video
        .map((record) => String(session.participantNames.get(record.streamId) || '').trim())
        .filter((name) => name && name !== 'unknown')
    ));
    const suggestedName = candidateNames.length === 1 ? candidateNames[0] : '';
    const existingAssigned = suggestedName ? context.mapping.findAssignedByDomName(session, suggestedName) : null;
    const hasDistinctSuggestedName = !!(suggestedName && !existingAssigned);
    const videoOnlyFallback = hasVideo && stableForMs >= context.constants.TAG_JOIN_SETTLE_MS;
    const ready = hasVideo && stableForMs >= context.constants.TAG_JOIN_SETTLE_MS;

    let status = 'waiting';
    if (streams.length === 0) status = 'waiting';
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
      audioStreamIds: audio.map((stream) => stream.streamId),
      videoStreamIds: video.map((stream) => stream.streamId),
      audioCount: audio.length,
      videoCount: video.length,
      firstSeenAt: streams.length > 0 ? streams[0].firstSeenAt : null,
      lastSeenAt: lastSeenAt || null,
      stableForMs,
      settleMs: context.constants.TAG_JOIN_SETTLE_MS,
      videoOnlyMs: context.constants.TAG_JOIN_VIDEO_ONLY_MS,
      videoOnly: videoOnlyFallback,
      peerCreatedAfterReset,
      suggestedName,
      hasDistinctSuggestedName,
      timedOut: hasTimedOut,
      savedCount: session.tagJoin.savedCount
    };
  }

  function buildAttendanceCandidateId(session, candidate) {
    const base = [
      session.meetingId || 'unknown',
      candidate.firstSeenAt || Date.now(),
      (candidate.streamIds || []).join('-'),
      candidate.suggestedName || 'unknown'
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

  function maybeEmitAttendanceCandidate(context, session, tabId, candidate) {
    const attendanceCandidate = buildAttendanceCandidate(session, candidate);
    if (!attendanceCandidate) return;
    if (session.attendanceCandidates.has(attendanceCandidate.candidateId)) return;
    session.attendanceCandidates.set(attendanceCandidate.candidateId, attendanceCandidate);
    context.messages.queueEvent(context, tabId, 'attendance-candidate', attendanceCandidate);
  }

  function maybeShowToast(context, session, tabId) {
    const candidate = getTagJoinCandidate(context, session);
    if (!candidate.ready) return;
    maybeEmitAttendanceCandidate(context, session, tabId, candidate);
  }

  function scheduleToastChecks(context, session, tabId) {
    void context;
    void session;
    void tabId;
  }

  root.tagJoin = {
    getTagJoinCandidate,
    buildAttendanceCandidateId,
    buildAttendanceCandidate,
    maybeEmitAttendanceCandidate,
    maybeShowToast,
    scheduleToastChecks
  };
})();
