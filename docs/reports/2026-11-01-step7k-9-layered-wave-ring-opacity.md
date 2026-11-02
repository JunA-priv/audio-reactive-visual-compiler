# Step 7k-9 — Layered Wave Ring and Effect Opacity

**Status: partial**

## Result

Added optional Effect-wide `opacity` (0..1, default 1) for all 15 existing Effect types. The renderer multiplies it into each command's existing alpha, preserving effect-specific fades, Binding response, gradient/custom colors, Region clip, and draw order. New Editor Effects start at opacity 1, and in-place Type changes retain it.

Wave Ring now supports optional `layerCount` (1..6), `layerRadiusStep` (0..0.1), `layerAngleOffsetDeg` (0..360), and `layerAmplitudeDecay` (0.5..1). New Editor Wave Rings start with four layers; legacy Blueprints with omitted fields remain single-layer. Angle step 0 means automatic equal spacing; a positive value means the manually specified separation between adjacent layers. Each layer shifts both path angle and sampled signal phase, changes radius by the configured step, and scales amplitude by `decay^layerIndex`. The source sample sequence is evaluated once and reused. BPM rotation remains shared across layers and deterministic by timestamp.

Blueprint v1, `.arvproj v1`, Cloud v1, Timeline v1, Category → Type, Binding source, Gradient, and shared `renderEditorFrame` behavior remain unchanged. OpenAI strict schema includes opacity/layer fields; normalization supplies defaults for new generated output. No OpenAI API call was made.

## Changed files

- `frontend/src/editor-model.ts`: Effect opacity and Wave Ring layer types/validation.
- `frontend/src/renderer.ts`: common opacity multiplication and deterministic multilayer Wave Ring generation.
- `frontend/src/VisualEditor.tsx`: defaults, controls, and opacity retention on Type changes.
- `frontend/src/editor-renderer.test.ts`, `frontend/src/visual-editor.test.tsx`, `frontend/src/project-file.test.ts`: opacity controls/retention, layer count and phase, deterministic evaluation, and v1 serialization coverage.
- `api/internal/blueprint/blueprint.go`: matching validation and range checks.
- `api/internal/blueprint/blueprint_test.go`: opacity/layer validation cases.
- `api/internal/service/openai.go`: strict schema, normalization, and prompt additions.
- `api/internal/service/openai_test.go`: schema and normalization tests.
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/BLUEPRINT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md`: current contract and verification status.

## Tests

- Frontend `npm test -- --run`: **105 tests passed**.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed.
- Go `go test ./internal/blueprint ./internal/projects`: passed.
- Go OpenAI schema/normalization/rotation targeted tests: passed.
- Go `go vet ./...`: passed.
- `git diff --check`: passed.

Go service full package tests were attempted but `TestOpenAIResponsesRequestUsesStrictStructuredOutput` could not start because sandbox denied `httptest.NewServer` IPv6 loopback binding (`listen tcp6 [::1]:0: operation not permitted`). The test was not modified or disabled. Real browser pixel/WebM comparison was unavailable and remains unverified.

## Compatibility and scope

All schema additions are optional additive Blueprint v1 fields. Old effects default to opacity 1 and old Wave Rings render one layer. No Feature Timeline, Project, Cloud version, database, auth, dependency, hosted environment, or renderer architecture changes were made. Existing BPM/triggered rotation and Preview/WebM renderer path remain in use.

## Remaining issues

- Run the complete Go service suite in an environment that permits local IPv6 loopback binding.
- Visually inspect multilayer appearance, opacity compositing, Region clipping, and exported WebM in a real browser.
