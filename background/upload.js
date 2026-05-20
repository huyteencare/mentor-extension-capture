(function() {
  'use strict';

  const root = globalThis.MeetCaptureBackground = globalThis.MeetCaptureBackground || {};

  function scheduleUpload(context, session) {
    if (session.uploadTimer) return;

    session.uploadTimer = setTimeout(() => {
      uploadBatch(context, session);
    }, context.constants.UPLOAD_INTERVAL_MS);
  }

  function dataUrlToUint8Array(dataUrl) {
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  async function uploadBatch(context, session) {
    if (session.uploadTimer) {
      clearTimeout(session.uploadTimer);
      session.uploadTimer = null;
    }

    if (session.uploadQueue.length === 0) return;

    const queue = session.uploadQueue.slice();
    session.uploadQueue = [];

    const chunkEvents = queue.filter((event) => event.type === 'chunk' && event.payload?.data);
    const otherEvents = queue.filter((event) => !(event.type === 'chunk' && event.payload?.data));

    let directSuccess = false;
    if (chunkEvents.length > 0) {
      try {
        const presignRes = await fetch(context.constants.PRESIGN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meetingId: session.meetingId,
            sessionId: session.sessionId,
            chunks: chunkEvents.map((event) => ({
              eventAt: event.at,
              streamId: event.payload.streamId,
              participantId: event.payload.participantId,
              mediaRole: event.payload.mediaRole,
              kind: event.payload.kind,
              index: event.payload.index,
              mimeType: event.payload.mimeType || 'video/webm',
            }))
          })
        });

        if (!presignRes.ok) throw new Error(`Presign ${presignRes.status}`);
        const { presignedUrls } = await presignRes.json();

        const staged = [];
        await Promise.all(
          chunkEvents.map(async (event, i) => {
            const { storageKey, uploadUrl } = presignedUrls[i];
            const bytes = dataUrlToUint8Array(event.payload.data);
            const putRes = await fetch(uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Type': event.payload.mimeType || 'video/webm' },
              body: bytes
            });
            if (!putRes.ok) throw new Error(`Storage PUT ${putRes.status}`);
            staged.push({ event, storageKey, byteSize: bytes.byteLength });
          })
        );

        for (const { event, storageKey, byteSize } of staged) {
          event.payload = { ...event.payload, data: undefined, storageKey, byteSize };
        }
        directSuccess = true;
      } catch (err) {
        console.warn('[Meet Capture] Direct storage upload failed, falling back to base64:', err.message);
      }
    }

    const commonFields = {
      meetingId: session.meetingId,
      sessionId: session.sessionId,
      captureRole: 'mentor',
      mentorLabel: session.mentorLabel,
      pageUrl: '',
      userAgent: navigator.userAgent,
      capturedParticipants: Array.from(session.participantNames.entries())
        .filter(([id, name]) => {
          const record = session.streamRecords.get(id);
          return name && (!!record?.assignedName || session.manuallyNamed.has(id));
        })
        .map(([id, name]) => ({
          participantKey: id,
          participantName: name,
          mappingConfidence: 'high',
          labelSource: 'manual'
        })),
      manualParticipantOverrides: {},
      trackStats: {
        remoteAudioTracks: session.trackStats.remoteAudioTracks.size,
        remoteVideoTracks: session.trackStats.remoteVideoTracks.size,
        localAudioTracks: session.trackStats.localAudioTracks.size,
        localVideoTracks: session.trackStats.localVideoTracks.size
      },
      uploadAttempts: 1,
      directS3Upload: directSuccess,
      attendanceCandidates: Array.from(session.attendanceCandidates.values()),
    };

    const batch = {
      ...commonFields,
      events: [...otherEvents, ...chunkEvents].map((event) => ({
        type: event.type,
        at: event.at,
        pageUrl: '',
        payload: event.payload
      }))
    };

    try {
      const response = await fetch(context.constants.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch)
      });

      if (response.ok) {
        const result = await response.json();
        session.lastUploadTime = Date.now();
        console.log(`[Meet Capture] Uploaded ${result.savedEventCount} events (direct=${directSuccess})`);

        chrome.tabs.sendMessage(session.tabId, {
          type: 'upload-success',
          savedCount: result.savedEventCount
        }).catch(() => {});
      } else {
        console.warn(`[Meet Capture] Batch upload failed: ${response.status}`);
        session.uploadQueue.unshift(...queue);
      }
    } catch (e) {
      console.error('[Meet Capture] Upload error:', e);
      session.uploadQueue.unshift(...queue);
    }

    if (session.uploadQueue.length > 0) {
      scheduleUpload(context, session);
    }
  }

  root.upload = {
    scheduleUpload,
    dataUrlToUint8Array,
    uploadBatch
  };
})();
