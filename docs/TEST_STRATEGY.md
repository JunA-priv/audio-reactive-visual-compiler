# テスト戦略

FACT / PARTIAL（Step 7k-30）：MediaRecorder mockでWebM既存経路とMP4 silent/H.264、audio/H.264+AAC、対応判定、MIME/container不一致、録画constructor/start/runtime/stop/empty-output failure、track cleanupを検証する。Editor UIはWebM初期値、音声modeごとのMP4有効状態、形式に応じたexporter dispatchを確認する。実ブラウザでのcodec選択、MP4実ファイル生成・ffprobe/再生・音声同期はmock testで代替せず、browser acceptanceとして別記録する。

FACT（Step 7k-20）：newEditorBlueprintを既存Blueprint validatorへ通し、新規Editor UIのEffect順、Category/Type、共通カラー/色値、Opacity/Visibility/Audio Reactive/Stage Region、music.energy Binding値を検証する。Effect固有のSpectrum/Ink detail defaultsも検証。既存initialEditorBlueprintはDemo/Fixture用として同じテストで保持を確認し、Project/Fixture responseの読み込みtestは別契約として維持する。

FACT（Step 7k-19）：現行Editor UIはCloud Project操作を表示せず、認証欄のみ維持する。UI結合testでCloud section/操作非表示、ログイン維持、自動Project list requestなし、ローカルProject file操作の存在を検証する。Cloud API adapter/Cloud Envelope契約testは保留中機能の内部契約として維持し、UI表示testと区別する。ローカルAuth/Project/Asset統合testとWindows browser受け入れは別途環境確認を要する。

FACT（Step 7k-18）：円形/放射型Effectのgeometry testsは16:9・1:1 Stage、横長/縦長Rectangle、Polygon clipを通し、最終Canvas pixel半径のX/Y一致、中心位置、Region clipを確認する。radial Effectの座標も実pixel距離で評価し、`renderEditorFrame`の共有経路を対象にする。Audio Source/Binding表示ラベルのUI testsは7つの既存source key/順序とユーザー向け表示を確認する。実ブラウザ実画素・UIの手動確認は自動テストの範囲外。

FACT（Step 7i provider移行）：Go OpenAI REST MockはResponses request、GPT-6 Luna allowlist、Strict Structured Outputs、11 Effect enum、input token count、usage mapping、refusal/incomplete/invalid JSON、HTTP error/429/5xx、timeout、no retry、機密情報非露出を検証。既存Go validatorがBlueprint v1を最終検査する。実OpenAI APIは呼ばず、model利用可否/実schema受理/実usageは未確認。

DECIDED：仕様に対して実装を検証し、成功ログだけで要件充足としない。実行環境・コマンド・結果をreportsに記録する。

FACT（Step 7j）：Frontend audio processing tests verify RIFF PCM16 stereo header/sample conversion, selected-range frame count, decode-context cleanup, Bearer auth and that only the crop File is sent. Editor interaction test verifies app generation is gated until clip analysis succeeds; fixed `/demo` test verifies no backend/provider calls and full fixed audio clock. Go audio-analysis tests cover JWT gate, malformed WAV, >60s, >16MiB, global single-flight 429, timeout, cleanup and invalid Python output. An optional local integration test (`ARVC_AUDIO_ANALYSIS_INTEGRATION=1`) invokes the existing Python Island CLI through the real Go handler against a synthetic 2-second WAV; it requires preinstalled dependencies/model cache and performs no model download. Success requires Timeline/Summary duration and actual clip byte count to match. Hosted and visual browser E2E remain separate.

FACT（Step 7h-3.5）：Python CLI tests cover optional 4-stem PCM16 WAV persistence without changing the default JSON-only CLI contract. Three supplied tracks were each run once through cached CPU htdemucs; source duration, stem WAV format/duration, Timeline schema/time origin/finite values/kick strengths/drum energy, Summary and metadata were checked. Frontend tests verify three track-to-asset mappings, Timeline validation failures, selection/switch reset, matching static audio/Timeline URLs, currentTime clock sync, and no non-static/backend requests. Windows Chrome playback and rendered-pixel judgment remain manual checks.

FACT（Step 7k-1）：Frontend renderer tests cover optional styled parameters, legacy Glow behavior, pseudo Oscilloscope response/determinism under seek-order changes, and Region clipping. UI and `.arvproj v1` roundtrip tests cover creating/editing/saving the new Effect; Go tests cover Blueprint and Project/Cloud v1 acceptance plus strict Structured Output schema support. Automated checks do not assess actual browser pixels, perceived waveform quality, or WebM playback/FPS; human browser review remains required.

FACT（Step 7k-2）：Python tests cover low-band Kick and mid/high Snare-like synthetic transients, 10ms vocal/other/music envelopes, silent/boundary and finite/range/order behavior, and deterministic Timeline v1 output. Frontend tests cover source-type compatibility, inactive new source on legacy Timeline, demo v2 timeline validation, rendering and seek determinism. Go tests cover additive Project Timeline v1 fields, event alignment, all Binding source enum values and strict OpenAI schema. Demo timings validate original PCM/stem frames against prior duration. Actual musical Snare precision/recall and browser visual judgment remain human-review items.

| 対象 | 必要な検証 |
|---|---|
| Renderer | 同一時刻の命令一致、シーク順序/FPS非依存、特徴量境界、seed |
| Region | 正規化座標、矩形/多角形の作成・編集・削除、clip範囲 |
| Visual Editor | 背景、全Effect/Binding、Region編集、play/pause/stop/seek、固定入力の再現性 |
| Blueprint | スキーマ、不正参照、範囲外、互換性 |
| Python | 4 Stem、Kick推定、実音源評価、時間・最大メモリ |
| API/Auth | JWT拒否、他所有者拒否、制限、ジョブ失敗・二重実行 |
| export/import | 音声同期、無音、復元、改ざん拒否 |

FACT（2026-10-31）：Visual EditorのRenderer・Canvas fake-context・UI結合テスト（矩形/多角形の作成・編集・削除、関連Effectの削除、割当Regionに対応するclip path）、TypeScript型検査、ESLint、Vite buildがWSL2上で成功。実画素のoutside-region比較はブラウザCanvas E2Eで未実施。今回の調査結果はreportsを参照。GitHub ActionsのGitHub上の実行結果も未確認。動画品質や分離品質は人による評価も必要。

FACT（Step 7h-1）：Radial Bars/Wave RingについてEffect schema境界・音響Binding応答・Region clip・時刻の任意順評価再現性・`.arvproj v1`往復・Editor追加操作・Go project/Blueprint validator・Gemini Structured Output enum/schemaを自動テスト。PreviewとWebMは同じ`renderEditorFrame`関数を使うことをコード経路で確認。ブラウザ実画素の芸術品質、実ブラウザでの新Effect WebM再生は自動テストでは未評価。

FACT（Step 7h-2）：Particle Burstの発生前・寿命中・終了後、粒子数範囲、Kick Binding制約、TrailのTimeline反応・最大サンプル数、シーク順独立性、Region割当、`.arvproj v1`往復、Cloud/Project v1 Go validator、Gemini Structured Output enum/parametersをFrontend/Go testsで検証。Canvas fake-contextは既存Region clip経路を通る命令を検証し、Preview/WebM共通経路はコード上`renderEditorFrame`共有を確認。ブラウザ実画素の見た目、実WebM再生・フレーム落ち・性能の視覚確認は未実施。

FACT（Step 7h-3）：Ripple Bass response/path count、Shockwave Kick onset/lifetime/multiple event/cap、任意順時刻再現性、Region assignment/clip、Glow legacy output preservation・optional intensity・limits、UI controls、`.arvproj v1`往復、Go Project/Cloud validator、Gemini schema fieldsを自動検証。Renderer命令は既存Canvas clip経路で描画し、Preview/WebM共通関数利用をコード上確認。実ブラウザ実画素・WebM再生・FPS計測は未実施。

FACT（Python Island）：12 unit/CLI tests passed; Demucs実モデルCPU結合test passed (same input repeated output arrays equal); Python Ruff/mypy and Frontend 14 Vitest tests/typecheck/ESLint/build passed。4分計測は合成WAVによる性能確認のみで音楽品質の評価ではない。pip-auditはPyPIで照会可能な依存に0件、PyTorch CPU wheelは照会不能のため公式advisory別確認。詳細/制約はPython Island報告を参照。

FACT（Step 5、2026-10-31）：`api/`の`go test ./...`と`go vet ./...`成功。HTTP/validation testsは正常Fixture、malformed/missing/oversized input、数値/Version/参照不整合、Gemini timeout/429/5xx/不正JSON/schema不一致、キー無しFixture、秘密情報非露出を確認。Frontend Vitest 15件、typecheck、ESLint、Vite build成功。Geminiはmockのみで外部API疎通なし。Pythonコード変更なしのためPython回帰は未実施。

FACT（Step 5.5、2026-10-31）：Go tests/vet成功。Gemini 3.8用requestでtemperature/top_p/top_kを使わないこと、成功応答にmodel version、usage metadata（取得時）、latency、Blueprint validation statusが含まれることをmockで確認。Fixture API smokeはhealth/generateともHTTP 200、Blueprint構造assert成功。Frontend 15 tests/typecheck/lint/build成功。実ブラウザ画面は未確認。

FACT（Step 7b、2026-11-01）：Go unit tests/vetとlocal Auth integrationが成功。Auth integrationはlocal Supabase Authの実user JWTを2名分使い、owner CRUD/404分離/concurrent revision conflict/cursor pagination/direct Data API RLS/owner spoof/20件・1 MiB制約を検証。JWT crypto unit testsはJWKS/ES256署名とclaim failureを確認する。Frontendは変更なし、5 files/32 tests・typecheck/lint/build成功。Integration用service_roleはテストuser cleanupだけに限定。新規local Supabaseでmigration 007のschema-owner適用を再現するテストは未実施。詳細は[Step 7b報告](reports/2026-11-01-step7b-auth-project-crud.md)。

FACT（Step 7d、2026-11-01）：Frontend auth clientのpassword login/refresh/logout・tab session復元・loopback URL制限とGo cloud API adapterをmockで検証。Cloud UIのmock save、Asset upload/retry、Cloud Envelope hydrate、ProjectDocument v1 compatibilityを構造検証する。今回8 test files/45 tests、typecheck/lint/build成功。実ブラウザが環境にないためSupabase Auth CORS、session refresh、Project CRUD、Storage roundtrip、visual/audio outputとの組合せは未確認。ローカルGo integration testsはStep 7c-1報告の実Auth JWT/DB/Storage検証を再利用し、今回Go code/DB schemaは変更していない。

FACT（Step 7k-17、2026-11-02）：Local `.arvproj v1` save/load tests cover optional Music Summary with backward-compatible v1 files lacking Summary, analyzed 60s PCM16 stereo 44.1kHz WAV plus Timeline/Blueprint/SHA-256, summary-to-audio/timeline consistency, malformed WAV, missing audio, unsupported schema, oversize/corrupt files, and editor-state preservation. UI integration restores AudioElement playback/seek/stop and regenerates Blueprint without Audio Analyze. Large Base64 validation must avoid a repeated-group regex that overflows on the 60s clip.
# Step 6の出力とProject検証

単体テストでは`MediaRecorder`、Canvas capture stream、Web Audioをmockし、無音／音声あり出力の設定、frame time評価、codec拒否、キャンセル時cleanup、Projectの保存・復元往復、サイズ／version検証、音源整合性を確認する。これらのテストでは、実ブラウザーのcodec対応、最終WebMのduration、音声と映像の同期、再生、視覚品質は確認できない。実際のローカル素材を使う手動ブラウザーテストが必要であり、mock／APIテストとは分けて記録する。

FACT（Step 7k-4〜7k-7）：Python tests cover signed peak extraction, 20ms window metadata, silence/boundary values, and 60-second payload size. Frontend tests cover peak validation/loading, waveform commands, source conversion/seek determinism, clipping, UI/source retention and project v1. Go tests cover optional Timeline v1 peak validation, all Effect/source pairs and OpenAI schema; related tests and vet passed. Full Go suite has one sandbox-only failure: httptest cannot bind IPv6 loopback. Browser pixel and actual WebM playback/FPS checks remain manual.

FACT（Step 7k-11a）：Python tests cover low/mid/high tone band detection, silence, nonfinite input, reduced Nyquist, frame sizing, and 60s compact Timeline size. Frontend covers 32-band validation/loading, Spectrum bars/line response, attack/release and seek-order determinism, missing-data inactivity, EQ Category isolation, and `.arvproj v1` roundtrip. Go covers Timeline Spectrum bounds, 2MiB request size, Blueprint effect params and OpenAI schema. Full Go service test/vet status is recorded in the Step 7k-11a report; real browser pixel/WebM rendering remains a manual check.

FACT（Step 7k-8）：Python validates Kick interval BPM estimates at 60/120/180 and octave-folded extremes, plus sparse/irregular fallback. Frontend tests validate 60/120/180 BPM × 4/8/16/32 beats/revolution periodicity, triggered integration, arbitrary seek order, pause-equivalent repeated-time evaluation, BPM metadata rejection, Editor defaults, and Project/Cloud v1 roundtrip. Go tests cover Blueprint rotation enums/ranges, Timeline BPM pair/source/fallback constraints and OpenAI nullable normalization. Preview/WebM share `renderEditorFrame`; actual browser frame comparisons remain manual.

Step 7k-8 Python Ruff note: `ruff check src tests` currently reports 16 E501 line-length findings in existing Python Island code/tests; the newly added BPM test line was formatted. Mypy passed.

FACT（Step 7k-9）：FrontendはOpacity 0/中間/範囲外、Wave Ring 1〜6層、層位相差、描画決定性を検証。Frontend 105 tests/typecheck/lint/build成功。GoはOpacity/layer range・外半径上限、v1 legacy、OpenAI schema・normalizationを検証し、Blueprint/Projectと関連serviceテスト、go vet成功。service全suiteにはsandbox IPv6 loopback bindでhttptest起動不能の既存環境制約がある。実ブラウザ画素/実WebM比較は未実施。

FACT（Step 7k-10）：Frontend tests cover Wave Ring auto offsets (3/4/10 layers), manual step, 10×256 sample bounds, Always baseline / no fabricated Burst or Peak data, non-reactive mode, BPM Continuous rotation coexistence, all 15 Effect UI controls, and v1 persistence. Go tests cover layer count 10/11, enum/boolean and invalid reactive/visibility pairs, legacy omission, and OpenAI schema/normalization. Frontend 109 tests/typecheck/lint/build and Go targeted tests/vet passed. Go `./...` remains blocked by sandbox IPv6 loopback binding in existing service httptest; actual browser/WebM verification is pending.
# Step 7k-11b Kick detection

Python synthetic labeled cases compare the legacy baseline and candidate detector on impulse Kicks, weak Kicks, 140ms double Kicks, Kick+Snare coincidence, Snare-only, 115Hz Tom-only, sustained Bass, silence, low background noise, deterministic repetition, Timeline boundaries, and normalized aligned strengths. The three local demo drums stems are also compared with both detectors for event timestamps, strength distributions, runtime, and process peak RSS; because they have no manual labels, event-count reductions are diagnostic only and do not establish real-song precision/recall. Go/Frontend Timeline validators remain unchanged and are covered by their existing v1 tests.

## Step 7k-22 Kick evaluation tooling

`python-island/src/python_island/kick_evaluation.py` evaluates local PCM16/44.1kHz WAV with manually annotated onset JSON. It reports deterministic one-to-one matches (default inclusive ±80ms, configurable), TP/FP/FN, precision/recall/F1, onset error, gate rejection diagnostics, and one-condition-at-a-time offline ablations. A test asserts diagnostic baseline event times equal the production detector. Matching tests cover duplicate predictions, unmatched events, and exact tolerance boundaries. No acoustic labeled recording was present in the repository or searched local evaluation paths, so this tool is validated using synthetic fixtures only; it does not yet provide acoustic real-song accuracy. Frontend renderer tests separately cover how Kick event strengths interact with Binding Threshold and Strength. Detector implementation and Timeline/API contracts are unchanged.

## Step 7k-23 acoustic dataset candidate preparation

`audio-reactive-silent-demo4.mp3` was processed once using the existing cached CPU htdemucs 4.1.0 pipeline. The four PCM16 stereo/44.1kHz stems and Timeline/Summary/metadata are local-only under `demo-assets/stems/demo4-kick-evaluation/` and `demo-assets/generated/demo4-kick-evaluation/`. The candidate review JSON contains 2,925 score-local-maximum timestamps, including 138 accepted by the current detector, with gate values and unverified status. The source is not documented as acoustic or licensed in the source README; listening and labels were unavailable. Do not use this candidate file as an evaluation manifest or report accuracy. Human-confirmed Kick and categorized negative labels are required before running the Step 7k-22 evaluator.

## Step 7k-11c

Frontend renderer tests check rising-field spatial distribution, response scaling, always/triggered and non-reactive behavior, deterministic arbitrary seek, all-quadrant Burst distribution, swirl, and continuous-to-event conversion. Editor and Project/Cloud tests cover controls and v1 roundtrip. Go tests cover optional parameter validation, legacy omission, Project/Cloud documents, and AI normalization/schema. Actual browser pixels/WebM playback remain a separate manual acceptance check.

## Step 7k-11d

Ink Diffusion tests verify twelve closed filled cloud paths, nonzero opacity, shared Gradient resolution, changing absolute-time contours, repeated/out-of-order seek equality, Always behavior without reactivity, Triggered silence/source response, parameter range validation, Editor category/default music Binding, and `.arvproj v1`/Cloud/Project v1 preservation. These command-level tests do not establish perceived fluid quality or real Canvas FPS; perform a browser visual review when available.

## Step 7k-11e

Renderer tests check the plume bounds and union coverage, body/branch command counts and vertices, branch curvature, under-1px movement across a 1ms step, deterministic arbitrary seek, binding response, Region clip, opacity and gradient. A separate local command-evaluation probe measured four always-visible Ink Effects over 240 timestamps; it does not measure Canvas raster time or browser FPS. Human visual comparison against the reference remains pending because a browser/Canvas rasterizer is unavailable.

## Step 7k-11f

Frontend tests check Ink shader source structure, density/noise/vortex/color uniforms, deterministic Ink command parameters, prior-geometry fallback command generation, Ink clipping, response, and shared renderer execution. These tests do not compile or rasterize GLSL. The environment has no browser, WebGL2 context, or standalone GLSL compiler; shader compile/link, context-loss/restore, actual pixel color/opacity, resize, GPU performance, and WebM playback/parity require browser verification. Go schema is unchanged; related Go Blueprint/Project tests and `go vet ./...` are run as contract regression checks.

## Step 7k-11g

Frontend tests compare deterministic shader payload/expansion at repeated and out-of-order timestamps, assert increasing Canvas fallback bounds at 0/3/8 seconds, compare quiet and strong Binding bounds, check center/cloud/branch contour counts, and retain Region clip assertions. Shader source checks cover the central density core, expansion radius/front, multiple noise phases and flow paths. These checks validate input/geometry changes, not rasterized WebGL2 pixel coverage; actual 60–90% visual reach and silhouette variation remain browser acceptance items.

## Step 7k-11h

Renderer geometry tests run all 18 Effect kinds against rectangular and polygon Regions, verify minimum geometry extents relative to Region bounds, and confirm the shared clip path is applied. Ink fallback commands are included in extent calculations; existing Ink tests cover repeated-time and out-of-order determinism. These are command/geometry checks, not pixel coverage. Browser shader compilation, rasterized Ink coverage, WebM visual parity and FPS remain manual acceptance items.

## Step 7k-11j

Shader-source regression checks verify a weak broad envelope, localized density threshold, nonlinear alpha concentration, Region-local UV, stage-coordinate Gradient mapping and premultiplied output. These checks guard the formula contract but do not establish actual alpha coverage or perceived transparency. Browser/GPU verification should read the offscreen alpha channel for zero/low-alpha share, high-alpha share, center-versus-edge means, and response/time changes, while also checking Gradient and Custom Color compositing.

## Step 7k-11i Ink Effect contracts

Frontend tests cover the 20-kind Category assignment, independent Ink command modes and order, per-Effect Binding/opacity, deterministic seek, Canvas fallback and Project/Cloud v1 roundtrip. Go tests cover both new kinds' optional numeric ranges and OpenAI enum/default normalization. Source-level shader checks ensure Flow stream and Mixing pigment branches coexist with Step 7k-11j's premultiplied localized-alpha contract. Static/command tests do not prove shader compilation or perceived appearance; browser WebGL2, raster and WebM acceptance remains required.

## Step 7k-11k custom Ink palette

Test Color Mixing palette lengths 2, 3 and 4, invalid length/type/HEX, rejection on non-Mixing kinds, Editor add/remove/color changes, shader payload source colors, custom fallback colors, and `.arvproj v1` / Cloud v1 roundtrip. Source tests ensure Flow uses broad stream density, Mixing has per-source warps and density-weighted colors, and the Diffusion localized alpha contract remains. These are contract and shader-source checks; actual GPU pixel mixing, Flow width/perceived fluidity, browser shader compilation and WebM visual parity require real-browser acceptance.

## Step 7k-11 integrated acceptance

The integrated run checks Frontend 20-kind renderer/editor/validator/project tests, all seven source contracts, Python feature pipeline tests, Go Blueprint/Project/schema tests, and `go vet`. Record environment-blocked suites separately: full Go tests may require IPv6 loopback for existing `httptest` servers, and Ruff E501 findings must be compared with unchanged baseline files. Demo acceptance includes probing source audio duration and checking Timeline/Spectrum sidecar lengths, but file presence is not proof of playback or synchronization. Browser acceptance must exercise Stage/Rectangle/Polygon clipping, WebGL2 compile/context lifecycle, all Effects and Sources, actual Demo playback, Preview/WebM raster parity and playback, and measured frame/resource performance. If no browser/GPU runtime exists, mark these as unverified and keep overall status partial.

## Step 7k-13 browser / WebM integration acceptance

2026-11-01 WSL run: Frontend 12 files / 139 tests, typecheck, lint and build passed; Go audioanalysis/blueprint/projects and selected Fixture service tests plus `go vet ./...` passed; Python pytest 27 and `mypy --strict src` passed. Strict mypy over tests reports pre-existing annotation/TypedDict errors; Ruff reports 16 existing E501 findings. ffprobe identified a local MP3 and FFmpeg decoded a 30s-offset 10s PCM16/44.1kHz/stereo clip. The existing Windows Chrome executable could not start from WSL (`UtilBindVsockAnyPort` interop failure); there was no browser available in this execution. Therefore this run did not exercise UI/browser AudioElement timing, WebGL2/GPU pixels, MediaRecorder output, or ffprobe of an app-generated WebM. Keep those acceptance items open; do not treat mocked WebM tests or ffmpeg source crop as browser E2E.

## Step 7k-15 Preview manipulation and settings hierarchy

Cover the closed-by-default Advanced settings, always-visible Category/Type/Appearance/Visibility/Reactive/Region and Binding, and reset-to-closed on selected Effect/type changes. Test selected-only handles for `centerX/centerY` Effects and Particle Burst `originX/originY`; route pointerdown from the handle into capture on the persistent canvas, then simulate captured move/up/cancel/lost-capture there. Verify repeated drags, rerender-stable canvas identity, live Region-local normalized values, numeric-to-handle and handle-to-numeric sync, edge clamping, no Region-picking side effect, rectangle and polygon bounds, and no change to Project/Cloud v1 roundtrip. Verify the HTML gizmo stays outside `renderEditorFrame` and does not enter WebM. Browser pointer/touch and visual hierarchy review remains manual when a browser is available.

## Step 7k-15b Preview Region editing

Select a Region and enter the explicit Preview edit mode. Verify Rectangle center drag, four edge/four corner resize, minimum dimensions and Stage-bound clamping; verify Polygon vertex drag, valid-area preservation, vertex input synchronization, and pointerup/cancel/lost-capture. Run with CSS Preview dimensions different from intrinsic canvas dimensions. Confirm Region handles suppress canvas Region picking and Effect position handles are hidden until Region edit mode ends; drag must not alter playback. Save and reload `.arvproj v1` and inspect the edited geometry. Real mouse interaction and visual handle discoverability still require browser acceptance.

## Step 7k-24 acoustic Kick annotation/evaluation

Run `python-island/.venv/bin/pytest -q`, `mypy --strict src`, and Ruff on changed evaluator/server modules and tests. Verify annotation source/stem/candidate SHA-256 matches, atomic JSON resume, duplicate candidate/event rejection, explicit no-Kick confirmation, full-play-through and all-candidate classification before interval completion. Evaluate full-source detector output and score only complete interval cores; do not crop because adaptive detector thresholds are clip-global. Boundary matches may use ±80ms context, unmatched out-of-core detections are excluded, and complete intervals need a 160ms minimum gap at default tolerance. Manually audition the full selected interval and classify missed Kicks and negative Snare/Tom/Bass events before treating metrics as accuracy. Loopback HTTP, browser playback/seek/loop, waveform/marker visuals and human annotation remain unverified where local bind or browser access is unavailable.

## Step 7k-24a annotation playback controls

Exercise byte-range parsing for full GET, single range, suffix range, unsatisfiable range and ignored malformed/multi-range; assert 200/206/416 headers and exact body lengths. Stream bounded chunks, suppress only BrokenPipe/ConnectionReset during audio response, and let unrelated I/O errors surface. Test candidate label ON/OFF and direct rejected/ambiguous/unverified transitions, timestamp linking without duplicate Kick truth, audition window boundary clamps/stop, pointer action priority (Shift interval > playhead seek > candidate select > click seek), seek throttling/final commit, and cancel behavior. A real browser should confirm candidate audio, preview stop timing, Chrome range request cancellation and pointer capture; source-level/Node helper tests do not replace that acceptance.
## Step 7k-16 Editor UI integration

Frontend structural/UI tests verify the six-step Audio → Range/Analyze → Blueprint → Edit → Preview → Export workflow, existing operation gating, seven Timeline source indicators, Preview intrinsic aspect ratio, selected Effect affordance, Delete/Add behavior and closed-by-default Advanced settings. CSS provides Preview-first vertical layout below 1,100px and a single-column control panel below 620px; this is static responsive structure, not browser visual acceptance. Run the full Frontend test suite, typecheck, lint and build. Confirm desktop/medium/narrow presentation and actual interactions in a browser when one is available.

## Step 7k-24b candidate prediction and audition

Test candidate audition from onset to the next strictly later candidate, final candidate to source duration, equal-time/near-time bounds, candidate switching, and stop behavior. Derive provisional `candidatePredictions` from existing detector disposition while keeping `candidateReviews` as human truth; verify old annotations remain readable, reviewed labels win, estimates alone cannot complete an interval or enter evaluation, and save/reload retains prediction metadata. Do not treat detector-derived labels as accuracy ground truth. Browser playback remains a separate manual acceptance.

## Step 7k-25 Kick detection gate modes

Verify `hard` retains the pre-mode detector output and is the API/CLI omission default. Check monotonic gate-threshold ordering, zero/silent input under `off`, common local-maximum/120ms merge behavior, paired event/strength output, invalid mode rejection, and selected mode propagation through Frontend multipart → Go runner argv → Python CLI → feature extraction. Frontend initializes new analysis to `middle`; changing this global setting must not mutate existing Timeline/Project or trigger analysis, and Effect add/delete/type changes must preserve it. Compare event counts and strength distributions on demo4 drums; without reviewed truth labels, do not report Precision/Recall/F1 or accuracy improvement.
