# アーキテクチャ

DECIDED（Step 7i更新）：処理の流れは、音源入力→PythonによるDemucs分離→Feature TimelineとMusic Summary→GoからOpenAI Responses API（`gpt-6-luna`）へ要約を渡す→Blueprintスキーマ検証→ブラウザCanvas描画→動画/暗号化ファイル出力。過去のGemini記述は履歴であり、現行providerではない。

| 構成 | 責務 |
|---|---|
| React | 編集、Region操作、再生時刻管理、プレビュー・動画出力。Step 7dではローカルSupabase AuthとGo owner-scoped Project/Asset APIを任意ログインで利用 |
| Renderer | Blueprint/特徴量/時刻/seedから描画命令を評価 |
| Go/Echo | ローカルSummary/Timeline検証、OpenAI/Fixture Blueprint生成、Blueprint検証。Step 7bではloopback Supabase Auth JWT検証と利用者JWTを使うowner-scoped Project CRUD |
| Python Island | デコード、4 Stem分離、特徴抽出、要約生成 |
| ストレージ/DB | 素材・結果とプロジェクトの保存。所有者単位で隔離 |

DECIDED：Regionは場所、Effectは処理、Bindingは特徴量との対応を担当する。Rendererは過去の描画順やFPSに依存させない。

FACT（Visual Editor）：`frontend/src/VisualEditor.tsx`はBlueprint編集・固定Timelineの再生操作を担当する。`editor-model.ts`はシリアライズ可能な背景/Region/Effect/Bindingと検証、`renderer.ts`は従来の矩形APIに加えてEditor命令の純粋評価とCanvas描画を担当する。Regionは正規化座標、Effectはregion IDと視覚パラメータ、Bindingはeffect ID/source/response parametersを持つ。Canvas描画では各命令をRegion geometryでclipする。旧`evaluateFrame`/`renderFrame`は維持。

FACT（Step 7h-1）：Canvas 2D Editor RendererへRadial BarsとWave Ringを追加。Radial Barsは決定論的な回転矩形群、Wave RingはTimelineを時刻サンプリングして生成する閉path strokeとして既存`renderEditorFrame`が描く。どちらも既存Region geometry clip、Effect順序、Binding評価を共有し、Preview/WebMから別Rendererを使わない。新EffectはBlueprint v1の加法的な種類拡張で、古いクライアントの新Effect編集互換は保証しない。

FACT（Step 7h-2）：Particle Burst/TrailもCanvas 2Dの`renderEditorFrame`命令として評価し、Region clipを共有する。Burstの各粒子はKick event time・effect id・Blueprint seed・粒子indexから再計算し、直近32の生存イベントを上限とする。Trailは過去区間を最大128点で直接サンプルし、状態履歴を保持しない。Editor PreviewとWebM exportは同じRenderer経路を利用する。Blueprint/schema/container versionは引き続き1。

FACT（Step 7h-3）：RippleはBass Binding値と周期から最大6本のpath ringを生成し、ShockwaveはKick eventの寿命内で最大32本のring pathを生成する。どちらも`renderEditorFrame`とRegion clipを共有し、描画履歴を持たない。Glow Brightnessの任意`glowIntensity`指定時は発光層＋中心層を描画する。省略時の既存Glow命令は維持する。Preview/WebM共通経路、Blueprint v1とProject形式は変更しない。

FACT（Step 7k-1）：Canvas 2D Rendererは強調用Effect optionが設定された場合にだけ新しいスパイク/発光表現を用いる。`oscilloscope-line`はBass Envelopeの過去180msを位相化した疑似波形であり、raw PCMを参照しない。描画点はcurrent time、seed、effect IDから算出し、seek順序に依存しない。全命令は既存Region clip経由で、Preview/WebM双方が同じ`renderEditorFrame`を使う。

FACT（Step 7k-2）：Python Islandは既存4 stemとdecode済みoriginal PCMから追加Featureを作る。連続系列は10ms hop・ms原点・系列別95th percentile RMS正規化。`drumEnergy`を直接Bindingし重複時系列を作らない。Snareは混合drums stemのmid/high transient候補。Timeline v1では旧必須fieldを維持し追加fieldを任意にする。Frontend/Go Blueprint validatorとGo Project/AI Timeline validatorは7 sourceとEffectごとのEvent/Continuous互換性を検証する。

FACT（Step 7k-11d）：`ink-diffusion` is evaluated as bounded Canvas 2D filled paths (4 clouds × 3 layers × 40 contour points per Effect). Low-frequency contour harmonics and seeded spatial offsets evolve continuously from absolute timestamp, Blueprint seed, and Effect ID. A cached 20ms table applies the selected Binding's threshold/attack/release followed by the Effect's response-time low-pass; the table is derived from Timeline and settings, not prior frames. Every command passes through the existing Region clip, color resolution, and opacity path, shared by Preview and WebM.

FACT（Step 7d local-only）：FrontendはSupabase Auth RESTでログイン/更新/ログアウトし、Go APIのProject CRUD・Asset APIを利用する。音源/画像はCloud Envelope v1 asset referencesとして保存し、Go Asset endpoint経由でupload/downloadする。ログイン不要のEditor、`.arvproj`、WebM経路は維持。実ブラウザ統合およびHosted構成は未検証。

FACT（Step 7j local-only）：`/app`で元音源をブラウザ内再生・範囲選択し、Web Audio decode/OfflineAudioContextで選択区間を44.1kHz stereo PCM16 WAVへ変換する。元音源全体は解析APIへ送らない。認証付きGo `POST /api/v1/audio/analyze`は固定Python Island CLIをprivate temp fileから起動し、CPU htdemucsを実行、結果を既存Timeline/Summary validatorで検証して返す。Frontendは解析成功後にだけcrop clipと対応TimelineをEditorへcommitし、既存Blueprint generator・Project/Asset・Preview/WebM経路へ同じclip/Timelineを渡す。このAPIはloopback/local issuer専用でHosted CPU executionは未実装。

FACT（Step 7h-3.5 local-only）：匿名`/demo`は3つの静的Track定義からMP3と対応Timeline v1 JSONを選択し、`loadDemoTimeline`のruntime validationを通したものだけ再生する。Timeline fetch競合はcleanup flagで無効化し、楽曲切替時は音声を停止・0秒へ戻してTimeline/Blueprintを初期化する。Renderer clockは選択音声のcurrentTimeを読み、timeline durationと音源metadata durationの差100ms以内を確認する。Python CLIの任意`--stems-dir`は特徴抽出とstem WAV保存を同じDemucs推論から実行する。Frontendには音源MP3とTimeline JSONのみを置く。Source/stem/生成内部JSON/モデル重みは配信またはGit管理しない。公開利用可否・Hosted配信・ブラウザ実機は別確認。

PROPOSED：Cloudflare Pages/R2、Cloud Run Services/Jobs、Hosted Supabase。ローカルSupabase Auth/PostgreSQL/RLSとFrontend cloud UIはlocal-onlyで実装・検証済み。Hosted構成、ジョブ実行は未実装。

FACT（Step 5）：ローカルEcho API `GET /healthz` と`POST /api/v1/blueprints/generate`を実装。既存Editor Blueprint v1に独立検証を適用し、Fixtureを既定モードとする。Geminiモードは明示的な環境設定時のみ。Step 7bでProjectDocument v1 wrapperとローカルCRUDを追加した。全体API schema、クラウド構成、素材保存、Frontend cloud UIは未確定/未実装。

FACT（Python Island）：CLIはローカルMP3/WAVをffprobe検査後FFmpegで44.1kHz stereo float PCMにdecodeし、CPU-only Demucs htdemucsで4 Stemを分離、10ms hopのfeaturesとMusic SummaryをJSON出力する。任意`--stems-dir`で同じ分離結果から非上書きPCM16 stereo WAVを保存する。モデル設定はインストール済みDemucs package、weightsはhash検証済み既存cacheからのみ取得し、implicit model network downloadを無効化。FFmpeg更新状態とweight licensingは未解決で、非信頼音源/公開処理には未承認。
# Step 7k-30 — WebM / MP4 export

FACT / PARTIAL: WebM and MP4 share the existing Canvas capture, audio mix, media clock, and `renderEditorFrame` path. MP4 is restricted to browser-declared H.264/AVC support, plus AAC LC when audio is included; each combination is checked independently with `MediaRecorder.isTypeSupported()`. Recorder MIME and the generated Blob's MP4 `ftyp` box are checked before using an `.mp4` filename. Unsupported MP4 does not fall back to WebM. Real browser codec availability, generated MP4 playback, and audio synchronization remain unverified.

# Step 6のローカル出力とプロジェクトファイル

Visual Editorは既存の`renderEditorFrame`経路を使って一時Canvasへ出力する。`captureStream(fps)`と`MediaRecorder`でリアルタイムWebMをエンコードし、音声を含める場合はローカル音源をWeb Audioでデコードして`MediaStreamAudioDestinationNode`経由で合成する。音声がある場合、出力時計には`AudioContext.currentTime`を使い、それ以外では単調増加するperformance clockを使う。これによりプレビューと同一のBlueprint、Feature Timeline、frame time評価を保つ。ブラウザーのスケジューリングと非可逆codecにより、同じframe入力に対する描画画素は決定論的だが、frameの送出とエンコードbyte列の一致は保証されない。

ローカル保存／復元には、version付きJSONの`.arvproj`コンテナを使う。Blueprint（data URL形式の背景画像を含む）、Feature Timeline全体、metadata、任意のローカル音源byte列とSHA-256整合性情報を埋め込む。Step 7k-17以降は、解析済みプロジェクトのMusic Summaryも任意の`metadata.musicSummary`として保存し、既存v1ファイルでは欠落を許容する。音声解析済みのローカルProjectではcrop WAV、Timeline、Summary、Blueprintを復元するため、再読み込み時に再解析は行わない。Cloud Envelope v1は引き続きBlueprint/Timelineと外部Asset参照を保持し、Music Summaryは含めない。暗号化されていないため、平文ファイルとして扱う。`.arvb`暗号化は鍵の所有、復旧、rotation、形式が決まるまで保留する。
# Step 7k-3 Editor rendering contract

Blueprint v1 optionally carries a shared three-stop Canvas gradient; old Blueprints without that field continue using their per-Effect colors. An Effect’s optional `colorMode` selects the shared gradient or its own color, and omission retains legacy custom-color rendering. The gradient is resolved into each Effect draw command before the existing Canvas 2D renderer applies that command inside its Region clip. Preview and WebM continue through `renderEditorFrame`.

FACT（Step 7k-4〜7k-7）：Python peak extraction reuses decoded music PCM and existing Demucs stems; fixed 882-sample windows at 44.1kHz record signed per-channel min/max, with a partial final window. Timeline v1 `waveformPeaks` is optional and bounded to 12,000 windows/source. Demo additions are separate sidecars; original Timeline, stems, and audio remain unchanged. Renderer reads peaks at evaluated time and emits bounded commands, with no synthesized fallback. Event/Continuous source conversion is stateless from Timeline/time, preserving seek determinism. All effect source checks retain enum validation but no longer restrict by Effect kind. OpenAI receives compact Bass/Kick features only and never peak arrays.

FACT（Step 7k-11a）：Python computes music `frequencySpectrum` from decoded 44.1kHz PCM with a 4096-sample Hann STFT, 20ms hop, 32 log bands (40Hz..min(16kHz, Nyquist)), whole-clip p99 log-RMS normalization, and row-major uint8 values. Timeline v1 accepts it optionally; Go bounds frames to 12,000 and validates exact metadata/value dimensions while retaining the fixed 2MiB request cap. OpenAI receives only compact Bass/Kick summaries, never Spectrum values. The two new Effects are in the UI-derived `EQ / Spectrum` Category. Renderer interpolates rows and caches deterministic per-band attack/release followers by Timeline and settings; Binding supplies secondary response strength. Missing matrix yields no commands. `/demo` loads separate, version-named Spectrum sidecars; existing Timeline/stem/audio assets are not overwritten or re-separated. Preview and WebM continue through `renderEditorFrame`.

FACT（Step 7k-8）：Music Summary and existing Timeline contract did not include BPM. Python estimates tempo from already-extracted Kick onset intervals only when at least four onsets and stable intervals are available; median interval is folded into 60..180 BPM, while sparse/irregular data records explicit 120 BPM fallback. `bpmSource` distinguishes estimate/fallback. This is constant tempo, not beat phase. Circular Effect rotation fields are optional for v1 compatibility. Continuous angle uses BPM formula from time zero. Triggered angle integrates the existing attack/release Binding follower into a weakly-held, parameter-keyed cumulative table and interpolates at requested time; no incremental frame state, so pause/seek/export order cannot affect angle. OpenAI receives the compact BPM/source metadata when available.

FACT（Step 7k-9）：Effect共通OpacityはRenderer commandの既存opacityへ乗算され、Canvas 2DのglobalAlphaにより各Effect layerのstroke/fill/glowに適用される。Effect Type変更は既存default生成を使い、ID/Region/Binding/Color mode/Opacityを保持する。Wave Ringは一度求めた音響sample列を複数layerで再利用し、各layerに自動等間隔または手動角度step、循環位相シフト、半径step、`decay^layerIndex`振幅係数を適用する。旧データはlayerCount=1相当で描画する。

FACT（Step 7k-10当初仕様、Step 7k-10bで置換）：RendererはEffect設定で既定Triggered/Reactiveを解釈し、Alwaysでは既存命令alphaの下限を設定する。Audio Reactive OFFはTimeline Binding series/event列を空にした時刻評価へ切り替える（BPM metadataを維持し、実waveform peaksはclip先頭の静的形状として参照）。Shockwave/BurstにイベントがないAlways状態ではseed/Effect設定由来の静的基準描画を行う。Event生成履歴やフレーム累積状態は保持しない。Wave Ringは各層で`180/layerCount`または手動stepを角度と循環サンプル位相へ適用し、入力sample列を一度だけ評価して共有する。最大10×256点/Effect。

FACT（Step 7k-10b修正）：Wave Ringは自動stepを`360/layerCount`、手動stepを明示値とし、角度は共通のBPM回転・初期角度に足して描画座標だけへ適用する。全層で同一radiusを使う。旧`layerRadiusStep`は保存互換性のため許容するが、Wave Ring描画では無視する。共通sample列、平滑化・周期閉路、Preview/WebM共通rendererを維持する。

## Step 7k-11f Ink WebGL2 path

FACT / PARTIAL: `ink-diffusion` emits one Ink-specific render command carrying absolute-time uniforms and the prior bounded Canvas geometry as fallback. `ink-webgl.ts` renders a transparent Region-sized surface with a WebGL2 fragment shader (warped multi-octave density field, three analytic vortex warps, filament ridges, alpha density and gradient/custom pigment), then composites that surface at the same command position using the existing clipped Canvas2D context. Canvas2D remains the frame/output surface, so Preview and WebM still call `renderEditorFrame` and WebM captures the same composite. Per-target WebGL contexts are LRU bounded to four; resize, context loss/restore, shader/init failure and WebGL2 absence are handled locally, with old Ink geometry fallback. The shader uses Blueprint seed/effect ID, time and the existing deterministic Timeline response; no accumulated frame state or Blueprint/Timeline field was added. Browser GPU execution and pixel/WebM acceptance remain unverified.

FACT（Step 7k-11g）：Ink density field starts with a high-density central core and expands a broad soft envelope plus four asymmetrically orbiting sources. Absolute-time diffusion and Binding response control front radius; independent temporal phases drive four local vortices and two noise-warp scales. A radial/noise ridge field forms multiple outward filaments. The fallback independently approximates this with four overlapping center/satellite clouds and five radial curved branches. Coverage/shape variation comes from existing Effect ID/Blueprint seed and time; no optional Blueprint parameter was added.

FACT（Step 7k-11h）：Region occupancy changes are confined to Renderer geometry and shader uniforms. Region bounds remain the coordinate basis for each Effect and the existing shared clip; circular shapes use independent horizontal/vertical radii to fit rectangular Regions. Ink's WebGL density envelope/front and Canvas fallback reach are widened without changing payload or Blueprint/Timeline/Project versions. Preview and WebM continue through `renderEditorFrame`.

FACT / PARTIAL（Step 7k-15/15a）：Editor overlays a selected Effect position handle as HTML over the Preview canvas; it is not emitted by `renderEditorFrame`, so WebM frames and Renderer commands are unchanged. Radial Bars, Wave Ring, Ripple and Shockwave map `centerX/centerY`, while Particle Burst maps `originX/originY`; values are normalized within the owning Region bounds, including polygon bounding extents. The handle stops pointerdown before Region picking. Pointer Capture and move/up/cancel/lost-capture handling live on the persistent Preview canvas, while the active Effect ID is retained across state rerenders; coordinate changes update Blueprint state and the form. Core appearance/visibility/Region controls and Binding stay visible; type-specific controls are in a native closed-by-default `<details>`. Blueprint v1 and Project/Cloud v1 contain the same fields as before. Pointer-sequence tests pass, but Windows Chrome could not launch from WSL (`UtilBindVsockAnyPort` socket error), so browser pointer/touch acceptance remains unverified.

FACT / PARTIAL（Step 7k-15b）：Preview has a separate, explicit Region edit mode. It shows a selected Region outline and draggable handles: Rectangle center move plus four corner/four edge resize handles, or one handle per Polygon vertex. Pointer Capture is owned by the persistent Preview canvas and coordinates are converted from CSS pixels to normalized Stage coordinates; rect bounds/minimum size and polygon valid-area constraints are checked before committing Blueprint state. Effect position gizmo is hidden while Region edit mode is active. The existing renderer consumes the updated Region geometry and its saved v1 representation is unchanged. Automated tests cover CSS-scaled input and Project v1 save/restore; actual browser use remains unverified.

FACT / PARTIAL（Step 7k-11j）：Ink fragment shader now treats the broad cloud envelope as a weak carrier and derives localized pigment from core, satellite lobes, expansion front and warped density variation. A raised threshold/smoothstep mask and nonlinear alpha reduce low-density wash; output RGB remains premultiplied by alpha for the existing WebGL context and Canvas2D composition. This is a shader-local change: Region-local UV, stage-coordinate Gradient transform, payload and save contracts are unchanged. Pixel distribution requires browser validation.
# Step 7k-11b Kick detector

Python Island keeps the Feature Timeline v1 `kickEvents` and parallel normalized `kickEventStrengths` contract. The detector examines a 2048-point window at 10ms hop and scores positive 35–120Hz energy rise against a preceding 500ms median. Audio Analyze accepts an optional `kickGateMode` (`off`, `soft`, `middle`, `hard`); omission selects `hard`, preserving the previous conditions exactly. `hard` uses adaptive score `max(p85 × 0.18, 0.08)`, low-band floor `p65 × 0.12`, sub/body ratio ≥0.70 and 80ms decay ≤0.50. `middle` uses `(0.13, 0.055, 0.08, 0.55, 0.70)` and `soft` `(0.08, 0.035, 0.04, 0.40, 0.90)` for those score multiplier/floor, low-band multiplier, ratio floor and decay ceiling values. `off` disables those four acceptance gates, but retains positive nonzero score, local-maximum detection and the 120ms candidate merge. All modes operate on mixed Demucs drums and remain kick-like estimates, not separated or ground-truth kick labels. Timeline v1 fields and detector features are unchanged.

## Step 7k-11c particle rendering

Particles and Particle Burst remain Canvas 2D commands inside `renderEditorFrame`, so Preview and WebM use the same deterministic evaluation path. Particle positions derive from time, blueprint seed, effect identity/index, and current binding response. Burst events are reconstructed from the Timeline and event ordinal; particles use radial angle distribution and lifetime-based swirl. Rendering has a bounded event/particle workload and uses existing Region clip, color resolution, and opacity composition. No mutable previous-frame state or new Timeline feature is used.

## Step 7k-11e Ink rendering

Ink-only Canvas implementation creates three overlapping rising plume ribbons with inner/outer contour fills and six tapered flow branches. A deterministic vortex field bends branches from absolute Timeline time and Effect seed. The 12 commands carry 600 supplied contour points per Effect and reuse existing Canvas2D path, Region clip, alpha, Gradient and Custom Color handling. Preview and WebM still call `renderEditorFrame`; no renderer context, shader, GPU path, or Effect contract changed.

## Step 7k-11i: Ink Flow / Color Mixing

The existing Ink offscreen WebGL2 renderer now selects a uniform-driven visual mode for `ink-diffusion`, `ink-flow`, or `color-mixing`. Diffusion retains the Step 7k-11j localized density/transparent-gap and premultiplied-alpha calculations. Flow derives narrow curved stream ridges from the existing time-warped field; Mixing combines four independently moving pigment source densities and weights the existing gradient palette by those sources. Each Effect still evaluates its own Binding/response and emits its own ordered command; the existing Region clip is active during Canvas2D composite. Canvas fallback uses deterministic cloud contours for diffusion/mixing and stroked curved paths for Flow. No state is accumulated between frames, and Preview/WebM keep the shared `renderEditorFrame` path. Actual GPU shader compile and pixels require browser verification.

## Step 7k-11k Ink Flow and Color Mixing quality

Flow now derives broad density ribbons from lower-frequency warped stream fields, with softer bodies, variable alpha edges and reduced contour-filament contribution; existing time-driven vortices and response smoothing remain. Color Mixing computes four independently warped and orbiting pigment density sources. Their density weights blend source colors locally; the overall field uses a tighter threshold and smaller source radii to retain transparent gaps. Global Gradient colors the sources using the existing palette. For custom single color, the legacy base color remains; optional `customPalette` (2..4 colors) assigns colors to the separate source fields instead of mapping colors across the whole Stage. The shader mode for Ink Diffusion is unchanged. Region-local UV, Stage-space gradient, polygon clipping, opacity, effect order, fallback and shared Preview/WebM composition are preserved.
