# Step 7k-24b — Kick Prediction and Candidate Audition

**Status: partial.** Implementation and automated checks completed. Candidate audition and UI operation were not verified in a real browser.

## Candidate audition

Audition now starts at the selected candidate's timestamp and stops at the next strictly later candidate timestamp. The final candidate plays to the source duration. Candidates at the same timestamp are skipped when finding the stop boundary, which avoids zero-length intervals; the interval is bounded to the source and given a positive minimum duration where possible. Switching candidates stops the prior audition and reuses the existing audio element. Audition does not modify labels and remains separate from normal and interval-loop playback.

## Provisional prediction

The baseline uses only the existing candidate disposition: `accepted` means provisional Kick, and all other candidate dispositions mean provisional non-Kick. It intentionally introduces no new threshold or signal feature. For the supplied 2,925 candidates, this yields **138 Kick predictions** and **2,787 non-Kick predictions**. This is a detector-derived initial sorting aid, not an accuracy claim; it cannot find Kicks absent from the candidate set.

The local annotation response/save path derives `candidatePredictions` with `predictionMethod=detector_disposition_v1`, `predictedKick`, `reviewed`, and `finalLabel`. Human decisions remain in the existing `candidateReviews` and take precedence. Existing saved annotations are not rewritten just by loading the session; prediction metadata is persisted only through the existing explicit save path. No annotation schema version change was made. Older annotations without predictions remain readable.

Predictions do not alter the evaluator or interval completion rules. Only human candidate reviews and confirmed Kick onset labels are evaluation inputs. An estimate alone cannot mark an interval complete or contribute to TP/FP/FN, Precision, Recall, or F1. A candidate-free Kick still requires manual annotation.

## Compatibility and scope

The candidate fixture, saved annotation file, detector, Demucs, evaluator contract, product Editor, API, Timeline, Blueprint, Project, and Cloud were not changed. No dependency was added and no external communication was performed.

## Verification

- Python Island suite: **60 passed**.
- Node annotation-control tests: **12 passed**.
- `mypy --strict src`: passed.
- Ruff on changed Python files: passed.
- Annotation UI module syntax check: passed.
- `git diff --check`: passed.
- Real-browser audition/UI behavior: **not verified**; retain partial status.

## Changed files

- `python-island/src/python_island/kick_annotation_server.py` — derive separate prediction metadata without changing review truth or evaluation.
- `python-island/tools/kick-annotator/annotation-controls.mjs` — candidate audition window and review metadata synchronization.
- `python-island/tools/kick-annotator/index.html` — provisional/reviewed state and next-candidate audition UI.
- `python-island/tests/test_kick_annotation_server.py` — prediction separation and human-label preservation.
- `python-island/tests/test_kick_annotator_controls.mjs` — audition boundaries and label state behavior.
- `python-island/tests/test_kick_evaluation.py` — predictions cannot act as evaluation truth.
- `python-island/README.md`, `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TEST_STRATEGY.md` — usage and status documentation.

## Remaining work

A human must listen to and confirm labels for complete intervals before acoustic-drum accuracy can be measured. Real-browser validation of audition switching, stop timing, and playback interaction remains outstanding.
