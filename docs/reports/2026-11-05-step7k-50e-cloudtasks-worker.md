# Step 7k-50e — Cloud Tasks配送・Cloud Run Worker

**状態：partial（本番利用は無効）**　2026-11-05

## 実装内容

- forward-only migration案 `20261105000300_step7k50e_audio_job_dispatch_outbox.sql` を追加しました。ジョブ登録とoutbox登録を原子的に行い、DBの配送claimで実行可能なジョブを最大2件まで確保します。登録時刻とjob IDに基づく順序を保ち、配送世代番号で古い通知を無効化します。配送失敗には再試行間隔を設けます。復旧claimは期限切れのjob leaseを回収し、再試行用の配送世代を進めます。ジョブとquotaの状態は引き続きDBを正本とします。
- `{jobId,generation}` のみを送るCloud Tasks RESTアダプタを追加しました。Cloud Runメタデータからアクセストークンを取得し、OIDCタスクIDと決定的なタスク名を使います。重複作成の可能性がある応答（409）は、すでに登録済みとして扱います。
- APIでの受付時にoutbox配送を試みる処理と、配送通知またはAPIの一時停止から復旧するための認証付き定期起動endpoint（`POST /internal/jobs/dispatch`）を追加しました。
- Worker専用のservice roleと`POST /internal/tasks/audio-analysis`を追加しました。Google OIDCのissuer・audience・有効期限・emailを検証し、指定されたjob generationだけをclaimします。既存のSCNet/quota/attempt fencing付き処理を呼び出し、処理中または未完了の場合は再試行可能なHTTPエラーを返します。Workerが処理を終えると、次に実行可能なジョブの配送を起動します。既存のローカルpollingと同期APIは維持しています。
- Cloud Run Workerのtemplateを追加しました（min 0/max 2/concurrency 1、request-based CPU、2 vCPU/4 GiB、request timeout 780秒）。IAMとdeadlineの設定方針も記載しました。`cloud_tasks` transportでは`AUDIO_ANALYSIS_CLOUD_TASKS_ENABLED`が必要です。既定値とtemplate・環境例ではfalseのままにしています。

## 変更ファイル

- `api/internal/audiojobs/postgres.go`、`cloudtasks.go`、`cloudtasks_test.go`
- `api/internal/audioanalysis/jobs.go`、`cloudtask_http.go`、`google_oidc.go`、`cloudtask_http_test.go`
- `api/cmd/server/main.go`、`api/.env.example`
- `supabase/migrations/20261105000300_step7k50e_audio_job_dispatch_outbox.sql`
- `supabase/verification/step7k50e-audio-job-dispatch.sql`
- `deploy/cloud-run/audio-worker.service.yaml`、`deploy/cloud-run/README.md`
- `docs/API_CONTRACTS.md`、`docs/CURRENT_STATE.md`、`CURRENT_TASK.md`、本報告書

## 検証結果

- `go test ./internal/audiojobs ./internal/audioanalysis ./cmd/server`：PASS
- 同じpackageの`-race`テスト：PASS
- 同じpackageへの`go vet`：PASS
- `go build -o /tmp/arvc-server-step50e ./cmd/server`：PASS
- `git diff --check`：PASS
- 対象を絞ったテストで、Cloud Tasksのpayloadと認証header、作成成功・重複409・失敗、outboxの成功・失敗記録、Workerの未認証要求拒否、および既存の解析/quota経路を確認しました。

Sandboxの制約でloopback listenerを使うテストができなかったため、新しいenqueueテストはネットワークを使わず、プロセス内HTTP `RoundTripper`を使用しました。初回実装時はPostgreSQL toolingが使えず050eを未実行でしたが、後続の補完作業で下記の隔離DB検証を完了しました。共有DB/Hosted DB、GCP、Cloud Tasks、Cloud Run、GitHubへの操作やデプロイは行っていません。

## 未検証項目・次の作業

- 設定したservice roleを介したローカルHTTP統合の後、最終確認でCloud Tasks/Cloud RunのIAM・OIDCと、実SCNetを使う2 Workerの同時解析を検証してください。task再試行枯渇時とSIGTERM/request cancel時も対象に含めてください。
- min 0環境でジョブを起動するにはCloud Schedulerが必要ですが、実装したのは認証付きendpointまでです。Scheduler jobとOIDC identityは、後続の承認済みクラウド作業で作成・設定してください。
- Cloud Run Worker YAMLはresource/imageがplaceholderで、機能flagもfalseのtemplateです。APIのデプロイ設定、IAM binding、queue、Secret、VPC/DB network、image digestは未設定です。
- 現状ではSupabase Freeで安全に運用できることを確認できていません。queue受付上限だけでも、PostgreSQL overhead、terminal result、既存project dataを含める前のactive WAVが320 MiBになり得ます。Hostedで有効化する前に、Supabaseの[現行プラン上限](https://supabase.com/docs/guides/platform/billing-on-supabase)、[pause policy](https://supabase.com/docs/guides/platform/going-into-production#free-plan)、backup体制を再確認してください。private object storageとTTLの利用、または計測済みDB容量に合わせたaggregate queue上限の引き下げを検討してください。実クラウド費用は発生していません。月額費用とSCNetのCPU/RAM/cold startは未計測で、月額1,000円以内を達成したとは判断できません。
- Frontend、ブラウザE2E、Go全suite、Docker再build、実SCNet並列、広範囲な回帰テストは実施していません。これらは公開前の最終確認に残します。

## Step 7k-50e補完 — PostgreSQL隔離検証（2026-11-05）

**補完検証結果：PASS。** 050eを含むDB契約を、volumeなし・host port非公開のPostgreSQL 17.11 Supabase image（`sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`）で検証しました。containerのhealthはhealthy、専用Docker networkは`Internal=true`、port bindings `{}`、mounts `[]`を確認しました。使い捨てcontainer/networkとmode 600の一時credentialは終了後に削除しました。既存のSupabase container/volume/networkは変更していません。

### 実行したSQL

fresh DBに既存7c/7g migration由来の`arvc_internal` schemaと`arvc_asset_verifier`/`arvc_ai_budget`の非login roleだけを基盤状態として用意し、以下を`psql -X -v ON_ERROR_STOP=1`で順に実行しました。

1. `20261104000100_step7k42_audio_analysis_quota.sql`
2. `step7k50b-preservation-before.sql`（synthetic Auth/entitlement/usage/control sentinel投入）
3. `20261105000100_step7k50b_audio_analysis_jobs.sql`
4. `step7k50b-preservation-after.sql`
5. `20261105000200_step7k50d_audio_job_quota_idempotency.sql`
6. `20261105000300_step7k50e_audio_job_dispatch_outbox.sql`
7. 050e後に`step7k50b-preservation-after.sql`、`step7k50e-audio-job-dispatch.sql`、`step7k50b-audio-analysis-jobs.sql`、`step7k50d-audio-job-idempotency.sql`

すべてのmigration SQLはexit 0。各verification SQLは`BEGIN`→`DO`成功→`ROLLBACK`で終了しました。

050e専用検証は、job submitとoutbox行の同時作成・呼出元rollback時の両方rollback、2件dispatch/3件目pending、enqueue失敗後のbackoff行を再dispatch、kill switchによるdeferと旧generation拒否、duplicate active deliveryのbusy応答、期限切れleaseのjob再queue・generation/attempt更新、実行中cancelとquota settle/finish、terminal/cancel済jobのdispatch完了、dispatch表の直接ACL拒否・FORCE RLS・RPC EXECUTE権限を確認します。既存の050b queue verificationと050d quota/idempotency verificationも適用後の050eと合わせてPASSしました。

### 検出した失敗と修正

- 最初の042適用は、fresh Supabase imageに事前migrationで作る`arvc_internal` schemaがないため停止しました。途中適用された専用containerだけを削除し、必要な既存schema/roleの基盤状態を隔離環境内に再現してfresh DBからやり直しました。
- 最初の050e SQL検証では、`dispatch_claim`のPL/pgSQL row変数`d`とSQL aliasが衝突していました。row変数を`v_dispatch`に改名しました。
- 既存idempotent submitの回帰検証では、戻り値列`job_id`と`ON CONFLICT(job_id)`が曖昧でした。主キー制約名`audio_analysis_job_dispatch_pkey`を指定しました。
- 次のtask claim検証では、戻り値列`user_id`と未修飾subquery列の衝突が見つかりました。job tableに`active` aliasを付け列参照を修飾しました。

これらの修正後、すべてfresh DBからmigration適用とfocused verificationを再実行しPASSしました。既存 sentinel 4件は最後の保全検証でも保持されました。検証はSQLを直接適用した使い捨てDB内のみで、共有/Hosted DBやmigration履歴tableは変更・検証していません。7c/7g以外の全履歴migrationは適用しておらず、Cloud Tasks/Cloud Run/Scheduler/IAM、実SCNet並列、費用は引き続き未確認です。
