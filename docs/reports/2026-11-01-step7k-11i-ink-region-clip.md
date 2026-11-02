# Step 7k-11i — WebGL2 Ink Region Clip fix

**status: partial**

## Cause

`renderEditorFrame` handled `ink-diffusion` before the normal Canvas command path. Normal commands go through `drawCanvasCommand`, which saves Canvas state and applies `pathRegion(...)` before painting. The WebGL route instead rendered into a Region-sized rectangular offscreen canvas and called `drawImage()` directly, before any Polygon clip had been established. The offscreen texture therefore composited over its full rectangular bounding box.

The Region vertices and normalized-to-Canvas conversion were correct. The missing operation was applying the existing Canvas clip around the destination `drawImage()` call.

The current frontend Effect union contains one Ink Effect kind, `ink-diffusion`. `ink-flow` and `color-mixing` are shader-level behaviors within that Effect, not separately registered Effect kinds, so the shared fix covers those visual parts as well.

## Fix

In `renderEditorFrame`, the WebGL Ink branch now:

1. saves the destination Canvas state;
2. applies the existing `pathRegion()` function using the command's Region and Blueprint dimensions;
3. renders/composites the rectangular WebGL offscreen image;
4. restores Canvas state in a `finally` block.

This uses the existing Polygon/Rectangle clipping mechanism and does not add a separate polygon-mask implementation. If WebGL is unavailable or fails, the temporary clip is restored and the Canvas2D fallback continues to draw through its existing per-command Region clipping. Effect ordering, opacity passed to the compositor, color handling, and the common Preview/WebM `renderEditorFrame` entry point are unchanged.

## Regression checks

Added a fake-context integration test for a diamond Polygon and a Rectangle. The test verifies the clip path is active at the WebGL `drawImage()` composite and that the fallback path commands are also painted with the appropriate clip. It checks state/order, not actual rasterized pixels.

Passed:

- `npm test -- --run` — 12 files, 130 tests
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `go test ./internal/blueprint ./internal/projects`
- `go vet ./...`
- `git diff --check`

One full test run executed concurrently with other frontend checks had an unrelated intermittent failure in the existing audio-restoration/WebM export UI test. A subsequent standalone full run passed all 130 tests.

## Compatibility and remaining verification

No Region geometry or persistence definitions changed. Blueprint, Timeline, Project and Cloud remain v1. No other Effect, API, dependency, DB, Auth, Python Island, or OpenAI behavior changed.

No browser executable was available. Actual Polygon outside-pixel preservation, shader/WebGL raster output, resize/Region-edit behavior on a real canvas, and WebM pixel parity remain unverified. Accordingly, the implementation and automated clip state/order checks pass, but visual acceptance is partial.

## Changed files

- `frontend/src/renderer.ts` — apply the existing Region clip during WebGL Ink compositing and restore state reliably.
- `frontend/src/editor-renderer.test.ts` — check Polygon/Rectangle clip at WebGL image composition and Canvas fallback painting.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md` — record implementation and outstanding visual acceptance.

## Stage bounds re-investigation

The Region clip fix above addressed polygon leakage but did not address the smaller visible Ink field. Comparing the default model and render data identified a separate issue:

- Blueprint Stage Region: normalized `x=.12`, `y=.14`, `width=.76`, `height=.72` on a 640×360 Blueprint, or x=76.8, y=50.4, width=486.4, height=259.2 logical pixels.
- `effectCommandLayers` uses `normalizedBounds(region)` and places the Ink command at exactly those bounds.
- WebGL offscreen pixel size is `ceil(region width/height × target canvas pixel scale)`; viewport matches that texture size.
- `drawImage()` destination is the same logical Region rectangle. Preview target size is Blueprint size; WebM uses a uniformly scaled backing canvas, matching transform and offscreen pixel scale.
- The fragment shader's `v_uv` already spans the Region-sized offscreen texture from 0 to 1. It incorrectly treated those values as full-Stage UVs and re-applied `(uv - regionOrigin) / regionSize`, discarding outer portions of the texture. This produced the smaller inner rectangle even when bounds and compositing destination were correct.

Changed the shader's density-field coordinate to `local = v_uv`. Gradient coordinates still map `Region origin + local × Region size` into Stage coordinates, so global gradient orientation remains stage-based. Density aspect continues to use Region width/height and Stage resolution. No padding, fixed inset or destination scaling was added. The existing destination Region clip from the first 11i fix remains active.

Added regression checks for the default Stage bounds, full-canvas and half-size Rectangle Region bounds, the exact WebGL compositor destination arguments, Region-local shader UV, and preservation of Stage-space gradient mapping. Polygon and Rectangle WebGL-composite clip state and fallback clipping remain covered.

After this re-investigation, `npm test -- --run` passed 12 files / 132 tests; `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. No browser is available, so actual Stage outline-to-pixel comparison, GPU shader compilation, rendered Polygon/Rectangle pixels, canvas resize in-browser, and WebM raster dimensions/parity remain unverified. Status remains partial until visual acceptance.

Additional changed files for the re-investigation:

- `frontend/src/ink-webgl.ts` — use Region-local offscreen UV for density evaluation while keeping stage-space Gradient mapping.
- `frontend/src/ink-webgl.test.ts` — prevent regression to double application of Region transform.
- `frontend/src/editor-renderer.test.ts` — verify Stage/Rectangle bounds and compositor destination values.
