# Step 7k-11c — Particle effects improvement

- **status:** partial

## Result

`particles` renders a deterministic field of multiple particles distributed across the Region, moving upward from its lower area. Per-particle horizontal sway, size, and glow vary reproducibly. Audio response changes particle count, spread, ascent speed, brightness, and opacity. The later 7k-11c correction fixes Particles to Triggered + Audio Reactive ON; legacy Always/non-reactive values remain readable but are rendered as triggered and normalize on save.

`particle-burst` now distributes particles around the full circle rather than emitting upward. It combines deterministic angular variation, event-ordinal rotation, and lifetime-based swirl. Audio response increases count, speed/distance, spread, and glow. Always mode can show a faint static baseline without generating silent recurring bursts. Both effects remain within `renderEditorFrame`, preserve Region clipping and existing color/opacity resolution, and are evaluated without previous-frame state. Per-effect particle count is capped by existing count validation (64); event reconstruction is bounded to 32 active events.

## Optional parameters

- `particles`: `spread` (0.1–1), `speedInfluence` (0–2), `glowIntensity` (0–2), `baselineOpacity` (0–0.35).
- `particle-burst`: `swirl` (-2–2), `audioInfluence` (0–2), `baselineOpacity` (0–0.35).

Editor and AI normalization use matching defaults. Existing fields and Effect kind names remain unchanged.

## Compatibility

Blueprint v1, `.arvproj v1`, Cloud Envelope v1, Project v1, Timeline v1, all seven audio sources, Global Gradient/Custom Color, opacity, visibility, Audio Reactive, Region, and draw order are retained. New fields are optional; legacy data remains valid. No Python Island, Timeline, API/DB/Auth, or dependency changes were made. The OpenAI Structured Output schema and prompt were updated; no OpenAI API request was made.

## Changed files

- `frontend/src/editor-model.ts`: optional parameter types and strict range/unknown-field validation.
- `frontend/src/renderer.ts`: rising field and radial/swirl burst rendering, deterministic bounded evaluation, visibility/audio-reactive handling.
- `frontend/src/VisualEditor.tsx`: matching defaults, bounded editing and parameter controls.
- `frontend/src/editor-renderer.test.ts`: particle distribution, response, visibility, source conversion and seek determinism coverage.
- `frontend/src/visual-editor.test.tsx`: Editor controls coverage.
- `frontend/src/project-file.test.ts`, `frontend/src/cloud-project.test.ts`: v1 roundtrip coverage.
- `api/internal/blueprint/blueprint.go`, `api/internal/blueprint/blueprint_test.go`: Go field allowlist and validation tests.
- `api/internal/service/openai.go`, `api/internal/service/openai_test.go`: strict schema, prompt and normalization defaults.
- `api/internal/projects/document_test.go`: Project/Cloud v1 acceptance coverage.
- `CURRENT_TASK.md` and `docs/{CURRENT_STATE,OPEN_ISSUES,BLUEPRINT_SPEC,ARCHITECTURE,TEST_STRATEGY,VISUAL_EFFECT_ROADMAP}.md`: current state, contracts, architecture, verification and manual visual follow-up.

## Tests

- `npm test -- --run`: passed, 118 tests across 11 files.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- `go test ./internal/blueprint ./internal/projects`: passed.
- `go test ./internal/service -run 'Test(OpenAINormalizesEnhancedParticleDefaults|StructuredOutputSchema.*Particle)'`: passed.
- `go vet ./...`: passed.
- `git diff --check`: passed.

A full `go test` of `internal/service` was attempted, but an existing `httptest.NewServer` test cannot bind IPv6 loopback (`listen tcp6 [::1]:0: socket: operation not permitted`) in this sandbox. The relevant normalization test passed separately. No tests were removed or disabled.

## Remaining issues

Actual browser pixel quality, Preview/WebM playback, and FPS under several simultaneous particle effects were not visually measured. Manual browser acceptance remains. The full service test package remains constrained by sandbox IPv6 loopback binding.

## Correction: Particles distribution (Step 7k-11c follow-up)

### Root cause

The previous silence spread was calculated as `configuredSpread * (0.24 + response * 0.76)`. At zero response, that compressed the configured 0.78–0.92 width to roughly 19–22% of the Region width. Also, X and Y variation came from adjacent seeds in the same linear congruential generator sequence; this correlated the two axes and produced a narrow, visually clumped field. The previous baseline was also only about 24% of configured count, with the default baseline opacity 0.14.

### Fix

- Use the configured spread across the Region even at silence; response expands it toward the full width.
- Use per-index stratified horizontal slots and an independent deterministic vertical phase based on the golden-ratio sequence plus a separately hashed jitter.
- Keep the configured count as the upper bound. Always count now starts at 36% of configured count, increasing to the full count with response.
- Raise the new/default Always baseline opacity from 0.14 to 0.26 and use a more visible size/glow distribution. Explicit user values still take effect, including `opacity: 0`.
- Keep the same renderer command/clip/gradient/opacity path. No schema, version, binding, Burst, or Timeline changes.

### Coordinate and Canvas verification

For the Stage Region (640×360 canvas; Region width 486.4 px), at configured count 64:

| Evaluation | Draw commands | Unique X / XY | X range | Region width | Maximum particles within 12×12 px | Alpha-visible |
|---|---:|---:|---:|---:|---:|---:|
| Always, silent, time 0 | 24 | 24 / 24 | 422.1 px | 486.4 px | 1 | 24 |
| Always, full response, time 200 ms | 64 | 64 / 64 | 475.5 px | 486.4 px | 1 | 64 |

Renderer tests also record each command's index, spawn/render coordinates, size, alpha, and phase; verify vertical movement, Audio Reactive OFF static positions, Always/Triggered behavior, polygon clipping, opacity/glow, continuous response scaling, seek determinism, and actual Canvas `ellipse` calls. Particle Burst regression tests remain passing.

### Verification and acceptance limit

`npm test -- --run` (118 tests), `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. Browser executables and Playwright are not installed in this environment, so rasterized pixels and real Preview/WebM appearance remain unconfirmed. Automated Canvas-command distribution is confirmed; human visual acceptance is still needed.

## Additional adjustment: unified particle count limit (Step 7k-11c)

Confirmed previous limits were inconsistent: `particles` allowed 200 in Frontend/Go and its UI; `particle-burst` allowed 32; the strict OpenAI schema's shared `count` allowed 200. The new common range is **1–64**.

- Editor number inputs for both kinds now accept 1–64 and round to integer values.
- Frontend and Go Blueprint validators accept 1/32/64 and reject 65 for both kinds.
- OpenAI strict schema `count` maximum is 64; no API call was made.
- Renderer caps each `particles` field at 64. `particle-burst` caps requested count and the sum of live particles across overlapping events at 64 per Effect. Core flash commands remain a separate visual layer.
- Added renderer tests for 1/32/64 in both kinds, 65 rejection, and overlapping-event aggregate cap. Updated `.arvproj v1`, Cloud Envelope v1 and Go Project/Cloud test fixtures to roundtrip count 64.

No version, Timeline, API, DB/Auth, Python, dependency, Binding, Audio Source, gradient, opacity or particle motion/Burst distribution changes. Full frontend tests/typecheck/lint/build, Go Blueprint/Project tests, targeted OpenAI schema/normalization tests, `go vet ./...`, and `git diff --check` passed. Details are in the current task changes and tests; real browser inspection was not part of this L1 limit adjustment.

Count-limit adjustment verification: `npm test -- --run` passed (119 tests / 11 files), `npm run typecheck`, `npm run lint`, `npm run build`; `go test ./internal/blueprint ./internal/projects`, targeted OpenAI schema/normalization tests, `go vet ./...`, and `git diff --check` passed.

## Additional correction: Particles is Triggered only

`particles` now has an effective fixed mode: `visibilityMode=triggered`, `audioReactive=true`. The Editor pins and displays these settings; adding Particles or changing another Effect Type to Particles applies both values. Editing any Particles parameter also canonicalizes them. Its renderer path ignores legacy `always` and `audioReactive=false` flags, evaluates the existing Binding, and emits no commands when the response is zero. It still uses the existing continuous/Event source conversion and existing deterministic movement, count, spread, color, opacity and Region clip code. No extra trigger detector was added. Particle Burst and all other Effect visibility paths are unchanged.

Legacy Blueprint, `.arvproj v1`, Cloud/Project v1 documents with `particles + always` remain valid and load without mutation. Saving through the Frontend `.arvproj` or Cloud envelope serializers rewrites only Particles to Triggered/Reactive ON. The OpenAI normalizer also forces those values for generated Particles; the strict schema enums remain shared and unchanged. Go validation continues accepting valid legacy `always + audioReactive=false` combinations, while non-Particles retain the pre-existing cross-field rule. No version changes or OpenAI requests.

Tests cover silent / threshold-inactive rendering, active response from all seven sources, 64-particle cap, arbitrary seek, legacy Always drawing as triggered, pinned Editor controls, `.arvproj` legacy read and normalized resave, Cloud legacy hydrate and normalized resave, OpenAI normalization, and existing Particle Burst / other Effect Always regressions.

Triggered-only correction verification: `npm test -- --run` passed (123 tests / 11 files); `npm run typecheck`, `npm run lint`, and `npm run build` passed. `go test ./internal/blueprint ./internal/projects`, targeted OpenAI normalization/schema tests, `go vet ./...`, and `git diff --check` passed.
