# Step 7k-11e — Ink Diffusion visual quality and rendering review

**status: partial** — Canvas2D was materially improved and automated checks pass. Actual browser pixels, WebM playback and raster FPS could not be inspected because no browser/Playwright executable is installed in the available environment.

## Canvas2D changes

The previous four separate centers with three concentric contours were replaced by three intertwined, rising plume ribbons and six tapered branch ribbons. The three plumes share a time-varying flow field with three local vortex centers. Their contours widen at several heights, fold asymmetrically, and overlap; the branches leave at different heights and curve around the same flow field. Harmonic spatial turbulence and slow time phase keep movement continuous and seek-stable.

Each plume has a soft outer wash and denser inner fill. The six branch ribbons add thinner, stretched flow. All use the existing Global Gradient in canvas coordinates or the existing Custom Color and normal Canvas `source-over` alpha. Effect Opacity is still multiplied by the common command path. Region clipping, draw order, and `renderEditorFrame` remain unchanged, so Preview and WebM call the same evaluation/render function.

## Work and performance bounds

- **12 path commands / Ink Effect:** 6 plume fills + 6 branch ribbons.
- **600 supplied contour vertices / Effect:** 384 vertices for the three double-layer plumes + 216 for six ribbons.
- **Four simultaneous Always Effects:** 48 commands and at most 2,400 supplied vertices per frame.
- A local Vitest command-generation probe evaluated 240 frames with four Ink Effects in **120.01 ms total (0.50 ms/frame)**, including initial response-cache construction. This measures JavaScript command evaluation only; it excludes browser Canvas rasterization, compositing and display FPS.
- The deterministic response table remains bounded at 12,001 values per cache entry, with 16 parameter variants per Timeline.

No PNG was produced: there is no browser, Playwright/Puppeteer, SVG rasterizer, or installed Canvas package in the environment. The repository reference images were inspected, but generated command geometry is not represented as a browser screenshot. Therefore reference similarity, perceived color mixing, demo1/demo3 appearance, and WebM image parity remain visually unverified.

## Automated checks

Tests now verify three broad plume paths, six tapered branch ribbons, their contour bounds and spatial union, nonzero opacity/Gradient, audio response scaling, under-1px contour displacement over 1ms, repeated/out-of-order seek determinism, Region clip application, and the existing Ink visibility/parameter behavior. The canvas test double validates submitted paths and clip calls; it does not rasterize them.

- `npm test -- --run` — passed, 126 tests.
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm run build` — passed.
- Go Blueprint/Project tests and targeted OpenAI schema/normalization tests — passed; no Blueprint/API contract changed.
- `go vet ./...` — passed.
- `git diff --check` — passed.

## Rendering technology assessment

| Option | Fit for this Ink-only effect | Tradeoffs |
|---|---|---|
| Continue Canvas2D | Current choice. Curved ribbons, procedural field, gradient fills, clipping and timestamp evaluation are all available in the existing path. No dependency or output pipeline change. | It approximates ink with geometry; there is no pixel-density field/advection, so volumetric diffusion and fine turbulent mixing are inherently limited without raster work. |
| Local WebGL2 shader | Strongest next candidate if browser review still rejects the result. A fragment shader can evaluate advected noise/density and color mixing per pixel. A transparent offscreen WebGL canvas could be composited with `drawImage` into the existing 2D surface, retaining the outer `renderEditorFrame` and capture path. | Requires Ink-only GPU resource lifecycle, shader compilation/fallback, alpha/color-space checks, context-loss handling and actual export validation. This has not been implemented or approved. |
| PixiJS | Provides WebGL/WebGL2 and WebGPU renderers plus displacement/noise filters and blend modes. | Adds a new dependency and a renderer lifecycle for one Effect. Its current docs label WebGPU as maturing/experimental and recommend WebGL for production, so it offers little advantage over a small local WebGL2 pass here. |
| WebGPU | Potential future GPU path. | Not needed for 2D ink; browser API availability and secure-context constraints add compatibility work. Future 3D interest alone does not justify it. |

The WebGL2 recommendation is conditional on a human/browser rejection after viewing these Canvas changes. WebGL supports accelerated 2D/3D browser graphics, and the existing 2D renderer can draw canvas image sources via `drawImage`; PixiJS documents WebGL as stable/recommended and WebGPU as experimental/maturing. References: [MDN WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API), [MDN drawImage](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage), [PixiJS renderers](https://pixijs.com/guides/components/renderers), [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API), [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).

No GPU implementation, dependency, schema, Timeline, Project, or Cloud contract change was made.

## Changed files

- `frontend/src/renderer.ts` — plume ribbons, shared flow field, vortex branches and denser interior contour.
- `frontend/src/editor-renderer.test.ts` — spatial union, branch shape, temporal continuity, response and clip regression checks.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md` — implementation status, performance bound and pending visual acceptance.

## Remaining acceptance

Run the Editor in a real browser with demo1 and demo3; inspect silence/weak/strong source states, one and several Ink Effects, Region clips, and exported WebM. Compare the actual frames to the saved ink reference. Measure raster frame time/FPS. If those frames still read as separate geometric ribbons rather than connected ink, keep Canvas2D unchanged until an Ink-only WebGL2 offscreen prototype is separately authorized and its Preview/WebM compositing and seek determinism are tested.
