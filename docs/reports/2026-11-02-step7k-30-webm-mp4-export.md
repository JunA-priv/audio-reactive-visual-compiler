# Step 7k-30 — WebM / MP4 video export

**Status: partial.** MP4 selection and export now share the existing Canvas/MediaRecorder renderer and audio mix path. Frontend automated verification passed. No browser or browser automation runtime is available here, so real H.264/AAC availability, MP4 file generation/playback, and audio synchronization were not verified.

## Existing WebM path

`frontend/src/video-export.ts` selects a supported WebM MIME type, captures the export Canvas using `captureStream(fps)`, and renders each frame through `renderEditorFrame`. When audio is included, it decodes the selected local file into Web Audio, connects the source to a `MediaStreamAudioDestinationNode`, and uses `AudioContext.currentTime` as the frame clock. The recorder emits chunks, then the editor downloads the Blob. Canvas/audio tracks and AudioContext are released in `finally`. This shared path remains in use for both formats.

## MP4 implementation

- Silent MP4 candidates explicitly request `video/mp4;codecs="avc1.…"` (H.264/AVC).
- Audio MP4 candidates explicitly request `video/mp4;codecs="avc1.…,mp4a.40.2"` (H.264/AVC + AAC LC).
- `MediaRecorder.isTypeSupported()` is checked separately for silent and audio modes. No base MP4 MIME or non-AAC audio alternative is accepted.
- On stop, the actual Recorder MIME must identify the selected container and required codec(s); the Blob must be nonempty and match the declared MIME. MP4 additionally requires an ISO BMFF `ftyp` box at the file header before it can be returned for `.mp4` download.
- Unsupported combinations disable MP4 in the Export selector and disable export if the user changes the audio mode after selecting MP4. MP4 errors do not fall back to WebM.
- The default remains WebM. Filenames use `.webm` or `.mp4` according to the verified selected format.

録画開始、録画中エラー、停止例外、空出力、Recorder MIME不一致、MP4 container signature mismatch are surfaced as failures. `finally` cleanup continues to stop all unique MediaStream tracks, disconnect/stop audio source, and close AudioContext.

## Compatibility and changed files

The Preview/Export shared `renderEditorFrame`, Canvas capture cadence, audio clock, local audio decode, FPS/resolution choices, WebM MIME selection, Blueprint/Timeline/Project contracts, Renderer, and saved format are unchanged. No dependency, server encoder, FFmpeg conversion, API, database, or authentication change was made.

- `frontend/src/video-export.ts` — MP4 MIME selection/validation and shared export format path; existing `exportWebM` remains available.
- `frontend/src/VisualEditor.tsx` — WebM/MP4 selector, codec support state, format-specific dispatch and extension.
- `frontend/src/video-export.test.ts` — support, audio mode, MP4 MIME/container, recorder failure, and cleanup tests.
- `frontend/src/visual-editor.test.tsx` — default format, support-dependent selection, and exporter dispatch.
- `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/CURRENT_STATE.md`, `CURRENT_TASK.md` — export contract, automated coverage, status.

## Verification

- Frontend full suite: **177 tests passed** (13 files).
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check`: passed.
- MP4 mock tests confirm requested H.264/AAC MIME, audio/no-audio track composition, correct container signature gate, and refusal of WebM data masquerading as MP4.
- Environment inspection found no Chrome/Chromium/Firefox executable and no installed Playwright/Puppeteer runtime. The optional browser adapter entry in the lockfile is not installed/configured as a browser test runtime.

## Remaining acceptance

In a browser with MediaRecorder support, test both silent and audio MP4 modes, then inspect the files with `ffprobe` for MP4 container, H.264 video, AAC audio (when enabled), duration, and playback. Also compare the same Timeline/Effect and audio clock against WebM. The test mocks verify selection/validation logic, not actual encoder support, MP4 bytes, visual quality, or AV synchronization.
