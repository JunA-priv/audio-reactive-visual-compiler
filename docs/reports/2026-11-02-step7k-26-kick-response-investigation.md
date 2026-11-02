# Step 7k-26 — Kick Detection / Binding Response Investigation

**Status: partial.** Root cause was isolated across the data and rendering path, and the defaults for newly created Kick bindings were adjusted. Automated checks passed. Acoustic truth labels and browser-visible response remain unverified.

## Findings

### Gate Mode and Timeline flow

The existing Gate Mode path remains connected: the Editor sends the selected `kickGateMode` on the next Analyze request; Go validates and forwards it to Python; `extract_features()` passes it into `detect_kicks()`. Omission remains Hard. The selected mode does not reprocess an existing Timeline. On successful analysis, `VisualEditor.tsx` replaces Timeline with the returned `featureTimeline` and initializes the normal new-analysis Blueprint. That Blueprint intentionally binds its Spectrum Bars and Ink Diffusion to `music.energy`, so a Kick event will not drive those default Effects until their Audio Source is changed to Kick. A failed analysis does not replace the existing successful Timeline/Blueprint.

### Detector output and strength

Re-ran the unchanged detector on `demo-assets/stems/demo4-kick-evaluation/drums.wav` (189.960s, 44.1kHz stereo PCM16). These are detector diagnostics, not labeled accuracy:

| Gate | Events | Strength ≤ 0.1 | Strength > 0.1 | Min | Median | p90 | Max | Min / median event gap |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Off | 994 | 429 | 565 | 0.000094 | 0.223223 | 0.689112 | 1.000000 | 120 / 160ms |
| Soft | 647 | 102 | 545 | 0.018141 | 0.369472 | 0.748848 | 1.000000 | 120 / 240ms |
| Middle | 395 | 91 | 304 | 0.028778 | 0.351253 | 0.801916 | 1.000000 | 120 / 300ms |
| Hard | 138 | 69 | 69 | 0.043280 | 0.099156 | 0.389254 | 1.000000 | 140 / 580ms |

The unchanged detector retains its 120ms candidate merge; event intervals therefore cannot be shorter than 120ms except where the stricter gate changes which local maximum survives. Off's extra events are not assumed to be true Kicks. Strength remains a per-analysis normalization over accepted candidate scores, so it is relative to the selected mode and clip, not an acoustic confidence score. Existing Step 7k-25 evidence shows Hard event times match the saved Hard baseline exactly.

### Binding and Effect path

`renderer.ts` reads paired `kickEvents` / `kickEventStrengths` (`rawSourceValue()`), applies the Binding threshold and Attack/Release in `evaluateBinding()`, then multiplies by Binding strength. Ripple uses this continuous smoothed value for opacity and size modulation. Its ring phase is based on elapsed time and `periodMs`, not locked to each Kick onset. Event-driven Shockwave / Particle Burst instead run `boundFeature()` on each event Strength; a Strength at or below threshold yields zero opacity. These paths are separate from detector acceptance.

Reproduced the cutoff: at threshold 0.1, Strength 0.05 and 0.1 produce zero. Strength 0.2 produces a pre-attack normalized value `(0.2 - 0.1) / (1 - 0.1) = 0.1111`; with Binding strength 0.9 and 60ms Attack, the 20ms sampled value is about 0.02835. At Strength 0.2, threshold 0.05 and 0 produce pre-attack outputs 0.1579 and 0.2 respectively. With zero threshold and Binding strength 1, 60ms/20ms/0ms Attack samples are about 0.0567/0.1264/0.2; with strength 0.9 they are 0.0510/0.1138/0.18. Strength 1.0 scales the normalized outputs up to their ceiling. The same 0.1 cutoff fully suppresses the demo4 events at or below that value: 429 Off, 102 Soft, 91 Middle, and 69 Hard. The renderer tests also show a 0.05 event reaches Ripple and Shockwave draw commands with threshold 0, and is suppressed at threshold 0.1.

Audio Reactive must be enabled, the Effect must use `kick.events`, and its Visibility/Opacity and Effect-specific controls must permit visible output. In particular, the post-analysis defaults are Song-bound, and Ripple is continuous-phase, so neither a non-Kick Audio Source nor a phase/low-opacity moment proves detector failure. Exact user-reported silent timestamps and their active Blueprint settings were not available; this prevents assigning a single exclusive cause for that report.

## Change

For **newly created bindings whose source is `kick.events`**, `bindingFor()` now uses Strength 1, Threshold 0 and Attack 0ms, retaining Release 260ms. This avoids applying a second conservative cutoff/slew to detector outputs; Gate Mode remains the user's detector-side sensitivity control. Other Audio Source defaults are unchanged. Existing Bindings, loaded Projects, manually edited Ripple settings, the demo fixture's pre-existing Binding, and saved values are not rewritten. A Ripple changed from another source to Kick retains its current user-selected parameters; set Threshold to 0, Strength to 1 and, for prompt onset, Attack to 0ms if a saved Ripple should expose weak detected events.

No detector condition, normalization, merge, Timeline, API, Blueprint schema, saved Project, Effect rendering formula, or Renderer/WebM code changed. No detector accuracy improvement is claimed without human labels.

## Tests and checks

- Frontend: **163 tests passed**; `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Python Island: **65 tests passed**; `mypy --strict src`: passed; Ruff `src tests --ignore E501`: passed.
- Go Audio Analyze: `go test ./internal/audioanalysis` and `go vet ./...`: passed.
- `git diff --check` and trailing-whitespace scan of all seven changed files: passed.
- Added renderer tests sweep Strength 0.05/0.1/0.2/0.5/1, Threshold 0.1/0.05/0, Strength 0.9/1, Attack 60/20/0, post-onset decay, and Ripple/Shockwave propagation.
- Added UI regression asserting a newly added Shockwave is Kick-bound with Threshold 0, Strength 1, Attack 0, Release 260.
- Real browser / Windows Chrome and pixel-visible acoustic response: not tested in this environment.

## Changed files

- `frontend/src/VisualEditor.tsx` — Kick-specific defaults for newly created Kick bindings.
- `frontend/src/editor-renderer.test.ts` — Binding parameter sweep and weak-event Effect propagation coverage.
- `frontend/src/visual-editor.test.tsx` — new Kick-bound Effect default regression.
- `docs/reports/2026-11-02-step7k-26-kick-response-investigation.md` — findings and evidence.
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md` — status and outstanding evidence.

## Remaining verification

- Human-annotated Kick and non-Kick events are still required to assess whether Off's additional events are real Kicks or false positives.
- Test with the user's actual saved Blueprint and silent timestamps; check Audio Source, Binding threshold/strength/attack, Audio Reactive, Visibility, Effect Opacity, and renderer command opacity at those exact times.
- Manually inspect Ripple and an event-driven Effect in a real browser. Browser/GPU acceptance was not performed here.
