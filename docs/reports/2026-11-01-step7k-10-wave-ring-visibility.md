# Step 7k-10 — Wave Ring Offsets and Effect Visibility

**Status: partial**

## Result

Wave Ring accepts `layerCount` 1..10. Automatic `layerAngleOffsetDeg: 0` uses `180/layerCount` degrees per layer, while positive values retain the manual adjacent-layer step. The same offset shifts both path angle and periodic sample phase. Existing single-layer Blueprints and manual offsets remain unchanged. New Wave Ring defaults remain four layers. At the renderer maximum of ten layers and 256 samples, each Effect evaluates at most 2,560 ring points and reuses the source sample series.

All 15 Effect kinds now accept optional `visibilityMode` (`triggered`/`always`) and `audioReactive` (boolean). Missing fields preserve legacy Triggered + Reactive behavior. New Editor and normalized AI Effects default to Always + Reactive. Always keeps existing basic geometry visible at a low alpha floor; Burst and Shockwave use deterministic static baselines when no event is active. They do not generate synthetic events. Peak waveform Effects draw a simple baseline line/contour when Always is selected and peaks are missing; they never synthesize waveform data. Audio Reactive OFF is valid only with Always and the Editor switches to Always when turning it off. Binding signals are suppressed; real peaks are sampled at clip start as a static baseline, and Continuous BPM rotation remains active.

Blueprint v1, Feature Timeline v1, `.arvproj v1`, Cloud v1, 7 Audio Sources, Opacity, Gradient, Category → Type, Region clipping, BPM rotation, and shared `renderEditorFrame` are retained. OpenAI strict schema and normalization were updated; no OpenAI API was called.

## Changed files

- `frontend/src/editor-model.ts`: visibility/reactivity types and validation; layer range 1..10.
- `frontend/src/renderer.ts`: automatic offset formula; Always baselines, audio signal suppression, static peak mode, and deterministic event-effect baselines.
- `frontend/src/VisualEditor.tsx`: controls/defaults, invalid-combination prevention, layer limits, and status messaging.
- `frontend/src/editor-renderer.test.ts`: offset geometry, 10×256 workload, Always/no-event/missing-peak, reactive off, and BPM coexistence.
- `frontend/src/visual-editor.test.tsx`: controls across 15 types, setting changes, and Type-change retention.
- `frontend/src/cloud-project.test.ts`: Cloud v1 carries the additive fields.
- `api/internal/blueprint/blueprint.go`, `blueprint_test.go`: matching enum/bool/pair validation and layer range.
- `api/internal/service/openai.go`, `openai_test.go`: strict properties, AI defaults/prompt, and schema checks.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/BLUEPRINT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md`: compatibility contract and verification record.

## Tests

- Frontend `npm test -- --run`: **109 tests passed**.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Go `go test ./internal/blueprint ./internal/projects`: passed.
- Go OpenAI schema/normalization/rotation focused tests: passed.
- Go `go vet ./...`: passed.
- `git diff --check`: passed.

`go test ./...` was attempted. The existing `TestOpenAIResponsesRequestUsesStrictStructuredOutput` could not start because the sandbox denied its IPv6 loopback listener (`listen tcp6 [::1]:0: operation not permitted`). Other packages completed before that failure. No test was disabled or changed to bypass it. A real browser was unavailable, so actual visual quality, preview/WebM frame comparison, and FPS remain unverified.

## Compatibility and scope

All fields are additive optional Blueprint v1 extensions; no version, Timeline, Project, Cloud, database, API persistence, dependency, or hosted changes were made. Old Blueprints default to Triggered + Reactive and one Wave Ring layer. Existing renderer and export paths are unchanged.

## Remaining issues

- Run the complete Go service suite where IPv6 loopback binding is permitted.
- Inspect 10-layer visual compositing, clipping, and WebM output in a real browser.

## Layer offset correction (2026-11-01)

The reported overlap came from applying `layerOffsetDeg` twice in opposite roles: the renderer sampled `features[index + phaseOffset]` and also placed the point at `baseAngle + layerOffsetDeg`. For a sampled feature at angle θ, this paired shift moved that same feature back onto its original world angle, so the geometry offset existed numerically while its asymmetric contour nearly overlapped.

The renderer now evaluates every layer from the same reference sample (`features[index]`) and applies the shared BPM rotation plus layer offset only to the Canvas coordinate angle. Radius step, amplitude decay, smoothing, cyclic closure, opacity, gradient, clipping, and binding sampling are unchanged.

Added a regression test that builds a non-symmetric single-sample dip, renders through `renderEditorFrame` and its Catmull-Rom Canvas path, then locates the feature in the final path endpoints. It verifies 3/4/6/10-layer automatic offsets, the 4-layer 45° separation, manual 13° spacing, BPM continuous rotation plus 19° initial angle, smoothing, deterministic repeated time after out-of-order evaluation, and the common Renderer draw path. The test fails under the prior phase-plus-coordinate offset implementation.

Correction verification: `npm test -- --run src/editor-renderer.test.ts` passed (38 tests). Full verification passed: `npm test -- --run` (110 tests), `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check`. No schema or non-Renderer implementation changed. A new manual browser inspection after the correction is not available in this environment.

## Step 7k-10b angle and concentric-radius correction

The automatic adjacent-layer step is now `360 / layerCount` (3 layers: 120°, 4: 90°, 6: 60°, 10: 36°). Each layer uses the same base `radius`. The shared sample sequence remains unchanged across layers; BPM rotation, initial angle, and the per-layer offset are combined once in rendered Canvas coordinates. This avoids phase cancellation and gives the asymmetric waveform peaks the requested full-turn spacing.

`layerRadiusStep` remains an accepted, validated optional field in Blueprint v1 so old Blueprints and `.arvproj`/Cloud v1 data continue to load. Wave Ring no longer exposes that setting in the Editor and the renderer ignores it. No version, API, Timeline, or OpenAI schema change was needed.

Updated tests cover 120/90/60/36° in final smoothed Canvas path coordinates, manual offsets, initial angle plus BPM rotation, out-of-order deterministic evaluation, same-radius paths even with legacy `layerRadiusStep`, and UI hiding the obsolete radius control. Verification: Frontend `npm test -- --run` passed (110 tests), `npm run typecheck`, `npm run lint`, `npm run build`, Blueprint/Project Go package tests, focused Go Blueprint/OpenAI schema and normalization tests, `go vet ./...`, and `git diff --check` passed. A broader Go service test filter selected existing httptest cases requiring an IPv6 loopback listener and was blocked by the sandbox (`operation not permitted`); the schema-focused tests that do not bind a listener passed. Real-browser pixel inspection remains unavailable.
