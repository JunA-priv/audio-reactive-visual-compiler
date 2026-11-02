# Step 7g-3 — ローカル開発者Fixture制限免除

**status: completed（local-only implementation and verification）**

## 結果

`dev-local@example.test`のローカルAuth UUIDに限り、Fixture Blueprint生成で通常の日次/月次リクエスト数、サービス共通費用/token予算、ユーザー/全体同時実行数を消費しない経路を実装した。Gemini mode・Hosted・他ユーザーには免除を適用しない。

## 実装

- Migration `20261101001700_local_fixture_budget_exemption.sql`を追加し、既存001〜016は変更していない。
- `ai_generation_usage.quota_exempt`を既定falseで追加。通常のreserve RPCは免除行をユーザー/サービス回数、推定費用、user/global concurrencyの集計対象から除外する。通常行は引き続き全て集計される。
- 新private RPC `arvc_internal.ai_generation_reserve_local_fixture`は、DB global kill switch、有効かつ期限内のentitlement、32-byte idempotency hashと重複拒否、token上限を検査してから免除予約を作成する。Fixture予約費用と価格は0で保持する。
- 新RPCのEXECUTEは`arvc_ai_budget`だけに付与。PUBLIC、anon、authenticated、service_role、asset verifierは不可。直接テーブル権限、RLS、role属性、Project/Asset権限は変更していない。
- Go APIの専用経路は、`AI_FIXTURE_UNLIMITED_LOCAL=true`、`BLUEPRINT_MODE=fixture`、AI auth有効、loopback API/Auth、正しいUUID設定が揃った場合に限る。開発者判定はJWT validatorが設定した`sub`と設定UUIDの完全一致。request body、email、JWT metadataからは判定しない。
- Gemini modeで特例flagが有効なら起動を拒否する。flag無効時のGemini modeは既存の通常reserveを使う。
- `.env.example`の既定値はfalse/空。local `api/.env`はFixture用特例を有効にし、mode 600・Git ignoreを確認した。API key/JWT/DSN値は出力していない。
- ローカル開発者の既存entitlementをlocal DBのみ`expires_at=NULL`へ更新し、継続利用可能にした。資格のenabled確認は専用RPCが毎回行う。他ユーザーの期限やMigrationの既定値は変更なし。

## 検証

- Migration 017を対象local Supabaseに適用。接続先はloopback DBのコンテナとport bindを確認。Hosted接続なし。
- `step7g-ai-budget-privilege-invariants.sql`: 11/11成功。既存budget roleの制約、membershipなし、private RPC、RLS、app role拒否に加え、default-falseと通常集計・Fixture RPCの条件も確認。
- Go local integration: 開発者Fixture予約を連続12回、並列10回実行し全て成功。日次2/月次10、サービス日次5/月次20、user concurrency1/global concurrency2を超過した状態で成功した。並列10件は全て未settled状態のまま同時に予約し、その後settleした。続けて通常reserveが免除Fixture行22件によりservice日次枠を消費されず成功し、通常予約ではuser concurrency 1が拒否され、settle後は日次2回を許可、3回目を拒否することを確認した。未entitled UUIDは拒否、同一idempotency hashは重複拒否。
- 統合テストが作成したFixture 22行と通常2行、計24件のtemporary usage ledgerは、作業前にledger 0行であることを確認済みのlocal DBでテスト後にcleanupし、残数0を確認した。
- Go `test -count=1 ./...`、`go vet ./...`成功。テストには別subject/Gemini modeの通常予約、開発者entitlementなし403、kill-switch 503、既存401経路も含む。
- 現行コードとlocal `.env`で別loopback port上へAPIを一時起動し、health HTTP 200、未認証generate HTTP 401を確認。試験プロセスは停止した。
- Frontend: 9 test files / 52 tests、typecheck、lint、build成功。Frontendコード変更なし。
- `api/.env`はGit ignore、mode 600を確認。

## 留意点

- Migration 016にはユーザー別またはサービス全体の累積token予算はなく、入出力token上限は1リクエスト単位。FixtureはGeminiを呼ばずusage tokensも0で精算するため、累積token予算の免除処理は存在しない。既存1リクエスト上限と入力サイズ/Schema検証は維持した。
- 既存`127.0.0.1:8080` listenerは無認証生成に503 `generation_auth_unavailable`を返した。起動中の未知プロセスには触れず、別portの今回コードでhealth/401を検証した。通常の開発起動では古いAPIプロセスをユーザーが停止し、`api/run-local.sh`で再起動する必要がある。
- Idempotency-Key再利用拒否を維持するため、実際の免除Fixture usage hash行は削除されない。統合テストで作った行だけは確認後cleanupした。local DBの長期利用におけるledger保持・クリーンアップ方針は未設計である。
- DB special RPCは専用`arvc_ai_budget` roleを信頼し、特定開発者UUIDへの絞り込みはGo APIのlocal configと検証済みJWT subject一致で行う。この設計はloopback専用の開発構成であり、Hostedへ適用しない。
- Migration 017は標準migration historyへ記録済み。Hosted適用は実施・推奨していない。

## 変更ファイル

- `api/cmd/server/main.go`, `api/cmd/server/main_test.go`: local-only flag/UUID設定の検証とAPI wiring。
- `api/internal/service/http.go`, `http_test.go`: Fixture専用予約選択。JWT subjectとFixture modeのスコープテスト。
- `api/internal/aibudget/postgres.go`, `local_integration_test.go`: private Fixture reserve callerと超過/並列local integration。
- `api/run-local.sh`, `api/.env.example`: 明示設定の引き継ぎと無効既定値。
- `supabase/migrations/20261101001700_local_fixture_budget_exemption.sql`: exempt ledger/RPC。
- `supabase/verification/step7g-ai-budget-privilege-invariants.sql`: 追加権限・集計不変条件。
- `docs/ENVIRONMENT_SETUP.md`, `docs/API_CONTRACTS.md`, `docs/SECURITY.md`: local-only運用条件。
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`: 状態・残課題。

Gemini実API、Hosted Supabase、課金設定、DB reset、Migration 001〜016、Project/Asset RLS・Verifier、Frontend実装、GitHub pushはいずれも変更・実施していない。
