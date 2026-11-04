# Step 7k-9 — 多層Wave RingとEffect opacity

**状態：一部完了**

## 結果

既存の15種類すべてのEffectに、任意のEffect共通`opacity`（0〜1、既定値1）を追加しました。rendererは各描画commandの既存alphaにopacityを乗算します。これによりEffect固有のfade、Binding応答、gradient/独自色、Region clip、描画順は維持されます。Editorで新規作成するEffectのopacityは1で、Typeをその場で変更しても値を引き継ぎます。

Wave Ringには任意の`layerCount`（1〜6）、`layerRadiusStep`（0〜0.1）、`layerAngleOffsetDeg`（0〜360）、`layerAmplitudeDecay`（0.5〜1）を追加しました。Editorで新規作成するWave Ringは4層です。項目を省略した既存Blueprintは従来どおり1層です。角度step 0は自動で等間隔に配置し、正の値は隣接層間の手動指定間隔です。各層はpath角度とサンプリング信号のphaseをずらし、指定stepで半径を変え、`decay^layerIndex`で振幅を調整します。元のsample列は1回だけ評価して再利用します。BPM回転は全層で共有し、timestampから決定的に求めます。

Blueprint v1、`.arvproj v1`、Cloud v1、Timeline v1、Category → Type、Binding source、Gradient、共有`renderEditorFrame`の挙動は変更していません。OpenAI strict schemaにopacity/layer項目を含め、新しい生成結果にはnormalizationで既定値を補います。OpenAI API callは行っていません。

## 変更ファイル

- `frontend/src/editor-model.ts`：Effect opacityとWave Ring layerの型・検証。
- `frontend/src/renderer.ts`：共通opacity乗算と決定的な多層Wave Ring生成。
- `frontend/src/VisualEditor.tsx`：既定値、controls、Type変更時のopacity保持。
- `frontend/src/editor-renderer.test.ts`、`frontend/src/visual-editor.test.tsx`、`frontend/src/project-file.test.ts`：opacityの操作/保持、層数とphase、決定的評価、v1 serializationを検証。
- `api/internal/blueprint/blueprint.go`：対応する検証と範囲確認。
- `api/internal/blueprint/blueprint_test.go`：opacity/layer検証case。
- `api/internal/service/openai.go`：strict schema、normalization、promptの追加。
- `api/internal/service/openai_test.go`：schemaとnormalizationのtest。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/BLUEPRINT_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md`：現行contractと検証状況。

## Test

- Frontend `npm test -- --run`：**105 test成功**。
- `npm run typecheck`：成功。
- `npm run lint`：成功。
- `npm run build`：成功。
- Go `go test ./internal/blueprint ./internal/projects`：成功。
- Go OpenAI schema/normalization/rotationの対象test：成功。
- Go `go vet ./...`：成功。
- `git diff --check`：成功。

Go service全体のtestも試しましたが、sandboxが`httptest.NewServer`のIPv6 loopback bindを拒否し、`TestOpenAIResponsesRequestUsesStrictStructuredOutput`を開始できませんでした（`listen tcp6 [::1]:0: operation not permitted`）。testの変更・無効化はしていません。実ブラウザーでのpixel/WebM比較はできず、未検証です。

## 互換性と範囲

schema追加はBlueprint v1への任意の追加項目です。旧Effectのopacityは1、旧Wave Ringは1層として扱われます。Feature Timeline、Project、Cloud version、database、auth、dependency、Hosted環境、renderer architectureは変更していません。既存BPM/triggered rotationとPreview/WebM renderer経路を引き続き使用します。

## 残課題

- IPv6 loopback bindを許す環境でGo service全体のtestを実行する。
- 実ブラウザーで多層表示、opacity合成、Region clipping、出力WebMを目視確認する。
