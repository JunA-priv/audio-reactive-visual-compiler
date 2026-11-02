# Step 7k-21 — Acoustic Drum Kick Detection Investigation

**status: partial (read-only investigation complete; acoustic real-world accuracy is unverified)**

## Summary

The current Kick detector operates on the mixed Demucs `drums` stem, not an isolated Kick stem. It combines a low-frequency rise score with a sub/body ratio and a fast-decay gate. This was intentionally made conservative in Step 7k-11b to suppress Snare, Tom, and sustained Bass false positives. The available real-song stems do not have manual Kick labels and are not documented as acoustic drum recordings. Consequently they cannot establish that the detector misses acoustic Kicks, nor support precision/recall estimates.

No application code, tests, fixtures, generated analysis data, or public contracts were changed during this read-only investigation. This report is the only new file.

## Current detection path

1. Demucs produces four stems; `extract_features()` passes `stems["drums"]` to `detect_kicks()`.
2. The detector averages channels to mono and computes 2048-sample FFT frames at a 10ms hop (about 46.4ms per frame at 44.1kHz).
3. Per-frame RMS-like energies are measured in 35–80Hz (`sub`), 35–120Hz (`low`), and 100–250Hz (`mid`).
4. A nonnegative `low` rise is compared with the preceding 500ms median plus a floor. The score is `log1p(rise / baseline) × sub/(sub+mid)`.
5. Candidate peaks must pass all of these gates:
   - adaptive score threshold: `max(p85(score) × 0.18, 0.08)`;
   - low-band threshold: `p65(low) × 0.12`;
   - sub/body ratio at least `0.70`;
   - low-band energy 80ms later no more than 50% of candidate-frame energy;
   - local-maximum test and 120ms candidate merge interval.
6. Candidate strengths are normalized by the candidate-score p99 and clamped to 0..1. Event times are frame index × 10ms; there is no explicit onset-time correction.
7. `extract_features()` emits sorted millisecond `kickEvents` and aligned `kickEventStrengths` in Feature Timeline v1.

The FFT windows overlap in time and the event timestamp is the frame start, while each frame includes samples after that timestamp. This establishes temporal smearing and quantization, but not a fixed onset bias. A labeled onset set is needed to measure the actual offset distribution.

## Confirmed facts and causes to investigate

### Confirmed

- Detection uses only the Demucs mixed `drums` stem; the code does not receive a dedicated Kick stem.
- The detector requires energy concentrated in 35–80Hz relative to 100–250Hz, plus a strong rise and a quick 80ms decay. Each is a hard rejection gate.
- Strength is relative to the detected candidates in the same clip, not calibrated to a universal physical loudness.
- Step 7k-11b synthetic labeled tests cover impulse/weak/double Kicks, Kick+Snare, Snare-only, 115Hz Tom-only, sustained Bass, silence, and timing checks. They demonstrated good performance for those constructed cases, not for acoustic recordings.
- Existing demo stems produced 191, 116, and 104 events with the current detector, versus 217, 259, and 220 with the legacy detector. These counts are diagnostic only; the source assets have no manual onset labels and their documentation does not classify them as acoustic recordings.
- The current default bindings use `strength=0.9`, `threshold=0.1`, `attackMs=60`, `releaseMs=260`. These are separate from detector thresholds and are configurable per Effect.

### Plausible, not yet verified for acoustic audio

- An acoustic Kick whose useful energy is concentrated above 80Hz, or whose drum-stem mix has substantial mid-band bleed, may fail the 0.70 sub/body ratio.
- A Kick with a longer low-frequency tail may fail the 80ms / 50% decay gate.
- Soft hits may fail the relative low-band floor or adaptive score gate, especially when the stem has louder events elsewhere.
- Demucs may attenuate or distribute some Kick energy across stems; this detector cannot recover information absent from its `drums` input.

These are hypotheses derived from the implemented gates. No specific miss has been confirmed because no labeled acoustic recording was available for comparison.

## Detector versus Effect response

The signal path has two distinct stages:

1. **Detector:** `kickEvents` and per-event normalized strengths are produced by Python and carried in Timeline v1.
2. **Binding/Effect:** Renderer `rawSourceValue()` selects the latest Kick events and exponentially decays their strength using `max(60ms, releaseMs)`. `evaluateBinding()` then applies the Binding threshold, attack/release follower, and Binding strength. Event-based Effects such as Particle Burst and Shockwave also apply `boundFeature()` to each event; values at or below `binding.threshold` contribute zero.

Therefore, a weak visual response does not by itself prove a missed detector event. It can result from no event, an event strength at/below the Binding threshold, the configured Binding strength/envelope, or Effect-specific influence/visibility/opacity. In the Step 7k-20 initial configuration, Spectrum Bars and Ink Diffusion bind to `music.energy` (`Song`); they do not consume `kick.events` by default. Kick-specific response requires an Effect/source configuration that actually selects Kick.

The most useful next diagnosis is to inspect, at the same timestamp, whether a Timeline Kick event exists, its strength, and the resulting Binding value. This keeps detector misses separate from visual-response tuning without changing the public contract.

## Unlabeled local material review

The three existing local demo stems and their generated Timelines were reviewed through the prior Step 7k-11b comparison report and asset metadata. They are documented as user-created Suno tracks for demo purposes; no acoustic-drum classification, hand-marked onset times, or listening-based acceptance labels are present. Their event counts and strength distributions cannot be interpreted as recall, precision, or evidence of acoustic Kick performance. No external data was sent and no new analysis output was written.

**Detection misses / false positives / timing:** not quantifiable on these songs. The synthetic test set has labels and passes its stated cases, but is not a substitute for acoustic recordings.

## Candidate approaches

| Approach | Fit to current implementation | Main risk / required evidence |
|---|---|---|
| Lower fixed detector gates (ratio, decay, score) | Small code change | Likely trades missed Kicks for low Tom/Bass/Snare bleed; unsupported without labeled acoustic examples. |
| Adaptive thresholds | Some adaptation already exists (preceding median, clip percentiles, p99 strengths) | Existing adaptive values still retain hard ratio/decay gates; adding adaptation can drift by arrangement and clip length. Needs cross-track labels. |
| Low-band spectral flux/onset path | Could complement the existing rise score and capture attacks with different spectra | A second permissive path can increase false positives; it needs a labeled ablation and the same Timeline output contract. |
| Use drum stem plus original mix | Original audio is already available to feature extraction | More bleed and duplicate candidates; requires cross-source matching and labeled tests. It is a broader change than changing a detector gate. |

## Recommended minimal next-step plan

Do not change the detector thresholds based on the current material. The evidence does not identify which gate causes acoustic misses, and lowering the gates would undermine the false-positive protections that motivated Step 7k-11b.

For the next implementation step, first add a small, locally held acoustic drum evaluation set with manually annotated Kick onset times and source provenance. It should include soft/hard hits, varied tuning/tail lengths, Kick+Snare/Tom overlaps, and non-Kick low-frequency negatives. Run the current detector unchanged and record one-to-one onset matching (using the existing ±80ms synthetic-test convention for comparability), plus each candidate’s gate-rejection reason. Then perform an offline ablation of the current ratio and decay gates. Implement only the smallest gate adjustment or complementary onset path that improves labeled Kick recall without materially increasing labeled false positives, retaining Timeline v1 fields and the current API.

This is the smallest evidence-backed plan; a particular numeric threshold change is not yet justified. If adding labeled acoustic material is not possible, keep the detector unchanged and report the remaining uncertainty rather than treating unlabeled event-count reductions as accuracy gains.

## Test plan for the implementation step

- Preserve all current synthetic labeled tests: weak and strong Kick, Kick+Snare, Snare-only, Tom-only, sustained Bass, silence/noise, close double-Kick, deterministic output, terminal boundary, and strength alignment/range.
- Add locally stored acoustic examples with annotated onsets and representative low-frequency negatives; keep samples local and do not upload them.
- Compare current and candidate detectors with one-to-one matching; report TP/FP/FN, precision/recall/F1 per recording and aggregate, plus onset error distribution. Do not tune and report on the same small set without a held-out subset.
- Add threshold-ablation diagnostics showing which condition rejects each labeled positive and negative. Keep diagnostic internals out of the public Timeline/API.
- Verify Timeline v1 schema, integer millisecond ordering/range, event-strength array alignment and 0..1 bounds; run existing Frontend/Go Timeline validation and Binding/Effect regression tests.
- Separately evaluate renderer Binding values at labeled event times for thresholds around the configured values; do not conflate detector metrics with visible Effect response.

## Compatibility and scope

No Blueprint, Timeline v1, Project, Cloud, Audio Analyze API, Demucs model/weights, detection code, frontend Binding behavior, or dependencies were changed. A future detector-only change can retain the existing `kickEvents` / `kickEventStrengths` contract. No DB, auth, Hosted, or external-service operations were performed.

## Unconfirmed items

- Whether the reported weak Kick response is caused by detector misses or by Binding/Effect configuration.
- Performance on actual acoustic drum recordings and on acoustic Kick mixed with low Tom/Bass.
- Real-song precision, recall, F1, and onset offset.
- Whether Demucs attenuates specific acoustic Kick transients for the target source.
- Per-Effect perceptual response in a real browser; this task made no browser changes or visual acceptance claims.

## References

- `python-island/src/python_island/features.py`: `detect_kicks()`, `extract_features()`.
- `python-island/tests/test_features.py`: synthetic detector fixtures and regressions.
- `frontend/src/renderer.ts`: `baseEvents()`, `rawSourceValue()`, `evaluateBinding()`, `boundFeature()`.
- `frontend/src/VisualEditor.tsx`: `bindingFor()` defaults and source selection.
- `docs/BLUEPRINT_SPEC.md`: Kick detector and Timeline v1 facts.
- `docs/TEST_STRATEGY.md`: Step 7k-11b detector evaluation coverage.
- `docs/reports/2026-11-01-step7k-11b-kick-detection.md` and `docs/reports/2026-11-01-step7k-11b-kick-comparison.json`: prior synthetic and unlabeled demo comparisons.
- `docs/OPEN_ISSUES.md`: real-song Kick precision/recall remains pending.
