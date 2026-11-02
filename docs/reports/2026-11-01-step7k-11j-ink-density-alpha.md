# Step 7k-11j — Ink Diffusion density and transparency

**status: partial**

## Investigation

The shader's broad envelope contributed `cloudEnvelope * (0.42 + u_density * 0.25)`, while the threshold began at `0.19`. This left a substantial density baseline across most of the Region before adding the core, satellites, expansion front and noise. The smoothstep threshold also began well below the nominal threshold, so weak background density was converted to nonzero ink alpha over a large area. The shader then scaled alpha nearly linearly with this mask.

Global Gradient does not independently paint the Region: it selects the pigment color, and the fragment output alpha gates that pigment. Custom Color follows the same alpha path. The WebGL context requests `premultipliedAlpha: true`, and the shader already outputs `vec4(color * alpha, alpha)`, which is the correct premultiplied form for Canvas2D `drawImage()` composition. The Region-local UV and Stage-space Gradient mapping from the 11i re-investigation were retained.

## Change

In `frontend/src/ink-webgl.ts`:

- Reduced the broad cloud envelope to a weak carrier (`0.075 + inkDensity * 0.12`) and narrowed its radial falloff.
- Kept the central Gaussian core, satellite sources, moving expansion front, turbulence and flow filaments as localized density structures.
- Increased the density threshold and made it respond to ink density and audio response. The tighter smoothstep transition leaves sub-threshold regions transparent and irregular noise creates openings at density boundaries.
- Changed alpha to `pow(ink, 1.6)` multiplied by density/expansion gain, concentrating opacity in denser regions instead of preserving a broad linear wash.
- Preserved premultiplied output (`color * alpha`) and existing effect opacity at the Canvas2D composite boundary, avoiding duplicate application of Effect opacity.

No Effect parameters, Blueprint/Timeline/Project/Cloud schemas, versions, binding behavior, Region clipping, WebGL lifecycle, or other Effects changed.

## Tests

Added shader contract assertions for the weaker envelope, response-aware threshold, localized smoothstep mask, nonlinear alpha, and premultiplied output. Existing tests cover Region-local UV and stage-space Gradient coordinates.

Passed:

- `npm test -- --run` — 12 files, 133 tests
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `git diff --check`

## Visual verification and limits

No browser executable or GLSL compiler is available in the environment. The current tests inspect shader source and renderer contracts; they do **not** prove actual pixels have transparent gaps or establish zero-alpha share, high-alpha share, center/outer mean alpha, coverage change with time/audio, or perceived ink appearance. Shader compile/link, browser alpha readback, Polygon pixels, and Preview/WebM visual parity remain unverified. Therefore status is partial pending real-pixel review.

## Changed files

- `frontend/src/ink-webgl.ts` — localized density mask, weaker broad field, nonlinear alpha; Region-local UV and premultiplied output preserved.
- `frontend/src/ink-webgl.test.ts` — shader contract regression checks.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md` — implementation and visual verification status.
