# Step 7k-24 — Acoustic Kick Annotation & Evaluation

**Status: partial.** A local-only annotation UI and complete-interval evaluation path were implemented. Automated Python validation passes, but this environment denied loopback socket binding, so the HTTP app could not be started here. No browser interaction or human audio review was performed. No confirmed labels or accuracy metrics were created.

## Tool and data flow

- Start from the repository root with `python-island/.venv/bin/python -m python_island.kick_annotation_server`, then open `http://127.0.0.1:8765/`.
- The server binds only to `127.0.0.1`; it reads the source MP3, `drums.wav`, the unchanged `kick-candidates-unverified.json`, and `feature-timeline.json`. Playback uses the local drums stem. The waveform uses the saved drums peak series; only the visible timeline window is painted, and the candidate list is virtualized.
- Play, pause, stop, seek, interval playback/loop, waveform zoom and horizontal pan are available. Shift-drag creates a review interval. Detector-accepted and rejected/merged candidates have separate marker styles; each candidate exposes score, detected strength and failed gates.
- Candidate labels are `confirmed`, `rejected`, `ambiguous`, or `unverified`. Kick labels can be added at candidate or non-candidate times. Snare/Tom/Bass/Other/Unknown negative events are supported. A manual Kick within ±80ms of a candidate is linked to that candidate to avoid duplicate review rows.
- Annotations are saved separately at `demo-assets/generated/demo4-kick-evaluation/kick-annotations.json`. The schema stores v1, source/stem/candidate SHA-256 values, intervals, event labels and notes. Saves are atomic. A hash mismatch is rejected instead of reopening annotations against different audio.

## Evaluation and interval policy

Only `complete` intervals are eligible. Completion requires the interval to be played through, every candidate in the interval to be classified, no unresolved ambiguous label, and either confirmed Kick labels or an explicit no-Kick confirmation. Intervals cannot overlap. The evaluator additionally requires complete intervals to be separated by at least 160ms at the default ±80ms tolerance.

The evaluator runs the unchanged current detector once on the **full drums stem**, then scores only the complete interval cores. It does not crop the stem: the detector uses clip-global adaptive percentiles, and cropping would change that behavior. Detections up to the configured tolerance outside an interval may match a truth event inside; unmatched detections outside the reviewed core are excluded from FP. Result JSON includes per-interval and aggregate TP/FP/FN, precision/recall/F1, onset error, gate misses, single-gate ablations, and nearest labeled negative-event categories. No metric is produced until a complete interval exists.

The prior Step 7k-22 positional manifest interface remains supported. Annotation evaluation is an additional CLI mode using `--annotations`, `--source`, `--stem`, and `--candidates`. The server invokes that mode and writes `kick-evaluation-results.json` locally.

## Verification

- Python Island full suite: **48 passed**.
- `mypy --strict src`: passed.
- Ruff on changed Python source/tests: passed.
- JavaScript syntax check with Node: passed.
- Candidate fixture integrity: source hash checked at server startup; 2,925 candidate records and 9,498 waveform peak records are the expected input sizes.
- Real HTTP/API smoke test could not run: sandbox rejected `ThreadingHTTPServer` loopback bind with `PermissionError: [Errno 1] Operation not permitted`.
- No Chromium/Chrome/Firefox executable was available. Browser UI, audio playback/seek/loop, visual rendering and pointer interaction remain unverified.
- No human listened to or labeled the audio. All prior candidates remain unverified, and no baseline precision/recall/F1 was calculated.
- `git diff --check`: see final verification; no product Frontend, detector, Demucs, Timeline/API, Blueprint, Project, Cloud, DB, Auth, or Editor files were changed.

## Changed files

- `python-island/src/python_island/kick_annotation_server.py` — loopback-only local HTTP app, asset hash binding, annotation validation and atomic persistence.
- `python-island/tools/kick-annotator/index.html` — standalone Japanese waveform/candidate review UI.
- `python-island/src/python_island/kick_evaluation.py` — opt-in annotation CLI and complete-interval evaluation; legacy manifest mode retained.
- `python-island/tests/test_kick_annotation_server.py`, `python-island/tests/test_kick_evaluation.py` — schema, hash mismatch, persistence, completion gating, interval boundary and baseline checks.
- `python-island/pyproject.toml`, `python-island/README.md` — local command and usage instructions.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TEST_STRATEGY.md` — state and evaluation workflow notes.

## Remaining work

Run the UI on a host where loopback binds are permitted, manually listen to selected representative intervals, label every candidate within each reviewed interval plus missed Kicks and known negatives, mark only fully reviewed intervals complete, then run the baseline evaluator. Confirm the source license before distributing any media or labels. The unverified candidate file and source/stem assets were not changed by this task.
