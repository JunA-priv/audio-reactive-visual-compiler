# Step 7k-27 — Particle Burst Demo / Audio Analyze Comparison

**Status: partial.** The renderer-side attenuation was reproduced with existing Demo and acoustic-stem Timeline strengths. Newly generated Kick-bound Particle Bursts now receive the existing responsive Kick Binding defaults when applied to the Editor. Frontend automated checks passed. The user's saved Effect parameters and post-fix browser appearance are not available for verification.

## Demo and analyzed-audio comparison

The Demo Editor starts from `initialEditorBlueprint`, which does not contain a Particle Burst. When one is added through the Demo Editor, `addEffect()` selects `kick.events`, and Step 7k-26's `bindingFor()` supplies Strength 1 / Threshold 0 / Attack 0ms / Release 260ms. The default newly added Burst uses Stage, opacity 1, triggered visibility, Audio Reactive ON, count 32, size 7px, lifetime 1,500ms, speed 420px/s, origin (0.5, 0.5), direction 0°, spread 90°, glow 1.6, opacity boost 1.6, core brightness 1.1, swirl 0.55, and audio influence 1. These are code defaults, not proof of the user's actual Demo settings.

After Audio Analyze, `VisualEditor` installs `newEditorBlueprint` (Spectrum Bars and Ink Diffusion on `music.energy`). Blueprint generation is a separate action. The model response supplies its own Effect and Binding values; the OpenAI schema has no fixed Binding defaults. The user's generated/saved Particle Burst values were not supplied, so the actual source, Binding, count, size, lifetime, movement and glow values cannot be asserted from the screenshot. The screenshot does confirm triggered visibility, Audio Reactive ON and opacity 1.

| Item | Demo path (confirmed in code/assets) | Audio Analyze / generated path | Effect on burst | Confidence |
|---|---|---|---|---|
| Effect kind | `particle-burst` when manually added; not in Demo's starting Blueprint | User confirms Particle Burst; exact generated Blueprint unavailable | Same renderer kind if saved/generated as shown | Demo code / user report |
| Audio Source | `kick.events` from `addEffect()` | Generated Kick Binding is supported, but actual value unknown | Non-Kick source would not be valid for this event-only Effect | Demo code / actual unknown |
| Binding Strength / Threshold | `1 / 0` for a new UI-added Kick Binding after Step 7k-26 | API generation response values unknown; schema allows 0–1 | Threshold removes event values at or below it; Strength scales the remainder | Demo code / actual unknown |
| Attack / Release | `0 / 260ms` for a new UI-added Kick Binding | Generated values unknown | Particle Burst uses per-event `boundFeature()`; Attack/Release do not affect its event particle calculation | Demo code / renderer fact |
| Visibility / Audio Reactive / Effect opacity | New Burst defaults to triggered / on / 1 | Screenshot: triggered / on / 1 | Triggered mode emits no fallback particles when no event passes Binding | Demo code / screenshot |
| Count / Size / Lifetime / Speed / Origin / Spread | New Burst defaults: 32 / 7px / 1,500ms / 420px/s / center / 90° | Generated/custom values unknown | Count scales emitted commands; lifetime sets the event window; size/speed affect visibility and movement | Demo code / actual unknown |
| Timeline Kick Strength | demo1: 217 events, minimum 0.2510, median 1.0, none ≤0.1 | Existing demo4 acoustic-stem Hard Timeline: 138 events, minimum 0.0433, median 0.0992, 69 ≤0.1. Step 7k-25 Middle diagnostics: 395 events, 91 ≤0.1 | With a generic 0.1 threshold, Demo strengths pass while low acoustic strengths are dropped or reduced to near-zero | Existing files/reports; not user's actual crop |

These strength distributions are normalized detector outputs, not labeled Kick confidence. The demo4 Timeline is an acoustic-stem proxy and is not claimed to be the user's actual 60-second clip or selected Gate Mode.

## Root cause and reproduction

The cause is an interaction between Timeline strength distributions and the new Blueprint's Binding defaults, rather than an event/clock/visibility regression:

1. Demo event strengths are much higher than the saved acoustic-stem Timeline's weak events.
2. Particle Burst evaluates each event directly using `boundFeature(eventStrength, binding)`. This applies the threshold once; it does not also use the continuous `evaluateBinding()` result. If the event is at or below Threshold, it produces no particles.
3. For strengths just above the threshold, `boundFeature()` is small. Particle count is `ceil(count × (0.32 + response × 0.68))`, while particle opacity is proportional to event strength and `opacityBoost`. A near-threshold hit can therefore emit about 11 faint particles instead of the 30 produced by a Strength 1 event with a generic 0.9/0.1 binding.
4. For a single fixed test Blueprint (count 32, opacity boost 1.6), demo1-like Strength 1 with Binding 0.9/0.1 produced 30 draw commands. The existing demo4 value 0.052458 with the same Binding produced none. A demo4 value 0.108810 is only slightly above 0.1; after normalization and Binding strength it drives approximately 11 particles at very low opacity.
5. Applying Strength 1 / Threshold 0 to the same weak 0.052458 event produced 12 commands with opacity above 0.08. That is a concrete renderer-command improvement; perception in the actual browser still needs confirmation.

Visibility is not double-gating the event: triggered mode only suppresses the always-mode fallback when the Burst returns no event commands. `audioReactive=false` would mute the response, but the user's screenshot shows it on. Particle event time is compared against renderer frame time and reconstructed for arbitrary seeks; the event remains active for its configured lifetime. No frame-state or Preview/WebM divergence was found in this path. Attack and Release are not read by Particle Burst's per-event rendering path.

## Minimal fix

`prepareGeneratedBlueprint()` now runs only after a newly generated response has been validated and before it is placed in Editor state. For each generated `particle-burst` with `kick.events`, it sets the existing Binding values Strength 1 and Threshold 0. It leaves Attack, Release, all Effect parameters, Timeline, and other Bindings unchanged.

Project restoration and previously saved Blueprints do not use this preparation function and are not rewritten. Users can still edit the generated Binding after it enters the Editor. No detector gates, event algorithm, API contract, schema, persistence, or Renderer formula changed.

## Regression coverage

- Same Particle Burst Blueprint compared on a Demo-strength event and exact weak Strength `0.05245834928566786` taken from the existing demo4 Timeline.
- Generic 0.9 / 0.1 Binding reproduces 30 Demo commands versus no commands for the weak acoustic event.
- Kick defaults reproduce 12 commands for that weak event, with command opacity above 0.08.
- UI integration loads a generated Blueprint containing a Particle Burst with generic Binding values and verifies that only its Kick Binding is normalized; Attack and Release remain 60ms / 260ms.
- Existing renderer tests cover triggered/always behavior, source compatibility, lifetime, count limits, opacity, deterministic seeking, and Preview/WebM shared rendering.

## Verification

- Frontend: **164 tests passed** across 13 files.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `git diff --check`: passed; all changed files also scanned for trailing whitespace.
- Python / Go were not changed; their suites were not rerun for this Frontend-only change.
- No OpenAI request or hosted operation was performed.

## Changed files

- `frontend/src/VisualEditor.tsx` — normalize only generated Kick-bound Particle Burst Binding strength/threshold.
- `frontend/src/editor-renderer.test.ts` — reproduce measured Demo/acoustic Timeline strength difference and verify draw-command recovery.
- `frontend/src/visual-editor.test.tsx` — verify generated Blueprint application and preservation of unrelated Binding parameters.
- `docs/reports/2026-11-02-step7k-27-particle-burst-regression.md` — findings and verification.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md` — current status and remaining acceptance.

## Remaining verification

The user's actual generated Blueprint and source crop were not provided; its original Binding and Effect parameters remain unknown. Windows Chrome visual acceptance after this fix is pending. Low Strength events now produce commands, but their perceived visibility depends on the generated/saved size, color, glow, region and opacity settings. Existing saved Projects are intentionally unchanged and may require manual Binding adjustment to expose weak Kick events.
