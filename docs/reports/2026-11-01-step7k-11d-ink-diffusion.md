# Step 7k-11d — Ink Diffusion

**状態：一部完了** — 実装と対象自動検査は成功しました。sandboxのIPv6 loopback bind制限でGo service test全体は未完了です。また、この環境にbrowserがなく、視覚/FPSの受け入れ確認はできませんでした。

## 結果

UIから導出される`Ambient / Atmospheric` categoryに`ink-diffusion`を追加しました。seed付きcloud centerを4つ用意し、それぞれ3本の半透明閉曲線を描画します（EffectごとにCanvas path command 12個）。各pathは輪郭点40個、Effectあたり合計480点です。重ね塗りで柔らかな密度と色の重なりを作り、低周波の輪郭harmonicとseed offsetを絶対時刻から連続的に変形させます。既存の滑らかな閉曲線Canvas renderer、Region clip、gradient/独自色解決、共通opacity、描画順、`renderEditorFrame`のPreview/WebM経路を再利用します。

新規Effectの既定値は`music.energy`、`visibilityMode: always`、`audioReactive: true`です。以下のBlueprint v1 parameterを任意項目として追加しました。

| Parameter | Range | Default |
|---|---:|---:|
| `diffusionSpeed` | 0–2 | 0.25 |
| `flowStrength` | 0–2 | 0.4 |
| `turbulence` | 0–2 | 0.3 |
| `inkDensity` | 0–1 | 0.65 |
| `cloudScale` | 0.1–2 | 0.5 |
| `responseTime` | 0.5–10 seconds | 3 |

response tableには既存のBinding threshold/attack/release処理を適用した後、`responseTime`の1-pole low-passを20ms間隔でsampleします。Timeline/設定から構築し、Timeline identityとBinding parameterをkeyにcacheします。entryごとの最大値数は12,001、Timelineごとのparameter variantは16です。seek順序が任意でも結果は決定的です。Always modeでは無音または非reactive時も自律的な低速動作を維持します。Triggered modeは平滑化したsource responseに応じてfade in/outし、eventを捏造しません。

## 互換性

Blueprint、Feature Timeline、`.arvproj`、Project Document、Cloud Envelopeはv1のままです。Inkの6 fieldは任意で、省略を受け付けます。Editorの既定値とOpenAI normalizationは同じ値を使います。CategoryはEffect kindから導出し、serialization対象ではありません。Timeline feature、dependency、Python、API、DB、Auth、Hosted、3D、GPUは変更していません。既存Effectと7種類のsource選択肢も変わりません。

## 変更ファイル

- `frontend/src/editor-model.ts` — Ink Effect型と厳密なparameter検証。
- `frontend/src/renderer.ts` — 決定的な輪郭生成とresponse平滑化cache。
- `frontend/src/VisualEditor.tsx` — category、既定値、music Binding、parameter controls。
- `frontend/src/editor-renderer.test.ts` — 輪郭、response strength、seekの決定性、opacity/gradient command、Region clipを検証。
- `frontend/src/visual-editor.test.tsx` — 18種類のcategory/kindとInk Editor既定値を検証。
- `frontend/src/project-file.test.ts`、`frontend/src/cloud-project.test.ts` — v1 persistence roundtrip。
- `api/internal/blueprint/blueprint.go`、`blueprint_test.go` — Go kind/parameter検証。
- `api/internal/service/openai.go`、`openai_test.go` — strict schema、prompt、normalization既定値。
- `api/internal/projects/document_test.go` — Project/Cloud v1受け入れ確認。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/BLUEPRINT_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md` — 現行contractと受け入れ確認の残り。

## Test

- `npm test -- --run` — 126 test成功。
- `npm run typecheck` — 成功。
- `npm run lint` — 成功。
- `npm run build` — 成功。
- `go test ./internal/blueprint ./internal/projects` — 成功。
- `go test ./internal/service -run 'TestOpenAI(Schema|InkDiffusion|NormalizesOpacity|NormalizesEnhancedParticle)'` — 成功。
- `go vet ./...` — 成功。
- `go test ./...` — 既存`TestOpenAIResponsesRequestUsesStrictStructuredOutput`が`httptest.NewServer`を起動できませんでした。sandboxが`[::1]:0`のlistenを拒否しました（`operation not permitted`）。testの削除や無効化はしていません。
- `git diff --check` — 成功。

## 残りの検証

Fake Canvas command testでは、範囲内の閉曲線path、0以外のalpha、共通gradient、Region clip、音声response scaling、同じtimestampを繰り返し/順序を変えて評価したときの一致を検証します。ただし、流体としての見た目、色混合の品質、実browserでのFPSは確認できません。browserによる視覚reviewとWebM再生比較は未検証です。
