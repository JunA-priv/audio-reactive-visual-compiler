# Step 7k-1 — ビジュアライザー表現改善（波形寄り・派手化）

状態：**completed（実装・自動検証）**。実ブラウザ視覚評価は未実施。

## 実装内容

- Radial Barsは任意の`barWidth` / `spikeSharpness` / `innerRadius` / `amplitudeScale` / `glowIntensity`設定時に、鋭いテーパー状スパイクへ切り替わる。すべて未指定の既存データは従来のbar描画を維持。
- Wave Ringは任意の`sampleCount` / `amplitudeScale` / `jaggedness` / `glowIntensity`でBass Envelopeを密にサンプルした輪郭を描く。オプション未指定時の既存値は従来描画を維持。
- Particle Burstに発光、opacity boost、core flashを追加。Particle Trailに発光、opacity boost、length scaleを追加。Ripple/Shockwaveは発光とopacity boostを設定可能にした。
- Glow Brightnessは任意`glowIntensity`がある場合に発光＋中心の2描画を行い、従来のGlowデータは既存描画を維持。
- 新Effect `oscilloscope-line`をhorizontal/radial配置で追加。Bass Envelopeの過去180msから saw-like pathを生成する疑似波形であり、raw PCM波形ではない。時刻・Blueprint seed・Effect IDから計算し、前フレーム状態を持たない。
- 初期Blueprintと新規Effect UIの色・パラメータをネオン寄りに調整。EditorでOscilloscope orientation、sample count、amplitude、glow intensityを編集できる。
- Blueprint v1、`.arvproj v1`、Cloud Envelope/Project Document v1、Timeline schema、Preview/WebM共通の`renderEditorFrame`経路を維持。Frontend/Go validatorとOpenAI Structured Output schemaを同期した。Auth、DB、Project/Asset API、quota、provider business logicの変更なし。

## 変更ファイル

- Frontend: `frontend/src/editor-model.ts`, `frontend/src/renderer.ts`, `frontend/src/VisualEditor.tsx`, `frontend/src/editor-renderer.test.ts`, `frontend/src/visual-editor.test.tsx`, `frontend/src/project-file.test.ts`
- Go: `api/internal/blueprint/blueprint.go`, `api/internal/blueprint/blueprint_test.go`, `api/internal/projects/document_test.go`, `api/internal/service/openai.go`, `api/internal/service/http_test.go`
- Docs: `docs/BLUEPRINT_SPEC.md`, `docs/VISUAL_EFFECT_ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md`

## 検証

- Frontend `npm test`: **76 tests passed**
- Frontend `npm run typecheck`: **passed**
- Frontend `npm run lint`: **passed**
- Frontend `npm run build`: **passed**
- Go `go test ./...`: **passed**（sandbox loopback socket制限で最初の実行が停止したため、許可されたloopback実行で再実行）
- Go `go vet ./...`: **passed**
- `git diff --check`: **passed**
- Windows Chrome / 実ブラウザの画素品質・実WebM再生・FPS計測: **未実施**。手動視覚評価として継続。

## 残課題・互換性

Oscilloscope Lineは擬似波形で、実際のPCMサンプルを描くものではない。ブラウザ実画素での見栄え、音源との知覚的一致、WebMでの発光合成と性能は未確認。Blueprint v1は加法拡張で維持したが、追加Effect/fieldを知らない旧クライアントで編集可能な互換性は保証しない。実OpenAI API呼び出しは行っていない。
