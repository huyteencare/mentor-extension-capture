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

  function slugifyName(name) {
    const value = String(name || '')
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/-+/g, '-')
      .slice(0, 48);
    return value || '';
  }

  function getCanonicalIdentitySuffix(canonicalIdentityValue) {
    const value = String(canonicalIdentityValue || '').trim();
    if (!value) return '';
    const match = value.match(/(\d+)(?!.*\d)/);
    return String(match?.[1] || '').slice(0, 12);
  }

  function getStreamIdSuffix(streamId) {
    return String(streamId || '')
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
  }

  function buildParticipantStorageKey({ displayName, canonicalIdentityValue, streamId }) {
    const slug = slugifyName(displayName);
    if (!slug) return null;
    const canonicalSuffix = getCanonicalIdentitySuffix(canonicalIdentityValue);
    if (canonicalSuffix) return `${slug}__${canonicalSuffix}`;
    const streamSuffix = getStreamIdSuffix(streamId);
    if (streamSuffix) return `${slug}__${streamSuffix}`;
    return slug;
  }

  root.identityModel = {
    normalizeName,
    displayNameOrUnknown,
    buildCandidateJoinKey,
    buildProvisionalParticipantKey,
    buildCanonicalIdentity,
    canonicalIdentityFromProbeDebug,
    slugifyName,
    getCanonicalIdentitySuffix,
    getStreamIdSuffix,
    buildParticipantStorageKey
  };
})();
