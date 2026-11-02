# Step 7k-22 — Acoustic Kick Detection Quantitative Evaluation

**Status: partial.** Local evaluation tooling and regression checks are implemented. No labeled acoustic drum recording was available, so acoustic precision/recall, timing accuracy, and real-source gate ablations remain unmeasured. The production detector was not changed.

## Asset investigation

Repository and local project search found three existing generated demo drum stems under `demo-assets/stems/demo1..demo3`. Their source documentation identifies the songs as user-created Suno demo tracks; it does not characterize them as acoustic drum recordings. No manual Kick onset labels or labeled Snare/Tom/Bass negative events were found. The existing Step 7k-11b comparison likewise has no song ground truth. These stems were therefore not scored or described as acoustic evaluation data.

No external audio was downloaded or transmitted. No model or weight was downloaded. The existing synthetic fixtures were used only to validate evaluation mechanics.

## Evaluation tool

Added `python-island/src/python_island/kick_evaluation.py` and the `kick-evaluation` package command. It accepts a local JSON manifest with relative paths to Demucs mixed `drums` stem, mono/stereo PCM16 44.1kHz WAVs, manually labeled `kickOnsetsMs`, provenance (`sourceType`, `license`), and optional categorized `negativeEvents`. The CLI does not run Demucs. Other WAV encodings/rates are rejected explicitly; no resampler or dependency was added.

For each recording and aggregate, the tool reports:

- one-to-one sorted onset matches using inclusive ±80ms by default; `--tolerance-ms` overrides the window;
- TP/FP/FN, Precision/Recall/F1, matched pairs, unmatched timestamps, and signed/absolute onset error summaries;
- categorized FP counts only where an FP overlaps a manually annotated negative event; otherwise it is `unlabeled`;
- candidate score, low-band threshold, sub/body ratio, 80ms decay, local-maximum and 120ms merge outcomes, and nearest rejected candidate for each missed label;
- six offline single-gate ablations: adaptive score, low-band floor, local maximum, sub/body ratio, decay, and merge interval.

The diagnostic implementation mirrors the current detector formula locally and asserts that its baseline event timestamps equal `features.detect_kicks()` before reporting. Public Timeline/API output is not extended. The production `features.py` detector is unchanged.

Example invocation and manifest format are documented in `python-island/README.md`.

## Evaluation results

The tool was exercised on a two-hit synthetic PCM signal matching the existing synthetic Kick waveform. At ±80ms it reported TP=2, FP=0, FN=0, Precision=1.0, Recall=1.0, F1=1.0, with both detections 10ms early. This is a tool smoke test on synthetic data, not an acoustic accuracy result. Each single-gate ablation left this particular fixture unchanged; it does not establish which gate limits acoustic recall.

The prior Step 7k-11b synthetic suite remains the only broader labeled detector evaluation (its reported 10 TP / 0 FP / 0 FN is limited to constructed cases). The three demo counts from that report cannot be treated as real-song precision/recall or acoustic-drum evidence.

## Frontend Binding separation

The `kick.events` path reads `kickEvents` and paired `kickEventStrengths` (legacy timelines without strengths use 1.0). Renderer event strength decays using at least 60ms or the Binding `releaseMs`. `evaluateBinding()` then gates at `threshold`, applies Attack/Release, and multiplies by Binding `strength`. Event Effects also use `boundFeature()`, which returns zero at or below threshold.

Added a renderer regression test proving an event strength of 0.2 is visible with threshold 0.1, becomes zero at thresholds 0.2 and 0.25, and is halved when Binding strength changes from 0.9 to 0.45. Existing tests cover decay after the event. This separates a missing detector event from a detected but attenuated Binding response. It does not measure browser pixels or subjective visual prominence. Song-bound default Effects are not evidence of Kick response; only Effects configured for `kick.events` are relevant.

## Recommended next action

Keep the detector unchanged until the tool is run on a permissioned acoustic kit set with manually labeled Kick onsets and categorized low-frequency negatives. Include soft/hard hits, varied Kick tuning and decay, Kick+Snare/Tom overlap, and negative-only passages. Keep at least one recording held out from any tuning. Compare baseline and each single-gate ablation using per-recording and aggregate metrics plus timing-error distribution. Only then decide whether a gate needs the smallest adjustment; preserve synthetic Snare/Tom/Bass and double-Kick regressions and retain Timeline v1 fields.

For a reported weak visual response, inspect event existence/strength and Binding output at the same timestamp before attributing the issue to detection.

## Tests and checks

- Python full suite: **40 passed**.
- Python `mypy --strict src`: passed.
- Ruff on the new evaluator and tests: passed.
- Ruff across existing `src tests` with existing E501 line-length findings excluded: passed.
- Default Ruff across the whole Python tree reports existing E501 findings in unchanged `cli.py`, `features.py`, `pipeline.py`, and `tests/test_features.py`; no E501 remains in the new evaluator/tests.
- Frontend: **160 tests passed**; typecheck, lint, build passed.
- `git diff --check`: passed.

`mypy --strict src tests` still reports 30 pre-existing missing-annotation/TypedDict errors across `tests/test_features.py`, `tests/test_audio.py`, `tests/conftest.py`, `tests/test_demucs_integration.py`, and `tests/test_cli.py`; no such errors originate in the new evaluator tests. The evaluator source passes strict mypy. No existing tests were removed, skipped, or disabled.

## Changed files

- `python-island/src/python_island/kick_evaluation.py`: offline matching, gate diagnostics, ablations, manifest WAV reader, CLI.
- `python-island/tests/test_kick_evaluation.py`: matching boundary/duplicate tests, baseline parity, deterministic evaluation, manifest and merge tests.
- `python-island/pyproject.toml`: local CLI entry point.
- `python-island/README.md`: manifest and local usage documentation.
- `frontend/src/editor-renderer.test.ts`: Binding threshold/strength response regression.
- `docs/TEST_STRATEGY.md`, `docs/OPEN_ISSUES.md`, `docs/CURRENT_STATE.md`: evaluation tooling and outstanding real-data limitation.
- `CURRENT_TASK.md`: Step 7k-22 status summary.
- This report.

No detector algorithm, Timeline v1, Audio Analyze API, Blueprint/Project/Cloud contract, Demucs model/weights, database, authentication, or dependency was changed. No hosted operation or external API was used. Real acoustic precision/recall and browser visual response remain unconfirmed.
