(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

  function buildSessionId(tabId) {
    return `session-${new Date().toISOString().replace(/[:.]/g, '-')}-tab-${tabId}`;
  }

  function extractMeetingId(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'meet.google.com') {
        const match = u.pathname.match(/\/[a-z]{3}-[a-z]{4}-[a-z]{3}/) ||
                      u.pathname.match(/\/[a-z\-]+/);
        return match ? match[0].substring(1) : 'unknown';
      }
    } catch (e) {}
    return 'unknown';
  }

  function isActiveMeetingId(meetingId) {
    return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(String(meetingId || ''));
  }

  function resetSessionState(session, tabId) {
    session.sessionId = buildSessionId(tabId);
    session.events = [];
    session.participantNames = new Map();
    session.manuallyNamed = new Set();
    session.streamRecords = new Map();
    session.ownerRecords = new Map();
    session.streamToOwner = new Map();
    session.ownerCounter = 0;
    session.attendanceCandidates = new Map();
    session.tagJoin = { lastResetAt: Date.now(), savedCount: 0, lastPeerCreatedAt: 0 };
    session.toast = { shown: false, suppressed: false };
    session.trackStats = {
      remoteAudioTracks: new Set(),
      remoteVideoTracks: new Set(),
      localAudioTracks: new Set(),
      localVideoTracks: new Set()
    };
    session.uploadQueue = [];
    session.uploadTimer = null;
    session.lastUploadTime = 0;
  }

  function createSession(context, tabId, url) {
    const session = {
      tabId,
      sessionId: buildSessionId(tabId),
      meetingId: extractMeetingId(url),
      mentorLabel: context.savedMentorLabel || '',
      capturedParticipants: [],
      participantNames: new Map(),
      manuallyNamed: new Set(),
      streamRecords: new Map(),
      ownerRecords: new Map(),
      streamToOwner: new Map(),
      ownerCounter: 0,
      attendanceCandidates: new Map(),
      tagJoin: {
        lastResetAt: Date.now(),
        savedCount: 0,
        lastPeerCreatedAt: 0
      },
      toast: {
        shown: false,
        suppressed: false,
      },
      trackStats: {
        remoteAudioTracks: new Set(),
        remoteVideoTracks: new Set(),
        localAudioTracks: new Set(),
        localVideoTracks: new Set()
      },
      events: [],
      uploadQueue: [],
      uploadTimer: null,
      lastUploadTime: 0
    };
    context.sessions.set(tabId, session);
    return session;
  }

  function getSession(context, tabId) {
    if (context.sessions.has(tabId)) {
      return context.sessions.get(tabId);
    }

    const session = createSession(context, tabId, 'unknown');

    if (tabId && tabId > 0) {
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab && tab.url) {
          const activeSession = context.sessions.get(tabId);
          if (activeSession && activeSession.meetingId === 'unknown') {
            activeSession.meetingId = extractMeetingId(tab.url);
            console.log('[Meet Capture] Updated meeting ID:', activeSession.meetingId);
          }
        }
      });
    }

    return session;
  }

  async function rotateSessionForTab(context, tabId, url) {
    const existing = context.sessions.get(tabId);
    if (existing) {
      await context.upload.uploadBatch(existing);
      if (existing.uploadTimer) {
        clearTimeout(existing.uploadTimer);
      }
      context.sessions.delete(tabId);
    }
    return createSession(context, tabId, url);
  }

  root.sessionStore = {
    buildSessionId,
    extractMeetingId,
    isActiveMeetingId,
    resetSessionState,
    createSession,
    getSession,
    rotateSessionForTab
  };
})();
