# Step 7h-3 — Ripple / Shockwave / Glow改善 完了報告

status: **completed**（自動検証完了。実ブラウザ視覚評価とWebM再生は未実施）

## 実装結果

Editor Blueprint v1へ`ripple`と`shockwave`を追加し、既存`glow-brightness`をoptional `glowIntensity`で拡張した。Canvas 2Dと既存`renderEditorFrame`・Region clipを再利用し、Preview/WebMのRenderer経路、Blueprint version、`.arvproj v1`、Cloud Envelope v1を変更していない。

### Ripple

- `bass.envelope` Bindingを必須とし、Editorで中心、1〜6波、250〜4,000ms周期、0.05〜0.45 normalized min-dimension radius、0〜0.2 amplitude、line widthを編集できる。
- 時刻とBinding strengthから位相・半径・opacityを計算し、各波紋を48点の閉pathとして描く。1 Effect最大6 path / 288 path vertices。描画履歴を持たない。

### Shockwave

- `kick.events` Bindingを必須とし、中心、0.05〜0.5 normalized max radius、100〜5,000ms lifetime、line widthを編集できる。
- イベント時刻との差から半径とfadeを計算し、生存イベントは時系列binary search後、直近最大32件まで評価する。各ringは48点で、1 Effect最大32 path / 1,536 path vertices。イベント前・寿命終了後は描かない。

### Glow

- 既存`glow-brightness`の`glowIntensity`（任意、0〜2）を追加。
- 項目を持たない旧Blueprintは従来どおり1描画命令を使い、旧データの見た目を維持する。値が指定された場合は、低opacityのblurred glow layerと明瞭な中心層の2命令を描く。0では中心層だけを描く。
- Glow intensity追加はoptional fieldであり、保存形式version変更を伴わない。

## Validator・Editor・保存契約

Ripple/ Shockwaveの必須field、整数/数値範囲、Effect/Region/Binding参照、source対応をFrontendとGo validatorで検証する。Gemini Structured Output schemaにkindとパラメータ型・制約を追加し、union keywordを使わないvariant固有必須条件はGo側が独立検証する。Editorで各EffectとGlow intensityを操作できる。

既存9 Effectを削除・仕様変更していない。Cloud Project v1とProject Document v1は既存Go validatorを通じて新Effectを受け入れる。旧アプリ版が新Effectを編集できる前方互換性は保証しない。

## 変更ファイル

- `frontend/src/editor-model.ts` — Effect型、範囲、厳密field/source検証。
- `frontend/src/renderer.ts` — ripple/shockwave path評価とoptional Glowの2層描画。
- `frontend/src/VisualEditor.tsx` — add-effect選択肢、パラメータUI、Binding既定値/source固定。
- `frontend/src/editor-renderer.test.ts` — Bass応答、Kick event前/生存/終了、多イベント上限、seek再現、clip、Glow後方互換/強度検証。
- `frontend/src/visual-editor.test.tsx` — Ripple/ShockwaveのUI追加・初期Binding確認。
- `frontend/src/project-file.test.ts` — Ripple/Shockwave/Glow拡張の`.arvproj v1`往復。
- `api/internal/blueprint/blueprint.go`、`blueprint_test.go` — strict Go validation。
- `api/internal/projects/document_test.go` — Project/Cloud v1受け入れ。
- `api/internal/service/gemini.go`、`http_test.go` — Structured Output schema kind/fields。
- `docs/BLUEPRINT_SPEC.md`、`ARCHITECTURE.md`、`TEST_STRATEGY.md` — 契約・責務・検証記録。
- `docs/VISUAL_EFFECT_ROADMAP.md`、`OPEN_ISSUES.md`、`CURRENT_STATE.md`、`CURRENT_TASK.md` — Phase A状況・残る視覚評価・今回作業。

## 検証結果

- Frontend：9 test files / 58 tests、typecheck、lint、production build成功。
- Go：`go test ./...`、`go vet ./...`成功。
- `git diff --check`成功。
- Frontend testsはRippleのBass feature変化、Shockwaveのevent boundary/lifetime/multiple event cap、任意順seekの同一評価、clip経路を検証。
- Go testsは数値境界/source不一致、Project/Cloud v1、Gemini schemaを検証。
- Chrome/Chromium実行ファイルがこの環境に見つからなかったため、実ブラウザ画素・WebM再生・FPS/CPU計測は行っていない。

## 未確認事項・残存リスク

機械テストは描画命令の再現性と構造を確認するもので、視覚品質や音楽との知覚的一致を確認しない。Ripple最大6 rings/Effect、Shockwave最大32 rings/Effectで、Effect上限32をすべて使うケースの総描画負荷はブラウザ計測が必要。Glow二層合成の見た目も画面で人が評価する。

## 制約確認

Hosted環境、Gemini実API、DB/Migration/Auth/RLS/AI quota、Step 7g-3免除処理、Python Island、依存関係、GitHub pushには変更・操作なし。
