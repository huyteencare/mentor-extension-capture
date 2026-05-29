(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

  function isLocalApiUrl(apiUrl) {
    try {
      const url = new URL(String(apiUrl || ''));
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    } catch {
      return false;
    }
  }

  function buildDebugLogUrl(apiUrl) {
    const url = new URL(String(apiUrl || ''));
    url.pathname = '/api/debug/identity-log';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  function logIdentityDebug(context, eventName, payload = {}) {
    const entry = {
      at: new Date().toISOString(),
      source: String(payload.source || 'background/unknown'),
      meetingId: payload.meetingId || null,
      sessionId: payload.sessionId || null,
      tabId: Number.isFinite(Number(payload.tabId)) ? Number(payload.tabId) : null,
      event: String(eventName || 'unknown'),
      candidateId: payload.candidateId || null,
      provisionalParticipantKey: payload.provisionalParticipantKey || null,
      participantDisplayName: payload.participantDisplayName || null,
      canonicalIdentityType: payload.canonicalIdentityType || null,
      canonicalIdentityValue: payload.canonicalIdentityValue || null,
      payload
    };

    console.log(`[Identity Debug] ${eventName}`, entry);

    if (!context?.constants?.DEBUG_IDENTITY_LOGS_ENABLED) return;

    fetch(context.constants.DEBUG_IDENTITY_LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    }).catch(() => {
      // Fail open. Console logs stay available if local debug sink is down.
    });
  }

  root.debugLog = {
    isLocalApiUrl,
    buildDebugLogUrl,
    logIdentityDebug
  };
})();
