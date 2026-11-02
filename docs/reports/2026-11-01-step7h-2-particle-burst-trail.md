# Step 7h-2 — Particle Burst / Particle Trail 完了報告

status: **completed**（自動検証完了。実ブラウザ視覚確認は未実施）

## 実装結果

Editor Blueprint v1へ`particle-burst`と`particle-trail`を加えた。既存Canvas 2D `renderEditorFrame`が描画命令を生成し、PreviewとWebMは従来の同じ描画経路を使う。新しいrenderer、依存関係、Binding方式、schema/container versionは追加していない。

### Particle Burst

- Binding sourceは`kick.events`に限定。
- 各粒子はKick event時刻、Effect ID、Blueprint seed、particle indexから初期角度・速度を決定論的に生成する。
- 各描画時刻でイベントからの経過時間を計算し、移動、縮小、フェードを再評価する。イベント前と寿命終了後は描画しない。
- `count`は1〜32、寿命は100〜5,000ms。直近の生存Kick eventは最大32件を処理し、理論上Effectあたり最大1,024粒子。

### Particle Trail

- Binding sourceは`bass.envelope`に限定。
- 現在時刻から過去の`trailMs`区間を8〜128サンプルで評価し、Bass値から軌跡の高さ・透明度を決める。
- 過去frameの粒子状態を保持せず、各時刻で位置・サイズ・opacityを再計算する。座標jitterはseed、Effect ID、サンプルindexから固定する。
- 1 Effectあたり最大128個のCanvas circle command。

両Effectは割り当てた既存Region geometryでclipされる。Burst/Trailは既存Binding source、strength、thresholdを使用し、Effect固有の音響sourceの誤接続はFrontendとGo双方で拒否する。Frontendは新Effectについて未知のEffect parameterも拒否する。

## 変更ファイル

- `frontend/src/editor-model.ts`：型、Effect範囲、厳密field/source検証。
- `frontend/src/renderer.ts`：状態を持たない粒子評価、Timeline search、有限上限。
- `frontend/src/VisualEditor.tsx`：追加、パラメータ編集、source固定。
- `frontend/src/editor-renderer.test.ts`：発生境界、期限、音響応答、任意順seek、範囲・source・未知field検証。
- `frontend/src/visual-editor.test.tsx`：Editor追加・パラメータ・Binding確認。
- `frontend/src/project-file.test.ts`：`.arvproj v1`保存・復元。
- `api/internal/blueprint/blueprint.go`：effect fields/ranges/integer/source検証。
- `api/internal/blueprint/blueprint_test.go`：Go validatorの正常・境界・source検証。
- `api/internal/projects/document_test.go`：Project Document v1/Cloud Envelope v1受け入れ。
- `api/internal/service/gemini.go`、`http_test.go`：Structured Output effect enumとparameter schema。
- `docs/BLUEPRINT_SPEC.md`、`ARCHITECTURE.md`、`TEST_STRATEGY.md`：確定した設計と検証内容。
- `docs/VISUAL_EFFECT_ROADMAP.md`：Phase Aの実装状況。
- `docs/CURRENT_STATE.md`、`OPEN_ISSUES.md`、`CURRENT_TASK.md`：進捗・視覚確認待ち・今回契約。

## Schemaと互換性

Effectは既存Blueprint v1の加法的なkind追加である。`.arvproj v1`、Cloud Envelope v1とProject Document v1の構造は変更していない。Go validatorはEffectごとの必須field、厳密な数値範囲、integer、参照、Binding sourceを検証する。Gemini Structured Output JSON Schemaは対応可能なkind enum・型・scalar rangeを制約するが、union keywordを避けているためvariant固有required fieldはSchema側では表現せず、Go validatorが厳密に検証する。

同じEffectを知らない旧アプリ版への新Effectの前方互換性は保証しない。既存7 Effectの描画実装は変更していない。

## 検証

- Frontend：9 test files / 55 tests、typecheck、lint、production build成功。
- Go：`go test ./...`、`go vet ./...`成功。
- Go Project validatorテストでProject Document v1とCloud Envelope v1の両Effect受け入れを確認。
- Rendererは同一時刻を`2200 → 500 → 2200`の順で評価して、同一描画命令を確認。Timeline入力変更でTrail命令が変わること、Burstの発生前・期限後にBurst粒子がないこともテスト。
- Preview/WebM共通経路はコード上、双方が`renderEditorFrame`を呼ぶことを確認。
- `git diff --check`成功。

## 未確認事項

Chromeなどの実ブラウザで粒子の芸術的品質、視認性、Region境界での画面表示、WebMの実再生、実時間FPS/CPU負荷は確認していない。Burstは設定上最大1,024粒子/Effect（Blueprintの最大Effect数32）まで積算され得る。上限内であっても低性能端末や高Effect数の実時間性能は未計測であり、公開前に代表端末で評価する。

## 制約確認

DB/Migration/Auth/RLS、Step 7g-3免除処理、Python Island、Gemini実API、Hosted環境、依存関係、GitHub remoteには変更・操作なし。
