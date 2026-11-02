# Step 7k-11h — Region occupancy normalization

**status: partial**

## Result

Adjusted Renderer geometry so assigned Regions act as the primary layout bounds across all 18 Effects. No Blueprint, Feature Timeline, Project, or Cloud schema/version changed. Preview and WebM continue through the same `renderEditorFrame` path; existing absolute-time evaluation and Region clipping remain in place.

Ink Diffusion received the largest coverage adjustment. The WebGL2 shader's density envelope and expansion front now extend farther from the central core across the Region-local domain. The Canvas2D fallback uses a wider time/response-dependent reach for its core, satellite clouds, and outward branches. The existing central source, deterministic time/seed variation, response smoothing, color/opacity handling, and fallback lifecycle remain intact. The fallback geometry can reach the Region edges at strong response; actual shader pixel coverage was not measured.

Other geometry changes:

- Circular/radial: Pulse Scale now uses independent Region width/height dimensions; Rotation Movement's base rectangle is larger; Waveform Ring, Wave Ring, and Radial Bars use Region-relative horizontal and vertical radii; Ripple and Shockwave expand against both Region axes; circular Oscilloscope uses an elliptical Region-relative path.
- Waveform and Spectrum: bars and lines retain Region-wide horizontal placement and use Region height for amplitude. Existing implementation already used the full Region dimensions, so no unrelated parameter changes were made.
- Particles and transforms: Particle Trail's vertical reach was increased. Particles already distribute across the Region emitter width; Particle Burst already expands from its configured Region-relative origin and was left unchanged. Glow Brightness already targets the whole Region.
- Ink: remains clipped by the common Region path, including polygon Regions.

## Tests

Added a renderer test that exercises all 18 Effect kinds with both a rectangle and polygon Region. It checks generated geometry width/height against the assigned Region and confirms that the common Region clip path is applied. Existing Ink tests continue to cover deterministic repeated timestamps, out-of-order evaluation, response variation, and fallback bounds. These tests inspect commands and geometry, not rasterized pixels.

Passed:

- `npm test -- --run` — 12 files, 129 tests
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `go test ./internal/blueprint ./internal/projects`
- `go vet ./...`
- `git diff --check`

## Compatibility and limits

No saved fields, defaults, validators, OpenAI schema, or version numbers changed. Existing Region clipping, color modes, opacity, binding evaluation, deterministic seeking, and shared Preview/WebM renderer path are preserved.

No browser executable was available. WebGL2 shader compile/link, actual Ink pixel coverage, polygon raster clipping, browser performance/FPS, and WebM pixel parity remain unverified. Consequently this report records automated geometry improvement, not visual acceptance.

## Changed files

- `frontend/src/renderer.ts` — Region-relative geometry sizing and Ink Canvas2D reach.
- `frontend/src/ink-webgl.ts` — wider Ink density envelope and expansion front.
- `frontend/src/editor-renderer.test.ts` — rectangle/polygon coverage regression across all 18 Effects.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md` — current implementation and visual acceptance status.
