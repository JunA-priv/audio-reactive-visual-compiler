# Step 7k-24a — Kick Annotation UI Fixes

**Status: partial.** The local annotation server and UI were updated, with Python and JavaScript unit checks passing. No Windows Chrome session was available, and this sandbox denies loopback socket binds; real media range requests and pointer-driven browser interactions remain unverified.

## Audio response reset

The failure occurred while writing an audio response body. When seeking, a browser can cancel an obsolete media request after opening a newer Range request; the resulting socket reset is consistent with that behavior. The available environment had no Chrome and no request trace from the user's session, so the specific Chrome cancellation sequence is a well-supported cause hypothesis, not a reproduced browser finding.

The server now parses single byte ranges, returns `206` with `Content-Range`, `Accept-Ranges`, and the exact `Content-Length`, and returns `416` with `Content-Range: bytes */size` for an unsatisfied range. Unsupported/malformed multi-range requests fall back to a full `200` response. Audio is read and written in 64KiB chunks instead of loading the full WAV/range body into memory. `BrokenPipeError` and `ConnectionResetError` during audio headers/body are treated as client disconnects, with one concise interrupted-response log and a closed writer; unrelated file/stream `OSError` still propagates. A partial response is not reported as successful.

Tests exercise full/partial/unsatisfied response headers through the handler, range parsing, chunk output, short reads, expected disconnects on write/flush, and propagation of unrelated I/O errors. A real HTTP socket test could not run because loopback binding is denied in this environment.

## Candidate review controls

Each virtualized candidate row now has a short-audition button, Kick toggle, and direct `rejected`, `ambiguous`, and `unverified` actions. Audition begins up to 200ms before the candidate and stops 450ms after, clamped to audio bounds. It reuses the single existing AudioElement, replaces any prior audition, displays the active candidate, and leaves labels unchanged. Normal playback, interval playback/loop, audition, and manual seek use distinct playback modes; playback failures are shown in the status area.

The Kick toggle maps any non-confirmed state to `confirmed`, and `confirmed` to `unverified`. Rejected and ambiguous controls never create Kick truth; unresolved candidates remain blocking for interval completion. Label transitions reuse the existing annotation JSON fields and candidate timestamp. An existing unlinked Kick at the same timestamp is linked to the candidate rather than duplicated.

## Waveform drag seek

Pointer handling prioritizes Shift-drag for interval selection, then a 14px playhead hit target for drag seek, then candidate marker selection, and finally regular click seek. Pointer Capture keeps the drag active; `pointercancel`/capture loss clears transient state. Seek time is derived from CSS canvas coordinates and the current zoom/pan range, clamped to the audio duration. AudioElement seeks are throttled to 100ms while dragging, with a final forced seek on pointer-up. A manual seek ends audition and interval-loop playback mode; the Shift interval gesture and view-range pan control remain available.

## Verification

- Python Island full suite: **58 passed**.
- `mypy --strict src`: passed.
- Ruff on changed Python server/test files: passed.
- Node built-in control tests: **9 tests passed** (label toggles/persistence, duplicate linking, audition boundaries, pointer priority, seek clamp/throttle, pointer cancel and audition end).
- Node JavaScript module syntax check: passed.
- `git diff --check`: see final check.
- A real browser and HTTP socket could not be used: no Chromium/Chrome/Firefox binary was available; the prior local bind attempt failed with `PermissionError: [Errno 1] Operation not permitted`.

## Changed files

- `python-island/src/python_island/kick_annotation_server.py` — HTTP Range parsing, bounded streaming, expected disconnect handling.
- `python-island/tools/kick-annotator/index.html` — candidate auditions/actions and playhead drag seeking.
- `python-island/tools/kick-annotator/annotation-controls.mjs` — UI label/audition/pointer helper logic.
- `python-island/tests/test_kick_annotation_server.py` — Range response, abort and I/O error tests.
- `python-island/tests/test_kick_annotator_controls.mjs` — local UI-control logic tests.
- `python-island/README.md`, `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TEST_STRATEGY.md`.

No annotation schema, saved file, candidate data, evaluator, detector, product Editor, API, Timeline, Blueprint, Project, Cloud, DB, Auth, or dependency was changed. Human audio annotation remains outstanding.
