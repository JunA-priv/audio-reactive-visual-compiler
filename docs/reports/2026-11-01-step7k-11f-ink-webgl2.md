# Step 7k-11f — Ink DiffusionのWebGL2描画

**状態：一部完了** — Ink専用WebGL2経路とCanvas2D fallbackを実装し、自動Frontend/Go検査は成功しました。この環境にbrowser、WebGL2実装、単体GLSL compilerがないため、shader compile、GPU pixel、WebMの見た目、実際のframe時間は未確認です。

## 結果

`ink-diffusion`はInk render command 1つに評価されます。WebGL2対応browserでは透明offscreen surfaceをWebGL2 fragment shaderで描画し、既存Canvas2D出力上の同じEffect描画順位置へ合成します。他のEffectはCanvas2Dのままです。PreviewとWebMは引き続き`renderEditorFrame`を使い、WebMは同じ合成済み出力canvasをcaptureします。

shaderはpixelごとに連続密度fieldを評価します。5 octave value noiseで絶対時間に応じてfieldをwarpし、3つの局所analytic vortexでcurlを加え、狭いprocedural ridge項で細いink filamentを作ります。密度はalphaと内側pigment濃度を制御します。Global Gradientは既存の全stage座標系と角度から色をsampleします。Custom Colorでは1色のpigmentを密度に応じたtone変化で使います。shaderは透明offscreen surface用のpremultiplied-alpha colorを出力します。

既存の`diffusionSpeed`、`flowStrength`、`turbulence`、`inkDensity`、`cloudScale`、`responseTime`値を維持します。既存の決定的な平滑化Binding responseがflow、vortex強度、密度、拡張を制御します。既定Bindingは`music.energy`のままで、7種類のsource選択肢とEvent/Continuous変換も変わりません。responseが0でもAlways modeでは自律した低速driftを続けます。shader inputはBlueprint seed/Effect ID、Timeline response、絶対timestampから導出し、前frame状態を蓄積しません。

## resourceとfallbackの挙動

- 2D出力canvasごとに透明WebGL2 offscreen canvasを1つ再利用します。surfaceはexport scaleを含む出力pixel上のInk Regionに合わせてsizeを決め、必要に応じてresizeします。
- 出力canvas用renderer entryは最大4つ保持します。Least-recently-used eviction時にbuffer/programを削除し、context解放のため`WEBGL_lose_context`を要求します。
- context loss時はbrowserの既定破棄動作を抑止し、context失効中はCanvas2Dへfallbackします。context復旧後にshader resourceを再構築します。
- WebGL2がない、context作成失敗、shader compile/link失敗、GL error、`drawImage`失敗の場合、従来の決定的なInk geometry 12 pathへfallbackします。これはInk内に限定され、他Effectやアプリを停止しません。
- 合成前にdestination rendererが既存Region clipとcommand opacityを適用します。Polygon clip、Effect順、2D出力は既存経路のままです。

## 性能と視覚検証

GPU/FPS計測値はありません。shaderはstage全体ではなくInk Region上のfragmentごとに評価します。実際のGPU負荷はbrowser、device、解像度、fill重なり、Ink Effect数に依存します。従来のCanvas2D経路はfallbackとして残りますが、初期化が成功する環境ではGPU経路を主経路とします。

実行環境にChromium、Chrome、Firefox、Playwright/Puppeteer、GLSL compilerはありません。そのため、実際のshader compile/link、browser画像、context loss/restore挙動、noise/色混合の見た目、demo1/demo3表示、GPU frame時間/FPS、WebM再生/pixel一致は**未確認**です。shader sourceの静的検査やfake Canvas testを視覚受け入れとは見なしません。

## 互換性

- Blueprint、Feature Timeline、Project、Cloud field/versionは変更していません。
- Go/API、Python Island、DB、Auth、Hosted、OpenAI API、dependencyは変更していません。
- 既存17 Effect kind、Inkの6 parameter、7種類のBinding source、Region、opacity、Gradient/Custom Color、Visibility、Audio Reactiveの意味は維持します。
- 既存Preview/WebM共有`renderEditorFrame`経路を維持します。

## Test

- `cd frontend && npm test -- --run` — 12 file、128 test成功。
- `cd frontend && npm run typecheck` — 成功。
- `cd frontend && npm run lint` — 成功。
- `cd frontend && npm run build` — 成功。Vite bundleは364.50 kB（gzip後111.77 kB）。
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go test ./internal/blueprint ./internal/projects` — 成功。
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go vet ./...` — 成功。
- `git diff --check` — 成功。

Frontend testはshader source構造、density/noise/vortex/color uniform、決定的render-command payload、旧fallback geometry/clipを検査しますが、GLSLをcompileしません。Go testはcontract回帰確認です。Go sourceとschemaは変更していません。

## 変更ファイル

- `frontend/src/ink-webgl.ts` — Ink専用WebGL2 shader、context cache/lifecycle、resize、合成、fallback結果。
- `frontend/src/renderer.ts` — EffectごとにInk shader commandを1つ使い、共有render経路へdispatch。従来Canvas pathはfallbackとして保持。
- `frontend/src/ink-webgl.test.ts` — shader構造の静的検査とcontext利用不可時のfallback確認。
- `frontend/src/editor-renderer.test.ts` — Ink shader payload、fallback、response、opacity、決定的評価、clipの回帰確認。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md` — 状態、architecture、test制約、未完了browser受け入れ。

## 残りの受け入れ確認

WebGL2 browserでEditorを起動し、shader compile/link、demo1/demo3での無音/弱/強response、独自色/共通色、rectangle/polygon clip、他Effectと交互に置いた複数Ink Effect、resize、context loss/restore、WebM再生を確認します。通常/2倍export解像度でRegion単位のGPU frame時間を測定します。GPU経路が失敗した場合、Canvas2D fallbackが表示され、Ink以外のEffectが描画され続けることを確認します。
