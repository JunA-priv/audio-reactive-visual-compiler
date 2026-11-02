# Audio Analyze ECONNRESET investigation

**status: partial.** A local cancellation handling defect was fixed and observability improved. The reported ECONNRESET was not reproduced; its initiating cause remains unconfirmed.

## Findings

### Request path

1. `trimAudioToWav` decodes the user file in Web Audio, crops the selected sample frames through `OfflineAudioContext`, and encodes 44.1kHz stereo PCM16 WAV.
2. `analyzeAudioClip` posts one `audio` part using `FormData` and a Bearer token. It leaves multipart `Content-Type`/boundary generation to the browser and uses the caller's `AbortSignal`. There is no frontend analysis timeout.
3. Vite forwards `/api` to `http://127.0.0.1:8080`; no proxy timeout is configured.
4. Go validates multipart/WAV, probes with ffprobe, then runs the configured Python Island executable under a 600-second request context. Go's default `http.Server` is used without a configured write timeout.
5. Python Island decodes using ffmpeg and runs the existing CPU Demucs path. Go discards Python stdout/stderr, validates JSON outputs, and previously logged only coarse failure classes.

### Size and timing

A 60-second 44.1kHz stereo PCM16 WAV is `44 + 60 * 44100 * 2 * 2 = 10,584,044` bytes, before a small multipart envelope. This is below the existing 16MiB whole-request limit. `trimAudioToWav` rejects a WAV file larger than 16MiB, and the 60-second crop limit keeps normal generated clips well below that limit. Limits were not increased.

The Vite Proxy has no configured timeout; the Frontend fetch has no request deadline; Go's analysis timeout is 600 seconds. Therefore a configured timeout mismatch is not supported by the inspected code. The user's exact clip, Vite/Go logs, HTTP response, and process exit/OOM evidence were unavailable, and no live Vite/API pair was running in this workspace. These checks do not establish the initiating cause of the reported event.

The existing Go-to-Python CPU integration test using a 2-second PCM WAV completed successfully through the handler and returned the validated response (7.2 seconds on the final run). This confirms a short normal path only; it does not validate a 60-second or user-provided clip.

## Local defect corrected

When a client disconnects while the multipart WAV is still being read, `receiveSingleWAV` returns a body-read error. The handler previously treated every such error as malformed audio and attempted to send HTTP 422, even when the request context was already canceled. The handler now recognizes canceled request bodies, logs the cancellation stage, cleans up the temporary directory, and returns without attempting a response on the dead connection. This avoids misclassifying client cancellation; it does not prove that cancellation caused the user's incident.

Go diagnostics now record request Content-Length, stage (`receive_audio`, `probe`, or `python`), uploaded byte count where available, and child process exit code/signal. They do not record audio data, filenames/paths, credentials, or stderr. Existing sanitized HTTP errors and all limits remain unchanged.

## Layer and reproduction assessment

| Case | Result |
|---|---|
| Middle-range crop (Frontend unit fixture) | Existing test passes; sample offset/duration checked |
| Beginning/end/short crop | Added fixture checks pass |
| Invalid range | Added rejection tests pass before creating AudioContext |
| Go valid WAV response and temp cleanup | Existing unit test passes |
| Invalid format/duration and oversized request | Existing Go unit tests pass |
| Timeout/cancel/Python failure/invalid output | Existing Go unit tests pass |
| CPU Python Island integration | 2-second synthetic PCM clip passes through Go handler |
| Vite → live Go server request | Not run; API/Vite were not running and sandbox disallows general network access |
| User's failing clip and its Content-Length | Not available |
| OOM/process restart evidence | Not available |

The root error remains unconfirmed. A canceled browser request can result in an upstream proxy write reset, and a rejected/closed upstream request can also surface as a proxy `ECONNRESET`, but neither was shown to be the cause here.

## Changed files

- `api/internal/audioanalysis/handler.go` — safe stage/size/process diagnostics and canceled-body handling.
- `api/internal/audioanalysis/handler_test.go` — cancellation-during-upload regression and exit-code diagnostic test.
- `frontend/src/audio-analysis.test.ts` — beginning, middle, end, short-range, and invalid-range coverage.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md` — investigation status and remaining root-cause uncertainty.

No API response, authentication, quota, timeout, size limit, Blueprint/Timeline/Project/Cloud version, dependency, or Python algorithm changed. No Hosted operation, OpenAI call, or GitHub push occurred.

## Validation

- `npm test -- --run` — passed, 138 tests across 12 files.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `go test -count=1 ./internal/audioanalysis` — passed.
- `ARVC_AUDIO_ANALYSIS_INTEGRATION=1 go test -count=1 -run TestAnalyzeThroughLocalPythonIslandCPU -v ./internal/audioanalysis` — passed (2-second PCM clip).
- `go vet ./internal/audioanalysis` — passed.
- `python -m pytest -q` — passed, 27 tests.
- `mypy --strict` — passed.
- `ruff check src tests` — reports 16 E501 findings in unchanged files. `ruff check --ignore E501 src tests` passes.
- `git diff --check` — passed.

## Remaining work

To identify the user's exact root cause, capture the sanitized new Go request/stage logs and Vite proxy log for one failing attempt, including request Content-Length, HTTP status if returned, elapsed time, and whether the user canceled/navigated away. If a Python process failure is recorded, use its exit code/signal and local OOM/system logs; do not log audio or credentials. Retry the same clip through direct Go and then Vite only in the local environment. Until that evidence exists, status remains partial.

## Follow-up: reported reset recurrence and 60-second reproduction (2026-11-01)

**status: partial.** The local configuration strongly indicates that the analysis route was disabled, and a second, independent 60-second result-file limit was reproduced and fixed. The exact browser → Vite → TCP Go incident still could not be captured in this environment.

### Likely cause of the proxy reset

The local `api/.env` had `API_ADDR=127.0.0.1:8080` but no `AUDIO_ANALYSIS_ENABLED`. The Go server defaults that setting to false and registers `/api/v1/audio/analyze` only when it is explicitly enabled. The documented local startup also requires `AUDIO_ANALYSIS_ENABLED=true`. This missing setting is consistent with a request reaching a live API that immediately returns 404 without consuming the large multipart body; the proxy can then encounter a socket reset while still writing the body. The local ignored `.env` was updated to `AUDIO_ANALYSIS_ENABLED=true`; restart `api/run-local.sh` for it to take effect.

This is a strong configuration-based explanation, not proof of the exact 20:20:20 incident: the old Go process environment and request logs were unavailable, and no live Vite/API pair could be started here. Go now logs startup `addr` and `audio_analysis_enabled`, making route availability explicit. Sanitized request lifecycle logging begins outside the auth handler and records status, Content-Length, elapsed time, and cancellation, without recording audio, credentials, paths, or stderr.

### Upload and CPU analysis reproduction

| Case | Result |
|---|---|
| Generated 60-second 44.1kHz stereo PCM16 WAV | 10,584,044 bytes |
| Multipart request to Go/Echo handler with fake runner | 10,584,294 bytes received; exact WAV bytes observed by runner; HTTP 200 |
| Real CPU Demucs through Go handler, before output-cap fix | Upload and ffprobe succeeded; Python completed in about 34.7s; HTTP 502 because `feature-timeline.json` was 4,348,728 bytes, above the internal 4MiB result-file cap |
| Real CPU Demucs through Go handler, after fix | HTTP 200; 60,000ms Timeline / 6,000 points; about 36.2s total |
| Direct live TCP Go / Vite proxy / actual browser-created MP3 crop | Not run; loopback bind is denied in this execution environment and no live process/browser incident logs were available |

The internal bounded JSON output-file cap was raised from 4MiB to 8MiB based on the measured 4,348,728-byte valid 60-second output. The external whole-request cap remains 16MiB; analysis timeout remains 600 seconds. Auth, quota, request/response schema, and Python processing are unchanged. This 502 was a separate confirmed issue exposed by reproduction; it does not itself explain the observed Vite `write ECONNRESET`.

### Follow-up code and validation

- `api/cmd/server/main.go`: startup diagnostic records listen address and route enable flag.
- `api/internal/audioanalysis/handler.go`: sanitized outer request lifecycle logging; internal Timeline JSON output cap is 8MiB; canceled multipart receive remains treated as cancellation, not malformed audio.
- `api/internal/audioanalysis/handler_test.go`: 10.6MB-class request/byte-integrity test and auth-rejected request lifecycle logging test.
- `api/internal/audioanalysis/handler_integration_test.go`: configurable real CPU integration duration, bounded to 1–60 seconds.
- Local ignored `api/.env`: enabled the analysis route; no secret values were printed or added to version control.

Validation:

- `go test -count=1 -v ./internal/audioanalysis` — passed, including 10,584,294-byte multipart upload test.
- `ARVC_AUDIO_ANALYSIS_INTEGRATION=1 ARVC_AUDIO_ANALYSIS_INTEGRATION_DURATION_SECONDS=60 go test -count=1 -run TestAnalyzeThroughLocalPythonIslandCPU -v ./internal/audioanalysis` — passed after the 8MiB internal output cap adjustment; real CPU path completed in about 36s.
- `npm test -- --run` — passed, 138 tests; typecheck, lint, build passed.
- `python -m pytest -q` — passed, 27 tests; `mypy --strict` passed. Ruff reports 16 pre-existing E501 findings in unchanged files; `ruff check --ignore E501 src tests` passed.
- `/usr/local/go/bin/go test -count=1 ./internal/audioanalysis ./cmd/server` — passed after all code changes.
- `GOCACHE=/tmp/arvc-go-cache /usr/local/go/bin/go vet ./...` — passed after all code changes.
- Live TCP/Vite/browser reproduction remains unavailable; the user's source MP3 and 20:20 process diagnostics were not present.

### Recommended local confirmation

Restart Go API after applying the local `.env` setting and confirm startup log has `audio_analysis_enabled=true`. Then retry once in the local browser while observing sanitized Go request lifecycle logs and Vite output. If the reset persists, compare direct Go and Vite paths for the same local clip; do not raise either request cap or timeout without new evidence.

## Follow-up: 60-second analysis reported still running after 3 minutes (2026-11-01)

**status: partial.** This execution environment did not expose the user's running API, browser, or request logs. Therefore it was not possible to identify the current request stage or confirm a 60-second real-source completion. No process was stopped and no runtime configuration or timeout was changed.

### Read-only runtime snapshot

- `ps -eo pid,ppid,etimes,%cpu,%mem,rss,comm` showed only the current Codex/shell/tool processes in this process namespace; no Go API, Vite, Python, ffmpeg, or Demucs process was visible.
- No API `.log`, stdout, or stderr log files were found under the local `api/` tree.
- `journalctl -k --since '15 minutes ago'` had no matching OOM/Kill/Python/ffmpeg entries. This says nothing about logs outside this isolated environment.
- `ss -ltnp` could not read sockets because netlink access was denied. It does not establish whether the user's API is listening.
- No request-start log, Content-Length, active stage, HTTP response, Python exit code, CPU, or RSS for the user's 3-minute wait was available. The current request's receive/ffprobe/Python/Frontend stage is **unknown**.

This workspace therefore cannot determine whether the reported browser operation was still making progress or stalled. Earlier absence of Vite/API in this sandbox must not be interpreted as evidence that the user's separate local processes are stopped.

### Existing timing evidence and stage visibility

The existing synthetic 60-second WAV and its Python metadata were available for read-only inspection:

| Stage/measurement | Measured value |
|---|---:|
| WAV | 10,584,044 bytes; PCM16, 2-channel, 44,100Hz; 2,646,000 frames; exactly 60s |
| Python total | 33.781s |
| ffmpeg decode | 0.339s |
| Demucs CPU separation | 31.610s |
| Feature extraction | 1.632s |
| Peak RSS | 1,283.8 MiB |
| Output JSON total | 4,350,737 bytes (Timeline 4,348,728; Summary 613; metadata 1,396) |

The earlier Go-handler CPU integration for the same class of 60-second synthetic fixture completed with HTTP 200 in about 36.2s. These values do not characterize the actual MP3 or its browser-generated WAV.

Frontend inspection shows `trimAudioToWav` first calls `file.arrayBuffer()` and `AudioContext.decodeAudioData()` on the entire source MP3, then renders the selected 60-second crop using `OfflineAudioContext`, then constructs the WAV. The UI switches to one generic “trimming and local Demucs analysis” status before these operations and keeps it until the HTTP request and Editor state commit finish. No separate progress/timing is surfaced for MP3 decode, WAV render, or upload. The app's code does not set a fetch timeout; the Go API's analysis timeout remains 600 seconds.

Go logs a request-received event, but successful receive and ffprobe stages are not individually logged. Python `analysis-metadata.json` contains decode, separation, feature, total, and peak RSS metrics, but Go reads it only after Python exits, so it cannot report in-progress stage timing. There is no evidence from this inspection that the 600-second timeout or a deadlock was reached.

### Conclusion and next evidence needed

No root cause for this three-minute wait is established. The previous synthetic fixture completed in roughly 36 seconds, but its CPU separation alone used about 1.28 GiB peak RSS; a different machine load or actual input may take longer, while the broad Frontend status cannot distinguish that from browser decode or a hang. This is a hypothesis only, not a finding about the user's request.

To classify one real attempt without stopping it, capture on the same machine where it runs:

1. Go startup record confirming `addr` and `audio_analysis_enabled=true`.
2. Request start and eventual finish record with Content-Length, status, elapsed time, and cancellation field.
3. While active, process names/elapsed/CPU/RSS for Go and its Python/ffmpeg child tree; do not include command arguments, environment, audio, or tokens.
4. After completion, sanitized `analysis-metadata.json` timing fields (decode, separation, feature extraction, total, peak RSS) or equivalent values from the response.
5. Browser timing boundaries for source decode, offline render, fetch start, and fetch completion, plus generated WAV metadata (size/rate/channels/bit depth/frames), with no audio samples.

No code change was made because the current stage and failure mechanism could not be established. The 60-second WAV fixture remains the only measured input; a browser-produced WAV from the reported MP3 and a completed real-source analysis were unavailable.

### Follow-up validation

- `GOCACHE=/tmp/arvc-go-cache /usr/local/go/bin/go test -count=1 ./internal/audioanalysis` — passed.
- `git diff --check` — passed.
- Existing earlier 60-second real CPU synthetic integration — passed at HTTP 200 (~36.2s); not rerun in this follow-up because no code changed.
- Real browser/API runtime and the user's MP3 crop — unavailable; status remains partial.
