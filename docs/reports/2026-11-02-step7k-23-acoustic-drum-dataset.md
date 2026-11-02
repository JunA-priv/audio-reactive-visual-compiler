# Step 7k-23 — Acoustic Drum Kick Evaluation Dataset

**Status: partial.** The source was decoded and separated with the existing local Demucs pipeline. Stem integrity, detector-derived candidate timestamps, gate diagnostics, and a candidate review file are ready. Audio could not be auditioned in this environment, and source licensing is undocumented. All Kick candidates remain `unverified`; no ground-truth manifest or Precision/Recall/F1 result was produced.

## Input and provenance

- Input: `demo-assets/source/audio-reactive-silent-demo4.mp3`
- File size: 4,584,493 bytes; SHA-256 `4d818bb03aa231cdc1ecfaa1d1e03bb8e2bc6dc09d72478c045231291a80f043`.
- `ffprobe`: MP3, 48,000Hz, stereo, reported stream/container duration 189.984s.
- Python Island decoded 189.960s (8,377,236 frames at 44.1kHz); the Demucs stems have the same frame count and begin at the decoded source origin. The 24ms difference is between MP3 metadata duration and decoded sample duration; no stem offset was introduced.
- The source README does not identify this file or provide its license. License is recorded as `unknown`. Source type is marked `acoustic` per the task input, but could not be independently confirmed by listening.
- The original MP3 was not modified. No external data was downloaded or uploaded.

## Separation and stem validation

The existing Python Island CLI was run once, which reuses the current pinned Demucs path and produces the timeline, summary, metadata, and four stems from that same inference:

- Model: `htdemucs` 4.1.0, CPU, 4 threads, shifts 0, overlap 0.25, deterministic algorithms enabled.
- Checkpoint was already cached and passed the existing SHA-256-prefix validation; full SHA-256 in metadata is `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`.
- `uv run --locked` could not access the shared read-only uv cache; the same existing CLI was run directly from `python-island/.venv` without installing or changing dependencies.
- Separation time 89.974s; total pipeline time 96.835s; peak RSS 1,644.5 MiB.
- All four stems are PCM16 stereo WAV, 44,100Hz, 8,377,236 frames, 189.960s, 33,508,988 bytes each.
- All stem samples are finite and have no full-scale clipped samples. Peak/RMS: drums 0.614197 / 0.078153; bass 0.307312 / 0.045901; other 0.459625 / 0.090776; vocals 0.012695 / 0.000294.

Generated stems:

- `demo-assets/stems/demo4-kick-evaluation/drums.wav`
- `demo-assets/stems/demo4-kick-evaluation/bass.wav`
- `demo-assets/stems/demo4-kick-evaluation/vocals.wav`
- `demo-assets/stems/demo4-kick-evaluation/other.wav`

The existing Python Island also wrote `feature-timeline.json`, `music-summary.json`, and `analysis-metadata.json` under `demo-assets/generated/demo4-kick-evaluation/`. The summary records 138 estimated Kick events; this is detector output, not a labeled count.

## Candidate review data

Created local-only file `demo-assets/generated/demo4-kick-evaluation/kick-candidates-unverified.json` (1,958,422 bytes). It records:

- the source hash, source type assertion, unknown license, stem path, time range 0–189,960ms, and the no-audio-review state;
- 2,925 positive-score local-maximum candidate frames, all marked `labelClass: candidate` and `reviewStatus: unverified`;
- current detector disposition, strength if accepted, score, low-band energy, sub/body ratio, 80ms decay ratio, and gate results for each candidate;
- 138 events accepted by the current detector and 2,787 candidates rejected or merged by at least one current condition;
- no confirmed Kick labels, negative labels, or ambiguous labels. They are intentionally empty because no human audio review occurred.

Candidate extraction is detector-derived and therefore has self-selection bias: it can omit acoustic events that do not create a local maximum in this detector's score. The candidate file has no `kickOnsetsMs` key and is not a Step 7k-22 evaluation manifest. No evaluation manifest was created, to prevent unverified candidates from being passed as truth labels.

## Baseline and gate diagnostics

The detector output was recomputed on the saved PCM16 `drums.wav`. All 138 event times match the pipeline Timeline exactly. Strength arrays are aligned; their values differ by at most 0.000032 after writing/re-reading the PCM16 stem because the pipeline Timeline was extracted from the pre-quantized Demucs array. The candidate file's stored strengths match the re-read WAV evaluation. This is a consistency check, not ground-truth accuracy.

Because labels are unverified, the Step 7k-22 evaluation CLI was **not** run and TP/FP/FN, Precision, Recall, F1, onset accuracy, missed-Kick counts, and Snare/Tom/Bass false-positive counts are unavailable.

For diagnostic review only, the current candidate trace had 2,925 positive-score local peaks. Overlapping gate-failure counts among those peaks were:

| Gate | Candidate peaks failing |
|---|---:|
| Adaptive score threshold | 2,117 |
| Low-band floor | 1,474 |
| Sub/body ratio ≥ 0.70 | 2,082 |
| 80ms decay ≤ 0.50 | 1,649 |
| 120ms merge suppression | 30 |

Counts overlap and must not be summed as unique candidates. Local-maximum failures are zero by construction here because the review set contains local maxima only. Single-gate-disabled output event counts were: baseline 138; adaptive threshold disabled 281; low-band floor disabled 144; local-maximum gate disabled 307; sub/body ratio disabled 484; decay gate disabled 171; 120ms merge disabled 168. These are changes in candidate output volume only, **not** accuracy or improvement measurements.

The detector-event strength distribution was min 0.0433, median 0.0992, p90 0.3893, max 1.0. Of 138 events, 69 have strength ≤ 0.1. For a Kick-bound Effect using the common Binding threshold 0.1, those individual event strengths do not clear that threshold. This is a separate possible response reduction from detector misses; it is not a visual/browser result. The current default Spectrum Bars and Ink Diffusion Bindings use `music.energy`, so they are not Kick response tests.

## Evaluation labels and next work

Audio listening was not available in this execution, so no candidate was moved to `confirmed`, `rejected`, or `ambiguous`. Snare/Tom/Bass negative-event labels are also absent. The source rights remain unknown; retain all generated media locally and do not publish or distribute it until rights are confirmed.

Next steps for a human reviewer:

1. Audition the local drums stem alongside the source and inspect the timestamped candidate list. Review a stratified subset across quiet/loud sections and include rejected gate candidates, not only the 138 accepted events.
2. Mark each reviewed event as `confirmed`, `rejected`, or `ambiguous`, and add labeled Snare/Tom/Bass negatives when identifiable. Preserve provenance and review notes.
3. Only after confirmed onset labels exist, create a separate Step 7k-22-compatible manifest containing confirmed Kick timestamps and run the baseline with ±80ms matching.
4. Keep unreviewed candidates separate. If the reviewer confirms this source is not acoustic or cannot establish the source rights, do not use it for the acoustic dataset.

## Compatibility, tests, and changed files

No detector condition, Demucs model/weights, Timeline v1, Audio Analyze API, Frontend Binding, Blueprint/Project/Cloud contract, database, authentication, or dependency was changed. Demo1–demo3 outputs were not changed. The new stem/generated files are ignored by the repository's existing `demo-assets` rules and remain local.

- Python Island full suite: **40 passed**, with one existing `PytestUnknownMarkWarning` for the `integration` marker. No code/tests changed in this task.
- `mypy --strict src`, Ruff (`src tests --ignore E501`), and `git diff --check`: passed.
- Existing `htdemucs` CLI completed successfully and wrote the new target-specific output directories without overwriting prior outputs.
- WAV integrity/format/finite/peak/duration checks: passed for all four stems.
- Candidate file JSON parse, unique timestamp ordering/range, accepted count/strength alignment, exact event timestamp equality to Timeline, and strength quantization delta: checked.
- `git diff --check`: passed.

Changed tracked documentation: this report, `CURRENT_STATE.md`, `OPEN_ISSUES.md`, `TEST_STRATEGY.md`, `CURRENT_TASK.md`, and the `demo-assets/source/README.md`, `demo-assets/stems/README.md`, and `demo-assets/generated/README.md` asset-management notes. New local ignored data: four WAV stems, Python Island Timeline/Summary/metadata, and `kick-candidates-unverified.json`.
