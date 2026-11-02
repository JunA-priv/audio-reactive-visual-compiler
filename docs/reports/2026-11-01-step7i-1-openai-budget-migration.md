# Step 7i-1 — Migration 018のローカル適用・動作検証

実施日：2026-11-01

## 結果

**status: completed（local-only migrationとFixture検証）**。Migration 018を既存のloopback-only local Supabaseへ適用し、OpenAI model/pricing設定、既存認可・予算制御、Fixture経路を検証した。Hosted Supabaseへの接続、OpenAI実API呼び出し、課金設定変更は行っていない。

## 適用前確認

- Dockerの対象DB containerを特定し、PostgreSQLのpublished portが`127.0.0.1`と`::1`の`54322`だけであることを確認した。
- Supabase CLIのlocal migration履歴は001〜017適用済み、018のみ未適用だった。
- 既存予算はuser 2/day・10/month、service 5/day・20/month、input/output 8,000/4,000 tokens、global/user concurrency 2/1、service月次予算$1.50、enabledだった。
- AI usageは8行、entitlementは1行。既存データのrow fingerprintを適用前後で比較した。
- Step 7b/7c-1/7gの権限不変条件を実行可能な状態で確認した。
- Migration 018はsingleton予算設定のmodel/pricing rowと、そのmodel CHECK制約だけを変更する内容だった。既存usage・entitlement・RLS・GRANT・role変更や破壊的SQLは含まれない。

## 適用と復旧

初回適用は新しいmodel CHECK制約をGemini model rowに先に追加しようとして失敗した。CLIの適用履歴に018は記録されず、PostgreSQL migration transactionがrollbackしたこと、既存Gemini row・usage・entitlementが保持されていることを確認した。

許可されたMigration 018だけを、既存制約をdrop → singleton rowを更新 → 新制約を追加、の順に修正した。再適用は成功し、001〜018がlocal migration履歴に存在する。001〜017は変更していない。

## 適用後設定

| 設定 | 確認値 |
|---|---:|
| Model | `gpt-6-luna` |
| Pricing version | `gpt-6-luna-standard-2026-11-01` |
| Input rate | 100,000 micro-USD / 1M tokens |
| Output rate | 500,000 micro-USD / 1M tokens |
| User requests | 2/day、10/month |
| Service requests | 5/day、20/month |
| Input/output max | 8,000 / 4,000 tokens |
| Global/user concurrency | 2 / 1 |
| Service monthly budget | 1,500,000 micro-USD（$1.50） |
| Enabled | true |

既存usageは8行のままで、過去行の価格snapshotはMigrationで更新されていない。Entitlementは1行のままで、適用前後のfingerprintが一致した。テスト用の一時Auth user、entitlement、usageは作成後に削除し、既存行は維持した。

権限検査はStep 7b 9/9、Step 7c-1 15/15、Step 7g 11/11の全項目がpassした。

## API・Fixture検証

- 既存`127.0.0.1:8080` listenerは所有者・実行ファイル・作業ディレクトリを確認し、このリポジトリのGo APIと特定した。起動環境はFixture modeで、OpenAI API keyはGo processに設定されていなかった。既存プロセスはそのまま使った。
- `GET /healthz`: HTTP 200。
- 未認証`POST /api/v1/blueprints/generate`: HTTP 401 `unauthorized`。
- 一時ローカルAuthユーザーと一時entitlementで一般ユーザー経路を確認：Fixture生成2回がHTTP 200、日次上限後がHTTP 429。成功応答BlueprintはGo validatorで有効と判定。
- 一時usage snapshotでmodel/pricing version/rates、最大予約2,800 micro-USD、`quota_exempt=false`、成功状態を確認した。
- 一般ユーザーの日次枠を消費しない開発者Fixture exemption統合試験に成功。試験生成の24 usage行だけを削除し、実行前後の開発者usage request ID一覧が不変であることを確認した。
- OpenAI実APIは呼び出していない。既存Go Mock testsはResponses API request/model/schema/error/usage経路を検証する。実モデルの受入れ可否、実usage値、請求は未確認。

## 回帰検証

- Go `go test -count=1 ./...`: 成功。
- Go `go vet ./...`: 成功。
- Frontend tests: 9 files / 58 tests成功。
- Frontend typecheck、lint、build: 成功。
- `git diff --check`: 成功。

## 変更ファイル

- `supabase/migrations/20261101001800_openai_gpt6_luna_budget_pricing.sql`: Migration 018の制約とrow更新順を安全に変更。
- `supabase/verification/step7g-ai-budget-privilege-invariants.sql`: Gemini固定値だった検査をOpenAI model/pricing policyに追随。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`: 適用済みの実態へ更新。
- `docs/API_CONTRACTS.md`、`docs/COST_MANAGEMENT.md`、`docs/ENVIRONMENT_SETUP.md`、`docs/SECURITY.md`、Step 7i provider報告: local-only適用状況を反映。
- 本報告。

## 未確認事項

- OpenAI実API疎通、対象アカウントでのmodel利用可否、Structured Outputsの実応答、token usage、実請求は未確認。
- OpenAI project hard spend cap・API key project restrictionは未確認。DBの月次$1.50はアプリ内admission controlであり、provider請求の絶対上限を保証しない。
- Migration 018はHosted Supabaseへ未適用。Hosted用の権限・接続・移行手順は別工程で検証が必要。
- ローカルAPI processは既存Fixture設定で稼働を継続している。OpenAI modeへの切替やAPI key設定は行っていない。
