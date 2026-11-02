# Step 7k-11g — Ink Diffusion expansion and shape variation

**status: partial** — Renderer and deterministic geometry changes are implemented and automated checks pass. Browser WebGL2 pixels are unavailable here, so visual acceptance and actual shader coverage remain unverified.

## Implementation

### WebGL2 density field

- Added a strong Gaussian-like central density core so the first/quiet state has a visible origin.
- Added four satellite diffusion sources. Their orbit angle, radius, and asymmetry vary by Effect ID / Blueprint seed and absolute-time phases, so independent Ink Effects and later timestamps do not collapse to one repeated vortex silhouette.
- A deterministic diffusion amount derived from absolute time, existing `diffusionSpeed`, and the existing smoothed Binding response drives a broad density envelope and outward expansion front. Binding response also increases front reach, flow, vortex movement and alpha density.
- Expanded the former three-vortex warp into four local vortices with independent directions/radii. Two noise-warp scales move at different temporal frequencies, and a radial/angular filament field adds multiple outward threads rather than a single ribbon direction.
- Gradient pigment still uses the full Canvas coordinate space and configured angle. Custom Color remains one pigment with density-based tonal variation.

### Canvas2D fallback

Replaced the lower-edge rising ribbon fallback with a central core and three orbiting satellite clouds. Each has deterministic 48-point asymmetric contours and an inner/outer density layer. Five curved radial branches extend from the center. At the tested 8-second quiet state, fallback contour bounds exceed 60% of the Stage Region width; this is a geometry bound, not a rasterized area-coverage measurement. Higher Binding response increases the tested fallback bounds further.

## Determinism and contracts

All time variation is computed from the evaluated timestamp, Effect ID, Blueprint seed, existing Timeline response and existing parameters. There is no prior-frame state. Existing response smoothing and WebGL2 context cache/fallback remain. Region clip, draw order, opacity, Global Gradient / Custom Color and `renderEditorFrame` are unchanged.

No new optional field was needed. Blueprint, Timeline, `.arvproj`, Cloud Envelope and Project versions stay at v1. Frontend/Go validators, OpenAI schema, Python Island, other Effects, dependencies, DB/Auth and APIs were not changed.

## Tests and verification

- Focused renderer / shader tests — passed, 48 tests across 2 files.
- `npm test -- --run` — passed, 128 tests / 12 files.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed (Vite bundle 366.67 kB; 112.25 kB gzip).
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go test ./internal/blueprint ./internal/projects` — passed.
- Targeted OpenAI schema / normalization tests — passed: Binding source enum, Ink schema defaults, normalizers and strict schema subset.
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go vet ./...` — passed.
- `git diff --check` — passed.

The broader targeted service regex also selected HTTP mock tests that start `httptest.NewServer`; those tests cannot bind sandbox IPv6 loopback (`listen tcp6 [::1]:0: operation not permitted`). The pure schema/normalization tests listed above ran separately and passed. Go code/schema did not change in this step.

Renderer tests verify same-timestamp command equality, out-of-order seek equality, distinct time payloads, fallback contour extent growth at 0/3/8 seconds, greater than 60% Region-width reach at 8 seconds, increased bounds for strong versus quiet response, and Region clip command execution. Static shader tests check the core, expansion/front, multiple phases, multi-scale warp and vortex structure. These tests do not compile or rasterize the GLSL.

## Not verified

No browser, GPU-backed WebGL2 context, or GLSL compiler is installed. Consequently actual shader compile/link, rasterized central core and 60–90% Region coverage, visual difference at 0/3/8 seconds, demo appearance, real response strength, FPS, context restore and WebM playback/pixel parity are unverified. Do not treat the Canvas2D contour-bound test or static source inspection as GPU visual acceptance.

## Changed files

- `frontend/src/ink-webgl.ts` — central-core density field, seeded orbiting sources, outward front, multi-phase warps, varied vortex field, broader filaments and response-driven coverage.
- `frontend/src/renderer.ts` — deterministic diffusion uniform and broader center/radial Canvas2D fallback.
- `frontend/src/editor-renderer.test.ts` — time/seek/coverage/response/clip checks for shader payload and fallback geometry.
- `frontend/src/ink-webgl.test.ts` — static shader structure assertions.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md` — status, design and visual acceptance limits.
