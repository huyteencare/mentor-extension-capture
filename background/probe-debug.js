(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};
  const identity = root.identityModel;

  function sortProbeDebugEntries(entries) {
    return entries.sort((a, b) => String(b?.lastProbedAt || '').localeCompare(String(a?.lastProbedAt || '')));
  }

  function upsertIdentityProbeDebug(session, attendanceCandidate, patch) {
    if (!attendanceCandidate?.candidateId) return null;
    const existing = session.identityProbeDebug.get(attendanceCandidate.candidateId) || {};
    const canonicalIdentity = identity.canonicalIdentityFromProbeDebug(patch);
    const next = {
      candidateId: attendanceCandidate.candidateId,
      participantDisplayName: attendanceCandidate.participantDisplayName || 'unknown',
      provisionalParticipantKey: attendanceCandidate.provisionalParticipantKey || existing.provisionalParticipantKey || null,
      canonicalIdentityType: canonicalIdentity?.type || existing.canonicalIdentityType || null,
      canonicalIdentityValue: canonicalIdentity?.value || existing.canonicalIdentityValue || null,
      probeStatus: 'pending',
      participantType: null,
      signedinUserUser: null,
      finalVerdict: null,
      lastProbedAt: new Date().toISOString(),
      streamIds: attendanceCandidate.evidence?.streamIds || [],
      matchType: attendanceCandidate.matchType || 'mismatch_review',
      ...existing,
      ...patch
    };
    session.identityProbeDebug.set(attendanceCandidate.candidateId, next);
    return next;
  }

  root.probeDebug = {
    sortProbeDebugEntries,
    upsertIdentityProbeDebug
  };
})();
