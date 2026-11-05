# Step 7k-55 — Hosted Supabase Free互換性修正

**Status: completed（ローカル実装・隔離検証まで。Hosted/GCP/GitHub未適用）**

## 実装

- Storage key kindを必須化。新形式`sb_secret_…`は`apikey`のみ、旧形式JWTは`service_role` claimを確認して`apikey`とBearerの両方に送信する。API/Workerのテンプレートと`.env.example`にkindを明示。秘密値をFrontend・URL・ログへ出さない。
- Hosted DB接続検証を共通化。`arvc_audio_analysis`と`arvc_ai_budget`だけを許可し、Hostedでは期待するproject ref、`aws-<index>-<region>.pooler.supabase.com:5432`のSession Poolerまたは同projectのDirect endpoint、TLS hostname verification、`postgres` DBを照合。local loopback Direct接続は維持。Hosted各poolは1接続に制限。
- `AUTH_ENV=hosted`でlocal fixture quota exemptionを拒否する。
- 017/018を含む既存23件のmigrationファイル・履歴は改変しない。新規空Hosted projectの初回は23件全てをtimestamp順に適用する。017のfixture RPCはDB履歴に残すがHostedアプリから呼ばせない。018のmodel/pricing更新は空projectの初回baselineに限定し、単独・既存データへの遡及適用を拒否する。
- Hosted release workflowを保護`production` Environment、digest、project ref、protected Pooler host、明示migration一覧、初回空project確認の組み合わせに変更。23件すべてのSQL hash manifest、migration list、`db push --dry-run`の3者一致を確認後にだけ適用し、適用後も全履歴を照合する。不一致・失敗時は停止し、自動retry・`migration repair`・rollbackをしない。Backend CIにもmanifest/target guardを追加。
- OIDC保護された任意の`GET /internal/ops/supabase-health`を追加。3秒timeoutで`SELECT 1`だけを実行し、成功204/失敗503を返す。DB詳細は応答・ログに含めず、dispatch・Storage cleanupとは別経路。
- 8時間Scheduler jobはテンプレートと運用手順のみ。既存2分dispatch recoveryとはidentity/endpoint/責務を分離。Scheduler失敗とCloud Run 5xxをMonitoringで通知し、失敗時は音声受付/Tasksを止めてSupabase状態を確認する。定期PingはFree自動pauseの回避を保証しない。Google Cloudの現行表示はbilling accountあたり3 Scheduler jobs無料、超過は$0.10/job/31日。残り無料枠とMonitoring費用は未確認。課金が発生するresource作成前に停止・予算承認を得る運用とした。

### Migration 017 / 018の適用判断

通常のSupabase CLI migration順序とmigration履歴を維持し、履歴repairやファイル除外をしないため、空projectの初回baselineに両方を含める。017はアプリ起動時のlocal-only guardで無効化する。018は016で作られる初期AI budget model (`gemini-3.8-flash`) を現行Go allowlist (`gpt-6-luna`) に合わせる内容であり、ユーザーusageが存在しない初回に限る。workflowは017または018だけの部分適用を拒否する。migration履歴のない既存オブジェクトを含むprojectは「空」と見なさず、初回baselineを実行しない。

## 検証結果

- Go対象6 packages: `go test -race -p 1` PASS、`go vet -p 1` PASS、`go build -p 1 ./cmd/server` PASS。`httptest`のloopback bindはdefault sandboxで拒否されたため、許可済みローカル検証として正式な権限昇格で再実行し成功。
- Storageのsecret API key / legacy service-role JWTそれぞれについて、PUT/GET/DELETE、no-overwrite/idempotency、Authorization headerの回帰テスト PASS。HTTP health endpointのunauthenticated/healthy/failure応答とDB詳細非露出テスト PASS。
- Pooler parserの正/誤role、project ref、host、port、TLS、database、local Direct条件をテスト。任意のDB role拒否 PASS。
- Hosted migration manifest 23/23 hash照合、forward migration safety、CLI表形式ASCII/Unicodeのmock、dry-run/list不一致、017/018部分適用拒否、初回空project確認、migration DSN targetのPython guard tests PASS。
- `.github/workflows/hosted-release-approved.yml`と変更Cloud Run YAMLのYAML構文、release Environment・migration適用順・shell `bash -n`・fail-closed静的条件 PASS。
- Dockerの既存開発Supabaseと`arvc-step7k52-isolated` Supabaseは開始前後とも稼働。隔離DBをread-only transactionで確認し、migration 23件全て適用済み。DB/Storage/volumeへの書込みなし。
- `git diff --check` PASS。今回Hosted/GCP/GitHub CIへは接続せず、migration apply/deploy/push/mergeも未実施。

## 変更ファイル

アプリ：`api/cmd/server/main.go`、`api/cmd/server/main_test.go`、`api/internal/audiojobs/{postgres.go,storage.go,storage_test.go}`、`api/internal/audiobudget/{postgres.go,postgres_test.go}`、`api/internal/aibudget/postgres.go`、`api/internal/audioanalysis/{cloudtask_http.go,cloudtask_http_test.go,storage_live_integration_test.go}`、新規`api/internal/supabasepg/`。

運用・CI：`.github/workflows/{backend-and-migrations.yml,hosted-release-approved.yml}`、`api/.env.example`、`deploy/cloud-run/{README.md,audio-api.service.yaml,audio-worker.service.yaml,audio-db-healthcheck.job.yaml}`、`deploy/hosted-migrations.sha256`、`scripts/tests/{check-hosted-migration-dsn.py,check-hosted-migration-manifest.sh,check-hosted-migration-target.py,test-hosted-migration-guards.sh}`。

状態：`CURRENT_TASK.md`、`docs/CURRENT_STATE.md`。Step 7k-54由来の未コミット報告書はそのまま保持した。

## 未検証・適用前事項

- Hosted Supabase接続は絶対制約に従い未実施。`sb_secret_`を実Supabase Storageへ通すHosted live test、Free projectのpause/resume、実Hosted DB role/extension/migration権限は未確認。Storage HTTPの新key headerはwire-level mockで確認し、過去Step 7k-52の隔離Storage owner policy成功結果を再利用。
- 専用Step 7k-52 live-test資格情報は未設定のため再利用しなかった。今回の隔離DB確認はread-only migration inventoryであり、Storage/Go API live roundtripの再実行ではない。
- Supabase CLI 2.121.0実バイナリとGitHub Actions runnerでは未実行。CLI出力はASCII/Unicode fixtureで検査したが、対象CLIの実出力差異は適用前に隔離Hosted相当環境でdry-run確認が必要。Hosted workflowは不明な出力を拒否する。
- 新規Hosted projectのref/region/Pooler host、`SUPABASE_MIGRATION_DSN`、runtime DB role、Storage key kind/secret、protected `production` Environment reviewer、GCP service identity/Secret Manager、healthcheck OIDC service account、Scheduler/Monitoring alert channelと課金枠が未設定。
- 健康確認を有効にするScheduler/alertはテンプレートのみで、GCP resource未作成・未課金。Freeの自動pause回避は保証されない。これらのExternal設定・費用承認・初回migration/DB restore/Storage smokeの承認が済むまで公開NO-GO。
