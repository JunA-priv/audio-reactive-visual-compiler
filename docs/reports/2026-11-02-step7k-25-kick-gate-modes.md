# Step 7k-25 — Kick Detection Gate Modes

**Status: partial.** Gate modes, request propagation, UI and automated validation are complete. Windows Chrome visual acceptance and labeled acoustic accuracy remain unverified.

## Detection modes

The detector still extracts the same 2048-sample FFT bands/features at a 10ms hop and uses the same score formula. Only four existing acceptance gates vary. Values below are `(adaptive score multiplier, adaptive score absolute floor, low-band p65 multiplier, minimum sub/body ratio, maximum 80ms decay ratio)`:

| Mode | Values |
|---|---|
| Off | `(0, 0, 0, 0, 1)`; these four gates are bypassed |
| Soft | `(0.08, 0.035, 0.04, 0.40, 0.90)` |
| Middle | `(0.13, 0.055, 0.08, 0.55, 0.70)` |
| Hard | `(0.18, 0.08, 0.12, 0.70, 0.50)`; preserves the prior detector conditions |

Off still requires positive nonzero score and retains local-maximum selection and the 120ms candidate merge, so silence does not produce events and duplicate peaks are still merged. The gate thresholds are ordered from less to more strict. The same detector implementation is used for all modes; no new detection formula, dependency or Demucs pass was added.

## Audio Analyze API and UI

`POST /api/v1/audio/analyze` accepts an optional multipart text field `kickGateMode=off|soft|middle|hard`. Omission defaults to Hard for existing clients. Unknown/duplicate values and unexpected multipart fields are rejected. The selected value is passed through the Go runner as a fixed Python CLI argument; the CLI independently defaults to Hard and validates the same set. This is an additive request field; success response shape, Feature Timeline v1, `kickEvents` and `kickEventStrengths` are unchanged.

The Editor's new-analysis default is Middle. The selector is placed in section “4 · エフェクト”, below Common Color and above the Effect list. Its state belongs to the Editor, not any Effect. Effect add/delete/type changes preserve the selection. Changing it alone makes no request and does not mutate an existing Timeline; the value is sent only on the next Audio Analyze request. Previously analyzed or loaded Projects are not reanalyzed.

## Demo4 comparison

Ran each mode on the existing `demo-assets/stems/demo4-kick-evaluation/drums.wav` (189.960s, 44.1kHz stereo PCM16), without modifying the source, candidate fixture or saved evaluation data. The supplied labels remain unverified, so these are detector output counts, not accuracy results.

| Mode | Events / paired strengths | Strength min | Median | p90 | Max |
|---|---:|---:|---:|---:|---:|
| Off | 994 | 0.000094 | 0.223223 | 0.689112 | 1.000000 |
| Soft | 647 | 0.018141 | 0.369472 | 0.748848 | 1.000000 |
| Middle | 395 | 0.028778 | 0.351253 | 0.801916 | 1.000000 |
| Hard | 138 | 0.043280 | 0.099156 | 0.389254 | 1.000000 |

Counts are monotonic in the intended strictness order. Onset identities are not strict subsets between modes because the common 120ms merge can select a different local maximum when one mode admits additional peaks. Hard event times match all 138 events in the saved baseline Timeline exactly. Recomputing from the quantized PCM16 stem yields a maximum absolute Strength delta of `0.00003147` versus the earlier Timeline generated from pre-quantized Demucs floats; this is the previously observed PCM quantization difference, not a gate-condition change. For identical input samples, omitted mode and explicit Hard produce identical event/strength tuples.

No Precision, Recall, F1 or claim of weak-Kick improvement is made because human-confirmed labels are unavailable.

## Tests and verification

- Python Island suite: **65 passed**.
- Python `mypy --strict src`: passed.
- Ruff on Python source and tests (`--ignore E501`, existing project convention): passed.
- Frontend: **161 tests passed**, typecheck, lint and production build passed.
- Go `internal/audioanalysis` tests: passed; covers omitted-Hard default, all four values, invalid value rejection, propagation to runner and CLI arguments.
- `go vet ./...`: passed.
- `git diff --check`: passed.

Frontend tests verify Middle default, selector placement, no reanalysis on setting change, state preservation through Effect type/add/delete, and selected mode in the Analyze multipart request. Python tests verify Hard default compatibility, threshold ordering, mode propagation, silence under Off, local maximum/merge output invariants and aligned event strengths.

## Changed files

- `python-island/src/python_island/features.py`, `pipeline.py`, `cli.py` — shared gate configuration and mode plumbing.
- `python-island/tests/test_features.py`, `test_cli.py` — detector and CLI regression tests.
- `api/internal/audioanalysis/handler.go`, `handler_test.go` — optional multipart field validation and Python argv propagation.
- `frontend/src/audio-analysis.ts`, `VisualEditor.tsx` — request field, Middle default and relocated global control.
- `frontend/src/audio-analysis.test.ts`, `visual-editor.test.tsx` — payload and UI state/placement tests.
- `docs/API_CONTRACTS.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md`, `python-island/README.md` — contract, design and status documentation.

No Blueprint, Timeline, Project, Cloud, Renderer, WebM, Auth, DB, Migration, Demucs model or saved analysis data was changed.

## Remaining verification

The UI has not been accepted in a real Windows Chrome session. The demo4 comparison has no human truth labels; effectiveness for weak acoustic Kick and false-positive changes therefore remains undetermined. Existing data is not automatically reanalyzed when the selected mode changes.
