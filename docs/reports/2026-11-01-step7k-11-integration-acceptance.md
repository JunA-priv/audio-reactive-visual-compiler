# Step 7k-11 — Integrated Acceptance Verification

**Status: partial.** Automated contract and build checks were run. The required browser/GPU, actual playback, WebM, and performance acceptance could not be completed in this environment.

## Environment

- Frontend: Node/npm toolchain available.
- Python Island: repository `.venv` available.
- Go: `/usr/local/go/bin/go` available. Go build cache was redirected to `/tmp` because the default user cache is read-only in this environment.
- Media inspection: `ffmpeg` and `ffprobe` available.
- Not available: Chrome/Chromium, Firefox, WebGL2 browser runtime, standalone GLSL compiler. No Playwright/Puppeteer browser installation was found.

## Effect and Audio Source results

The Frontend suite passed across all 20 Effect kinds and includes renderer/editor/validator, binding, region geometry, deterministic seek, and Project/Cloud contract tests. This establishes automated command and persistence contract coverage, not human visual acceptance of each Effect.

The seven source values (`kick.events`, `snare.events`, `bass.envelope`, `drums.energy`, `vocals.envelope`, `other.envelope`, `music.energy`) remain covered by existing enum/schema and renderer tests. No live browser interaction was available to verify changing each source and observing it during playback.

| Area | Automated result | Manual/runtime result |
|---|---|---|
| 20 Effect kinds, Editor and renderer contracts | Frontend suite passed (137 tests) | Individual visual appearance not inspected |
| 7 Audio Sources and event/continuous contracts | Covered by existing tests and schema checks | Live source response not exercised |
| Region / deterministic evaluation | Existing geometry, clip, and seek tests passed | Stage/Rectangle/Polygon pixels not inspected |
| Ink WebGL2 shader, lifecycle, compositing | Source/command contract tests passed | Shader compile/link, context loss, resize and GPU pixels unverified |
| Project / Cloud v1 | Existing roundtrip tests passed in Frontend and Go contract packages | No manual editor save/reload session |

## Demo assets

`demo-assets/source/` contains all three MP3s. Feature Timeline and Spectrum sidecars are present, as are the published-local `frontend/public/demo/` copies. `ffprobe` reported:

| Demo | Audio duration | Timeline duration | Difference | Spectrum |
|---|---:|---:|---:|---|
| demo1 | 180.240s | 180.200s | 40ms | 32 bands, 20ms hop, 9,010 frames / 180.200s |
| demo2 | 166.080s | 166.040s | 40ms | 32 bands, 20ms hop, 8,302 frames / 166.040s |
| demo3 | 118.080s | 118.054s | 26ms | 32 bands, 20ms hop, 5,903 frames / 118.060s |

The Spectrum frame counts are derived from the quantized byte count divided by 32 bands; their duration is consistent with the Timeline within a 20ms frame. Audio was not played in a browser, so load, pause/resume, seek, end-of-track handling, and audible/visual synchronization are unverified. Demo publication approval and asset gates were not changed.

## Preview, WebM, and performance

The shared `renderEditorFrame` code path and its automated tests remain in place. No browser was available to render a Preview or produce a WebM. Therefore GPU Ink inclusion, visual Preview/WebM equality, encoded playback, Codec/FPS/resolution/duration, audio synchronization, and Effect ordering in encoded pixels remain unverified. No FPS, frame-time percentile, GPU/CPU load, memory, or export-time measurement was taken. `ffprobe` was used only to inspect source audio durations; no WebM file was generated.

## Test results

- Frontend `npm test -- --run` — passed, 137 tests across 12 files.
- Frontend `npm run typecheck` — passed.
- Frontend `npm run lint` — passed.
- Frontend `npm run build` — passed.
- Python `python -m pytest -q` (repository venv) — passed, 27 tests.
- Python `mypy --strict` — passed.
- Python `ruff check src tests` — reports 16 E501 line-length findings across unchanged Python source/test files. `ruff check --ignore E501 src tests` passes. No Python file was changed for this task.
- Go `go test ./...` — packages before `internal/service` passed; the service suite stops at `TestOpenAIResponsesRequestUsesStrictStructuredOutput` because `httptest.NewServer` cannot bind `[::1]` in the sandbox (`operation not permitted`).
- Go targeted Blueprint/Project tests and selected service schema/Timeline tests — passed.
- Go `go vet ./...` — passed.
- `git diff --check` — passed.

## Bugs and changes

No new product defect was confirmed from the checks available, so no implementation code was changed. Only task/status documentation and this report were updated. No API, DB, Auth, Hosted, dependency, Python, OpenAI runtime, or Effect behavior changes were made; no GitHub push was performed.

## Remaining acceptance work

Run the 20-Effect visual matrix in a WebGL2-capable browser, exercise all seven sources with the three Demo tracks, verify Ink polygon clipping/opacity/gradient and context lifecycle in actual pixels, export and play audio/video WebM, and record FPS/frame time/resource usage. Re-run the full Go suite in an environment that permits IPv6 loopback binding. Review or baseline the existing Ruff E501 findings separately.
