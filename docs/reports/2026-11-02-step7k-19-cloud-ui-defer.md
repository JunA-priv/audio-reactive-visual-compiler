# Step 7k-19 — Cloud Project UIの一時非表示と再有効化メモ整備

## Status

**partial** — Cloud Project操作UIを非表示にし、一覧の自動取得を止めた。Frontend自動検証成功。実ブラウザ表示確認は未実施。

## 変更内容

- EditorのCloud操作パネルを表示制御フラグ cloudProjectUIEnabled=false の配下に置き、一覧/更新、新規作成、選択読込、保存/更新、削除、Cloud Project名と状態表示を隠した。
- ログイン中表示とログアウト、未ログイン時のログインフォームは「アカウント」欄に維持。Audio AnalyzeとBlueprint生成に認証済みセッションが必要なため。
- ログイン状態変更時のProject一覧自動取得effectを削除。起動・loginのみで /api/v1/projects への通信はしない。
- Cloud state/handlers、cloud-api.ts、cloud-project.ts、関連Cloud API/Envelope契約test、Go Project/Asset API、DB/Migrationは保持。
- local .arvproj save/load、Audio Analyze、Blueprint生成、Editor/Preview/WebMに変更なし。

## 再有効化メモ

docs/CLOUD_PROJECT_REACTIVATION.mdに実装位置と関数、API routes、設定名、DB/Migration、Cloud v1契約、.arvprojとの差、再有効化チェックリスト、未決事項を記録した。値の秘密情報は記載していない。Cloud Envelope v1にはMusic Summaryが含まれず、ローカル.arvprojの保存範囲とは異なる点も明記。

## テスト

- Frontend全体: 13 files / 158 tests passed
- typecheck: passed
- lint: passed
- build: passed
- git diff --check: passed
- UI test: Cloud panel/controls hidden, auto Project-list request absent after login, account login remains available, local Project file input remains present.
- Existing cloud-api/cloud-project contract tests remain enabled.

## 未確認・制約

- 実ブラウザでの表示確認は未実施。
- Hosted Cloud設定、認証、DB/Migration適用状態は検証・変更していない。
- Cloud専用操作はUIから到達不能。handlers/backend/tests/dataは削除していない。
- 対象外のAPI、DB、Auth方式、Renderer、WebM、依存関係の変更なし。
