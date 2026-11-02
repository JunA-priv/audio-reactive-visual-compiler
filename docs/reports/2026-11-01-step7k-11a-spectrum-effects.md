# Step 7k-11a — Frequency Spectrum Effects

**Status: partial**

## Result

Added an optional `frequencySpectrum` Timeline v1 field generated from the already decoded music PCM. It uses a 4096-sample Hann STFT, 20ms hop, 32 logarithmically spaced bands from 40Hz to `min(16kHz, Nyquist)`, whole-clip p99 normalization over positive `log1p(32 * bandRMS)` values, and row-major uint8 values in `[0,255]`. Silence produces zeros. With 44.1kHz decoded audio the maximum is 384,000 values for the four-minute Python Island duration limit.

Added `spectrum-bars` (32 segmented or continuous bars) and `spectrum-line`. Their shape uses FFT bands interpolated at render time. The existing seven-source Binding provides additional response strength. Attack/release is deterministic and cached from Timeline start; no prior-frame state is used. Missing Spectrum data emits no commands. Both Effects share existing color, opacity, visibility, Region clip, and `renderEditorFrame` paths.

The new UI-only Category `EQ / Spectrum` contains exactly the two new Effects. The prior Waveform membership is unchanged. Category remains derived from Effect kind and is absent from Blueprint/Project storage.

## Capacity and processing

- Synthetic 60-second full Feature Timeline (including existing waveform peaks, stem features, and Spectrum): **1,595,177 bytes** compact JSON. The API limit remains 2 MiB.
- Go request test with 60 seconds, quantized Spectrum, and all five signed peak arrays: **688,599 bytes**; validated under the same 2 MiB limit.
- Demo Spectrum sidecars, generated as compact JSON:
  - demo1, 180,200ms / 9,010 frames: **906,995 bytes**, FFT extraction **2.485s**.
  - demo2, 166,040ms / 8,302 frames: **826,015 bytes**, FFT extraction **2.283s**.
  - demo3, 118,054ms / 5,903 frames: **588,371 bytes**, FFT extraction **1.566s**.
- Demo processing re-decoded only each existing music file and computed FFT; no Demucs separation was run. Existing audio, stems, Timelines, and peaks were left intact. Sidecars were added under new generated/public paths. New demo sidecars are Git-ignored, and the Vite publication approval gate is unchanged.

## Changed files

- `python-island/src/python_island/features.py`: Spectrum extraction and Timeline field.
- `python-island/tests/test_features.py`: tone, silence, Nyquist, size, and serialization tests.
- `frontend/src/editor-model.ts`, `frontend/src/renderer.ts`: Spectrum types, validation, deterministic interpolation/followers, and draw commands.
- `frontend/src/VisualEditor.tsx`: independent Category, defaults, controls, and missing-data status.
- `frontend/src/demo-assets.ts`: optional versioned sidecar loading.
- `frontend/src/editor-renderer.test.ts`, `frontend/src/visual-editor.test.tsx`, `frontend/src/demo-assets.test.ts`, `frontend/src/project-file.test.ts`, `frontend/src/cloud-project.test.ts`: rendering, Category, missing-data, Project/Cloud v1, and loading coverage.
- `api/internal/service/input.go`, `api/internal/service/input_spectrum_test.go`: strict optional Timeline validation and fixed API cap coverage.
- `api/internal/blueprint/blueprint.go`, `api/internal/blueprint/blueprint_test.go`: Effect parameters and validation.
- `api/internal/service/openai.go`, `api/internal/service/openai_test.go`: Structured Output schema and compact-prompt checks. No API call was made.
- `.gitignore`: exclude the newly generated public Spectrum sidecars while retaining existing demo publication controls.
- `demo-assets/generated/demo{1,2,3}-step7k11/spectrum.json`, `frontend/public/demo/demo{1,2,3}.frequency-spectrum-v1.json`: new sidecars only.
- `docs/API_CONTRACTS.md`, `docs/ARCHITECTURE.md`, `docs/BLUEPRINT_SPEC.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TEST_STRATEGY.md`, `docs/VISUAL_EFFECT_ROADMAP.md`, `demo-assets/generated/README.md`, and `CURRENT_TASK.md`: updated contract and current state.

## Tests

- Python: `python -m pytest -q` — **24 passed**; `mypy --strict` — passed. `ruff check src tests --ignore E501` passed. Default Ruff reported existing E501 line-length violations in pre-existing code/tests; new lines were formatted within the project line limit.
- Frontend: `npm test -- --run` — **115 passed**; `npm run typecheck`, `npm run lint`, `npm run build` — passed.
- Python: `.venv/bin/python -m pytest -q` — **24 passed**; `mypy --strict` — passed; `ruff check src tests --ignore E501` — passed. Default Ruff still reports legacy E501 violations in pre-existing files.
- Go: focused Spectrum/Blueprint/schema/prompt tests — passed; `go vet ./...` — passed.
- Full Go suite was attempted. The existing `TestOpenAIResponsesRequestUsesStrictStructuredOutput` could not bind its IPv6 loopback `httptest` listener in this sandbox (`operation not permitted`), so the full service suite could not be certified here.
- `git diff --check` — passed.

## Compatibility and remaining checks

Blueprint v1, Feature Timeline v1, `.arvproj v1`, Cloud Envelope/Project v1, all seven Binding sources, and Preview/WebM renderer routing remain. Old Timeline objects omit `frequencySpectrum` and continue to validate. Raw matrix values are not in `CompactFeatures` or OpenAI prompt content. No dependency, DB, migration, Auth, quota, Hosted, or API size-limit change was made.

Status is partial because the complete Go suite is blocked by the existing sandbox IPv6 listener restriction. Real browser pixel/compositing quality and WebM playback are also not visually inspected in this environment.
