# Step 7k-11d — Ink Diffusion

**status: partial** — implementation and targeted automated checks pass. Full Go service tests are blocked by sandbox IPv6 loopback binding, and this environment did not provide a browser for visual/FPS acceptance.

## Result

Added `ink-diffusion` under the UI-derived `Ambient / Atmospheric` category. Four seeded cloud centers each render three translucent closed contours (12 Canvas path commands / Effect), with 40 contour points per path (480 contour points / Effect). Layered fills produce soft density and color overlap; low-frequency contour harmonics and seeded offsets deform continuously from absolute time. The existing smooth closed-path Canvas renderer, Region clip, gradient/custom color resolution, common opacity, draw order, and `renderEditorFrame` Preview/WebM path are reused.

New Effects default to `music.energy`, `visibilityMode: always`, `audioReactive: true`, and these optional Blueprint v1 parameters:

| Parameter | Range | Default |
|---|---:|---:|
| `diffusionSpeed` | 0–2 | 0.25 |
| `flowStrength` | 0–2 | 0.4 |
| `turbulence` | 0–2 | 0.3 |
| `inkDensity` | 0–1 | 0.65 |
| `cloudScale` | 0.1–2 | 0.5 |
| `responseTime` | 0.5–10 seconds | 3 |

The response table applies existing Binding threshold/attack/release processing, then a one-pole low-pass at `responseTime`, sampled at 20ms intervals. It is built from Timeline/settings and cached by Timeline identity and Binding parameters, with a maximum of 12,001 values per entry and 16 parameter variants per Timeline. This is deterministic for arbitrary seek order. Always mode keeps autonomous slow motion when silent or non-reactive; Triggered mode fades in/out from the smoothed source response and does not invent events.

## Compatibility

Blueprint, Feature Timeline, `.arvproj`, Project Document, and Cloud Envelope remain v1. The six Ink fields are optional and omission is accepted; Editor defaults and OpenAI normalization use the same values. Category is derived from Effect kind and is not serialized. No Timeline feature, dependency, Python, API, DB, Auth, hosted, 3D, or GPU changes were made. Existing Effects and seven source choices remain unchanged.

## Changed files

- `frontend/src/editor-model.ts` — Ink Effect type and strict parameter validation.
- `frontend/src/renderer.ts` — deterministic contour generation and cached response smoothing.
- `frontend/src/VisualEditor.tsx` — category, defaults, music Binding, and parameter controls.
- `frontend/src/editor-renderer.test.ts` — contours, response strength, seek determinism, opacity/gradient command, and Region clip checks.
- `frontend/src/visual-editor.test.tsx` — all 18 categories/kinds and Ink editor defaults.
- `frontend/src/project-file.test.ts`, `frontend/src/cloud-project.test.ts` — v1 persistence roundtrips.
- `api/internal/blueprint/blueprint.go`, `api/internal/blueprint/blueprint_test.go` — Go kind/parameter validation.
- `api/internal/service/openai.go`, `api/internal/service/openai_test.go` — strict schema, prompt, normalization defaults.
- `api/internal/projects/document_test.go` — Project/Cloud v1 acceptance.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/BLUEPRINT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md` — current contract and remaining acceptance status.

## Tests

- `npm test -- --run` — passed, 126 tests.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- `go test ./internal/blueprint ./internal/projects` — passed.
- `go test ./internal/service -run 'TestOpenAI(Schema|InkDiffusion|NormalizesOpacity|NormalizesEnhancedParticle)'` — passed.
- `go vet ./...` — passed.
- `go test ./...` — existing `TestOpenAIResponsesRequestUsesStrictStructuredOutput` could not start `httptest.NewServer`: sandbox denied listen on `[::1]:0` (`operation not permitted`). No test was removed or disabled.
- `git diff --check` — passed.

## Remaining verification

Fake Canvas command tests verify bounded closed contour paths, nonzero alpha, shared gradient, Region clipping, audio response scaling, and repeated/out-of-order timestamp equality. They do not establish perceived fluid realism, color mixing quality, or real browser FPS. Browser visual review and WebM playback comparison remain unverified.
