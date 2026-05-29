importScripts(
  'config.js',
  'background/session-store.js',
  'background/identity-model.js',
  'background/probe-debug.js',
  'background/debug-log.js',
  'background/participant-mapping.js',
  'background/tag-join.js',
  'background/upload.js',
  'background/message-handlers.js'
);

(function() {
  'use strict';

  const modules = globalThis.MeetCaptureBackground || {};
  const debugLogsEnabled = modules.debugLog?.isLocalApiUrl(`${API_BASE_URL}/api/capture/batch`) || false;
  const context = {
    constants: {
      API_URL: `${API_BASE_URL}/api/capture/batch`,
      PRESIGN_URL: `${API_BASE_URL}/api/capture/presign`,
      DEBUG_IDENTITY_LOGS_ENABLED: debugLogsEnabled,
      DEBUG_IDENTITY_LOG_URL: debugLogsEnabled ? modules.debugLog.buildDebugLogUrl(`${API_BASE_URL}/api/capture/batch`) : '',
      UPLOAD_INTERVAL_MS: 8000,
      TAG_JOIN_SETTLE_MS: 1500,
      TAG_JOIN_NAME_WAIT_MS: 3500,
      TAG_JOIN_VIDEO_ONLY_MS: 5000,
      TAG_JOIN_TIMEOUT_MS: 30000,
      TAG_JOIN_POLL_INTERVAL_MS: 500,
      TAG_JOIN_POLL_WINDOW_MS: 10000,
      REPLACEMENT_CONTINUITY_WINDOW_MS: 30000
    },
    sessions: new Map(),
    savedMentorLabel: '',
    sessionStore: modules.sessionStore,
    identity: modules.identityModel,
    probeDebug: modules.probeDebug,
    debugLog: modules.debugLog,
    mapping: modules.participantMapping,
    tagJoin: modules.tagJoin,
    upload: modules.upload,
    messages: modules.messages
  };

  console.log('[Meet Capture] Background boot', {
    version: 'attendance-probe-debug-v1',
    apiUrl: context.constants.API_URL,
    presignUrl: context.constants.PRESIGN_URL
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => (
    context.messages.handleMessage(context, request, sender, sendResponse)
  ));

  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = context.sessions.get(tabId);
    if (session) {
      if (session.tagJoin?.pollTimer) {
        clearTimeout(session.tagJoin.pollTimer);
      }
      if (session.uploadTimer) {
        clearTimeout(session.uploadTimer);
      }
      context.upload.uploadBatch(context, session);
      context.sessions.delete(tabId);
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (typeof changeInfo.url !== 'string') return;
    if (!changeInfo.url.startsWith('https://meet.google.com/')) return;

    const existing = context.sessions.get(tabId);
    if (!existing) return;

    const nextMeetingId = context.sessionStore.extractMeetingId(changeInfo.url);
    if (nextMeetingId === existing.meetingId) return;

    const leavingActiveMeeting =
      context.sessionStore.isActiveMeetingId(existing.meetingId) &&
      !context.sessionStore.isActiveMeetingId(nextMeetingId);
    const switchingMeetings =
      context.sessionStore.isActiveMeetingId(existing.meetingId) &&
      context.sessionStore.isActiveMeetingId(nextMeetingId);
    const enteringFirstMeeting =
      !context.sessionStore.isActiveMeetingId(existing.meetingId) &&
      context.sessionStore.isActiveMeetingId(nextMeetingId);

    if (leavingActiveMeeting || switchingMeetings || enteringFirstMeeting) {
      context.sessionStore.rotateSessionForTab(context, tabId, tab?.url || changeInfo.url).catch((err) => {
        console.error('[Meet Capture] Failed to rotate session:', err);
      });
      return;
    }

    existing.meetingId = nextMeetingId;
  });

  chrome.storage.local.get('mentorLabel', (data) => {
    if (data && data.mentorLabel) {
      context.savedMentorLabel = data.mentorLabel;
      console.log('[Meet Capture] Loaded mentor label:', context.savedMentorLabel);
    }
  });
})();
