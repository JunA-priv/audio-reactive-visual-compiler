# Step 7k-11f — Ink Diffusion WebGL2 rendering

**status: partial** — The Ink-only WebGL2 path and Canvas2D fallback are implemented, and automated frontend/Go checks pass. This environment has no browser, WebGL2 implementation, or standalone GLSL compiler, so shader compilation, GPU pixels, WebM appearance and real frame time remain unverified.

## Result

`ink-diffusion` now evaluates to one Ink render command. In a browser with WebGL2, its transparent offscreen surface is rendered by a WebGL2 fragment shader and composited at the same Effect draw-order position onto the existing Canvas2D output. Other Effects remain Canvas2D. Preview and WebM still use `renderEditorFrame`; WebM captures the same composited output canvas.

The shader evaluates a continuous density field per pixel. Five octave value noise warps the field over absolute time; three localized analytic vortex warps curl it; a narrow procedural ridge term creates fine ink filaments. Density controls alpha and inner pigment concentration. Global Gradient colors are sampled in the existing full-stage coordinate system and angle; Custom Color uses one pigment with density-based tonal variation. The shader produces premultiplied-alpha color for the transparent offscreen surface.

Existing `diffusionSpeed`, `flowStrength`, `turbulence`, `inkDensity`, `cloudScale`, and `responseTime` values are retained. Existing deterministic smoothed Binding response drives flow, vortex strength, density and expansion. `music.energy` remains the default Binding, and all seven source choices and Event/Continuous conversion remain unchanged. Always mode continues autonomous low-speed drift when the response is zero. Shader inputs are derived from Blueprint seed / Effect ID, Timeline response and absolute timestamp; no prior frame state is accumulated.

## Resource and fallback behavior

- One transparent WebGL2 offscreen canvas is reused for each 2D output canvas. The surface is sized to the Ink Region in output pixels, including export scale, then resized when required.
- At most four output-canvas renderer entries are retained. Least-recently-used eviction deletes the buffer/program and requests `WEBGL_lose_context` to release the context.
- Context loss prevents default browser destruction behavior, falls back to Canvas2D while lost, and rebuilds shader resources after context restoration.
- Missing WebGL2, context creation failure, shader compile/link failure, GL error, or `drawImage` failure falls back to the previous deterministic 12-path Ink geometry. This is local to Ink and does not stop other Effects or the application.
- The destination renderer applies the existing Region clip and command opacity before compositing. Polygon clipping, Effect order and 2D output remain in the existing path.

## Performance and visual verification

No GPU/FPS measurements are available. The shader evaluates per fragment over the Ink Region rather than the whole stage; actual GPU cost depends on browser, device, resolution, fill overlap and number of Ink Effects. The previous Canvas2D path remains available as the fallback, but the GPU route is the intended main path where initialization succeeds.

No Chromium, Chrome, Firefox, Playwright/Puppeteer, or GLSL compiler is installed in the execution environment. Consequently the following are **not verified**: actual shader compile/link, real browser image, context loss/restore behavior, visual noise/mixing quality, demo1/demo3 appearance, GPU frame time/FPS, and WebM playback or pixel parity. Static shader-source checks and the fake Canvas tests are not treated as visual acceptance.

## Compatibility

- No Blueprint, Feature Timeline, Project, or Cloud field/version changed.
- No Go/API, Python Island, DB, Auth, Hosted, OpenAI API, or dependency changes.
- Existing 17 Effect kinds, Ink's six parameters, seven Binding sources, Region, opacity, Gradient/Custom Color, Visibility and Audio Reactive semantics remain.
- Existing Preview/WebM shared `renderEditorFrame` path remains.

## Tests

- `cd frontend && npm test -- --run` — passed, 128 tests / 12 files.
- `cd frontend && npm run typecheck` — passed.
- `cd frontend && npm run lint` — passed.
- `cd frontend && npm run build` — passed; Vite bundle 364.50 kB (111.77 kB gzip).
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go test ./internal/blueprint ./internal/projects` — passed.
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go vet ./...` — passed.
- `git diff --check` — passed.

Frontend tests check shader source structure, density/noise/vortex/color uniforms, deterministic render-command payload and legacy fallback geometry/clip. These do not compile GLSL. Go tests are contract regression checks; Go source and schema were not changed.

## Changed files

- `frontend/src/ink-webgl.ts` — Ink-only WebGL2 shader, context cache/lifecycle, resize, compositing and fallback result.
- `frontend/src/renderer.ts` — one Ink shader command per Effect and dispatch through the shared render path, retaining prior Canvas paths as fallback.
- `frontend/src/ink-webgl.test.ts` — static shader structure and unavailable-context fallback checks.
- `frontend/src/editor-renderer.test.ts` — Ink shader payload, fallback, response, opacity, deterministic evaluation and clipping regression checks.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md` — status, architecture, test limits and pending browser acceptance.

## Remaining acceptance

Run the Editor in a WebGL2 browser and verify shader compile/link, demo1/demo3 at quiet/weak/strong response, custom and global colors, rectangle and polygon clips, multiple Ink Effects interleaved with other Effects, resizing, context loss/restore, and WebM playback. Measure region-sized GPU frame time at normal and 2× export resolutions. If the GPU path fails, verify that the Canvas2D fallback remains visible and that non-Ink Effects continue rendering.
