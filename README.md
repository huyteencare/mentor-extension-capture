# Meet Capture - Mentor (v2)

A Chrome extension that captures per-student audio and video from Google Meet calls (mentor-side) and uploads them to a local API for playback.

## Build Export

```bash
./build.sh
```

Exported a zip file, which you can drag and drop it to extesion page to install:

chrome://extensions/

## Setup

### 1. Start the API

```bash
https://github.com/huyteencare/meet-capture-mockup-api
```

### 2. Load the extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select `extension-webcam-v2/`

### 3. Record a session

1. Join a Google Meet call
2. Click the extension icon → enter your name (mentor label)
3. Students appear automatically as they join — names are auto-filled from Meet's DOM within 2 seconds
4. Correct any auto-detected names, then click ✓ to confirm
5. Record for 30+ seconds (chunks upload every 8s automatically)
6. Click **Open Viewer** to play back per-student audio/video

## How Recording Works

### RTCPeerConnection interception

`hook.js` runs before any page script (`document_start`, `world: "MAIN"`). It wraps `window.RTCPeerConnection` so every connection Meet creates passes through our code. On each `track` event we create a `MediaRecorder` for that track's `MediaStream`:

- One recorder per `(streamId, kind)` — never duplicates
- Records in 10-second chunks (`recorder.start(10000)`)
- First chunk flagged `initChunk: true` — contains WebM headers required for decoding
- Each chunk encoded as base64 data URL and posted to background

### Participant name detection

Every 2 seconds, `hook.js` scans all `<video>` elements whose `srcObject` matches a captured stream. It walks up the DOM from each video to find a participant tile, then reads `data-participant-name`, `data-self-name`, or nearby text — the same attributes Meet uses to label participant tiles. Noise words (`pin`, `mute`, `mic_off`, icon ligatures) are stripped.

### Stream grouping

A single student in Meet produces multiple `MediaStream` objects — typically one for audio and one for video. The grouping logic in `background.js` uses the auto-detected name as the key: if streams 6666 and d2ab0 both resolve to "Alice", they are grouped into one popup row with `allStreamIds: ['6666', 'd2ab0']`. Saving a name applies it to every stream in the group, so all chunks (audio + video) share the same `participantId` tag.

### Upload batch format

```json
{
  "meetingId": "abc-def-ghi",
  "sessionId": "session-2026-05-12T10-00-00-000Z-tab-123",
  "captureRole": "mentor",
  "mentorLabel": "Teacher Huong",
  "capturedParticipants": [
    { "participantKey": "Alice", "participantName": "Alice" }
  ],
  "events": [
    {
      "type": "chunk",
      "at": 1234567890,
      "payload": {
        "streamId": "6666",
        "participantId": "Alice",
        "kind": "audio",
        "data": "data:audio/webm;codecs=opus;base64,...",
        "initChunk": true,
        "index": 0
      }
    }
  ]
}
```

### Playback

The viewer fetches the session manifest from the API. Each `chunk` event has its WebM data inline (`metadata.data`). The viewer groups chunks by `participantId`, sorts by timestamp, and feeds them into a `MediaSource` + `SourceBuffer` — the browser decodes and plays a continuous stream.

## Debugging

**Background logs** — `chrome://extensions` → this extension → "Inspect views: service worker"

**Hook logs** — F12 on the Meet tab → Console (look for `[Hook]` prefix)

**Check API**
```bash
curl http://localhost:8787/api/sessions | jq '.sessions[0]'
```

## Known Limitations

- **Audio mixing** — Meet may send per-participant audio tracks or a single SFU-mixed track. If mixed, you get combined audio for all students.
- **DOM detection fragility** — name detection relies on Meet's DOM attributes; a Meet UI update can break auto-naming (manual fallback always works).
- **Chunk continuity** — MediaRecorder chunks are not individually seekable; the viewer must always prepend the init chunk before playing non-init chunks.