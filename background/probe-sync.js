(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};
  const PROBE_SYNC_ALARM_PREFIX = 'meet-capture-probe-sync-tab-';

  function buildAlarmName(tabId) {
    return `${PROBE_SYNC_ALARM_PREFIX}${tabId}`;
  }

  function ensureProbeSyncState(session, tabId) {
    if (!session.probeSync || typeof session.probeSync !== 'object') {
      session.probeSync = {
        alarmName: buildAlarmName(tabId),
        pollUntilAt: 0,
        isSyncing: false
      };
    } else if (!session.probeSync.alarmName) {
      session.probeSync.alarmName = buildAlarmName(tabId);
    }
    return session.probeSync;
  }

  function clearProbeSync(context, session, tabId) {
    const state = ensureProbeSyncState(session, tabId);
    state.pollUntilAt = 0;
    state.isSyncing = false;
    chrome.alarms.clear(state.alarmName, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Meet Capture] Failed to clear probe sync alarm:', chrome.runtime.lastError.message);
      }
    });
  }

  function isPendingProbeEntry(entry) {
    const probeStatus = String(entry?.probeStatus || '').trim();
    return !probeStatus || probeStatus === 'pending' || entry?.retryScheduled === true;
  }

  function hasPendingProbeEntries(session) {
    return Array.from(session.identityProbeDebug.values()).some(isPendingProbeEntry);
  }

  function applyProbeResults(context, session, tabId, results, source = 'background/probe-sync') {
    const entries = Array.isArray(results) ? results : [];
    entries.forEach((entry) => {
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
            source,
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
  }

  async function fetchProbeResults(context, session) {
    const response = await fetch(
      `${context.constants.SESSION_DETAIL_URL_BASE}/${encodeURIComponent(session.sessionId)}`
    );
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Session ${response.status}`);
    const data = await response.json();
    return Array.isArray(data?.session?.identityProbeResults) ? data.session.identityProbeResults : [];
  }

  function schedule(context, session, tabId, options = {}) {
    if (!session?.sessionId || !tabId) return;
    const state = ensureProbeSyncState(session, tabId);
    state.pollUntilAt = Math.max(
      Number(state.pollUntilAt || 0),
      Date.now() + context.constants.PROBE_SYNC_WINDOW_MS
    );
    const delayMs = options.immediate ? 1 : context.constants.PROBE_SYNC_POLL_INTERVAL_MS;
    chrome.alarms.create(state.alarmName, { when: Date.now() + delayMs });
  }

  async function handleAlarm(context, alarm) {
    const alarmName = String(alarm?.name || '');
    if (!alarmName.startsWith(PROBE_SYNC_ALARM_PREFIX)) return false;

    const tabId = Number(alarmName.slice(PROBE_SYNC_ALARM_PREFIX.length));
    if (!Number.isFinite(tabId) || tabId <= 0) return true;

    const session = context.sessions.get(tabId);
    if (!session) return true;

    const state = ensureProbeSyncState(session, tabId);
    if (state.isSyncing) {
      schedule(context, session, tabId, { immediate: false });
      return true;
    }

    state.isSyncing = true;
    try {
      const results = await fetchProbeResults(context, session);
      applyProbeResults(context, session, tabId, results);
    } catch (error) {
      console.warn('[Meet Capture] Failed to sync probe results:', error.message);
    } finally {
      state.isSyncing = false;
    }

    const shouldContinue =
      Date.now() < Number(state.pollUntilAt || 0) &&
      hasPendingProbeEntries(session);

    if (shouldContinue) {
      schedule(context, session, tabId, { immediate: false });
    } else {
      clearProbeSync(context, session, tabId);
    }
    return true;
  }

  root.probeSync = {
    applyProbeResults,
    clearProbeSync,
    hasPendingProbeEntries,
    handleAlarm,
    schedule
  };
})();
