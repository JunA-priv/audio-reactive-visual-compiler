# Step 7k-11i — Ink Flow / Color Mixing

- status: partial

## Result

Added `ink-flow` and `color-mixing` as independent Effect kinds in the UI-derived `Ambient / Atmospheric` category. Existing `ink-diffusion` remains selectable; together, the editor classifies all 20 Effect kinds exactly once. Category is derived from Effect kind and is not serialized.

All three Ink Effects own independent Effect IDs, Region IDs, Bindings, visibility/reactivity settings, color mode and opacity. New Flow and Mixing Effects default to `music.energy`, Always visibility and Audio Reactive ON. They reuse the existing six optional Ink parameters, with Effect-specific Editor and AI-normalization defaults:

| Kind | Speed | Flow | Turbulence | Density | Scale | Response |
|---|---:|---:|---:|---:|---:|---:|
| ink-flow | 0.45 | 0.95 | 0.65 | 0.5 | 0.65 | 3s |
| color-mixing | 0.25 | 0.5 | 0.55 | 0.65 | 0.9 | 4s |

## Rendering

The existing Ink WebGL2 program/context, Region-sized transparent surface, Canvas2D composite, Polygon clip and fallback path are reused. A mode uniform selects the visual field:

- `ink-diffusion` continues to use the Step 7k-11j localized density mask, threshold, nonlinear alpha and premultiplied output. Its density and output-alpha calculations were retained.
- `ink-flow` emphasizes multiple curved stream ridges and moving vortex/noise fields. Its Canvas fallback uses deterministic curved stroked paths.
- `color-mixing` derives density from four moving pigment sources and weights the existing Global Gradient palette by their spatial contribution. Custom Color retains a single-color density field; Canvas fallback uses overlapping deterministic contours.

Each Effect is rendered as its own command in blueprint order, so they can overlap one Region without sharing binding/opacity state. Absolute timestamp, Timeline response, seed and Effect ID determine the output; no prior-frame fluid state was added. Preview and WebM continue through `renderEditorFrame`.

## Contract and compatibility

Frontend and Go validators accept the two additive kinds and validate the existing Ink parameter ranges. OpenAI Structured Output kind enum, prompt guidance and normalization defaults are synchronized; no OpenAI API was called. Project-file and Cloud-envelope roundtrip tests cover the new kinds without category fields. Blueprint, Feature Timeline, `.arvproj`, Project Document and Cloud Envelope versions remain v1. No new dependency, Timeline feature, Python Island change, DB/Auth/API migration, hosted operation or push was made.

## Tests

- `npm test -- --run`: pass, 136 tests / 12 files.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run build`: pass.
- `go test ./internal/blueprint ./internal/projects`: pass.
- `go test ./internal/service -run 'Test(OpenAISchema|OpenAIInk|OpenAINormalizesInk)'`: pass.
- `go vet ./...`: pass.
- `go test ./...`: blocked by the existing `httptest` IPv6 loopback bind in `TestOpenAIResponsesRequestUsesStrictStructuredOutput` (`listen tcp6 [::1]:0: operation not permitted`). No test was removed or disabled.
- `git diff --check`: pass.

Frontend tests cover category assignment, UI controls/default bindings, independent ordered renderer commands and payload modes, deterministic timestamp re-evaluation, fallback clipping, and `.arvproj v1` / Cloud v1 roundtrips. Go tests cover the new kind parameter validation, schema enumeration and normalizer defaults.

## Unverified

No browser, WebGL2 runtime or standalone GLSL compiler is available. Shader compile/link, actual GPU pixels, visual separation of the three treatments, context-loss/resize behavior, real WebM parity and FPS remain unverified. Consequently this is `partial`, despite automated checks passing.
