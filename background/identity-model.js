(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

  function normalizeName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function displayNameOrUnknown(name) {
    const value = String(name || '').trim();
    return value || 'unknown';
  }

  function buildCandidateJoinKey(candidate) {
    const firstSeenAt = Number(candidate?.firstSeenAt || 0);
    const videoStreamIds = Array.isArray(candidate?.videoStreamIds) ? candidate.videoStreamIds : [];
    const streamIds = Array.isArray(candidate?.streamIds) ? candidate.streamIds : [];
    const primaryStreamId = String(videoStreamIds[0] || streamIds[0] || '').trim();
    if (!firstSeenAt || !primaryStreamId) return '';
    return `${firstSeenAt}::${primaryStreamId}`;
  }

  function buildProvisionalParticipantKey({ suggestedName, candidateJoinKey }) {
    const normalized = normalizeName(suggestedName);
    if (normalized) return `dom:${normalized}`;
    if (candidateJoinKey) return `join:${candidateJoinKey}`;
    return 'join:unknown';
  }

  function buildCanonicalIdentity(type, value) {
    const normalizedType = String(type || '').trim();
    const normalizedValue = String(value || '').trim();
    if (!normalizedType || !normalizedValue) return null;
    return {
      type: normalizedType,
      value: normalizedValue
    };
  }

  function canonicalIdentityFromProbeDebug(entry) {
    const signedinUserUser = String(entry?.signedinUserUser || '').trim();
    if (signedinUserUser) {
      return buildCanonicalIdentity('signedinUser.user', signedinUserUser);
    }
    return null;
  }

  root.identityModel = {
    normalizeName,
    displayNameOrUnknown,
    buildCandidateJoinKey,
    buildProvisionalParticipantKey,
    buildCanonicalIdentity,
    canonicalIdentityFromProbeDebug
  };
})();
