# Step 7k-51 — クラウド公開準備

**状態：一部完了。本番公開は不可（NO-GO）。** Hosted Supabase、GCP、共有DBへの接続・変更、GitHubへのpush、デプロイは行っていません。

## Step 7k-52 / 2026-11-05 — クラッシュ後の復旧とStorage統合

Step 7k-51後続のStep 7k-52としてStorage分離と非同期解析の統合を実装し、Windows/WSL2再起動後に残りの検証を再開しました。以下はStep 7k-52を含む現在の状態です。Hosted Supabase/GCP/共有DBの変更、GitHubへのpush/merge、公開デプロイは行っていません。

### 実装

- 新規音声は非公開のSupabase Storage bucketに保存し、user UUID / job UUIDでobject keyを分離しました。DBには状態、所有権、Storage参照、quota、intent/outboxを保持します。owner readをStorage policyで制限し、書込・削除はservice権限に限定しています。重複uploadは上書きせず、object keyと音声サイズを制約します。
- `audio_analysis_jobs.audio_wav bytea`を残したままStorage参照を追加し、旧bytea jobを読み取れるdual-readを実装しました。既存音源のbackfillや削除は実施していません。追加migrationは`20261105000400_step7k52_audio_storage.sql`です。
- API upload、job registration、outbox dispatch、Worker claim/lease、Storage download、解析、attempt-fenced result/quota settlement、status/result GET、terminal cleanupを接続しました。upload後のDB失敗やcleanup失敗をintent/cleanup outboxと冪等な再処理で回復する構成です。
- live統合で見つかった空文字error codeのNULL正規化、nullable status GET、settlement失敗後のhandler継続、Supabase Storage object DELETE endpointを修正しました。
- `CURRENT_TASK.md`と`docs/CURRENT_STATE.md`をStep 7k-52の結果へ更新しました。既存のStep 7k-51リリースworkflowとCloud Run/Scheduler成果物は保持しています。

### クラッシュ後の環境と保全

- Docker Desktop/WSL統合を確認しました。通常開発SupabaseとStep 7k-52隔離SupabaseのPostgres/Storage/Auth等は再起動後もhealthyで、DB volumeは保持しています。DB reset、volume削除、Hosted接続はありません。
- `scripts/arvc.sh development start`で既存Go APIとViteを確認し、両方healthyであることを確認しました。既に起動済みだったため再起動していません。Python Island環境は存在します。Python Islandは解析時に起動する構成なので独立常駐プロセスはありません。
- RAM 16 GB / WSL2上限8 GB / swap 4 GB環境で、Go raceとDocker buildを同時実行せず順次実施しました。race開始前後で利用可能RAMは約2.6 GiB、swap使用は約1.7 GiBのままでした。
- live test専用Postgres roleは`NOLOGIN`にし、fixture job/intent/cleanup/usage/auth userとStorage objectが残っていないことを確認しました。専用検証Docker image/cache volume、一時資格情報とbuild成果物は削除しました。空のroot所有`/tmp/arvc-step7k52-isolated`ディレクトリだけは、正式な昇格を試してもOSの権限拒否で削除できず残っています。実行中のSupabase containerからはmountされていません。

### Step 7k-52検証結果

- 隔離Supabaseへのlive upload → job登録 → outbox claim → Worker claim → fake analysis → quota settlement → terminal job → status/result GET → Storage cleanupが成功しました。quota reservationは1件で、active/terminalの重複deliveryはそれぞれfenced/idempotentでした。
- Storage policyをlive確認し、所有者readは許可、他ユーザーとanonymous readは拒否、service削除後にobjectが取得不能であることを確認しました。
- `supabase/verification/step7k52-audio-storage.sql`を隔離DBで実行し、`BEGIN` / invariant `DO` / `ROLLBACK`が成功しました。fresh isolated DBへの全migration適用もStep 7k-52検証で成功済みです。既存byteaデータの削除はありません。
- `GOMAXPROCS=2 go test -count=1 -p 1 -race ./internal/audiojobs ./internal/audioanalysis ./cmd/server`成功。sandboxのIPv6 loopback bind拒否後、許可された権限昇格で実行しました。対象`go vet`と`go build`も成功しました。
- Docker image buildと一時containerのhealthcheck HTTP 200を確認しました。検証後、Step 7k-52専用imageとcache volumeは削除しました。
- GitHub workflow / Cloud Run YAML 5ファイルのparse、workflow内bash 8ブロックの`bash -n`、migration破壊操作guard、`git diff --check`が成功しました。
- Frontend 192 tests/typecheck/lint/buildは、この変更でFrontendコードが変わっていないため、Step 7k-51前後の既存成功結果を再利用しました。今回再実行していません。

### 未検証事項と公開判定

- 実SCNet推論負荷、ブラウザE2E、実Hosted Supabaseの障害/容量/権限、Cloud Run/Tasks/Scheduler/IAM実動作、実費用は今回の隔離検証に含めていません。¥1,000/月以内やSupabase Freeでの長期容量適合は未証明です。
- Hosted release workflowは実行していません。Production Environment承認、secret、WIF/IAM、Supabase project ref、Cloud設定など本番適用事項は未設定・未承認です。本番公開は引き続き**NO-GO**です。

変更範囲の詳細はrepositoryの最終Git差分と`CURRENT_TASK.md` / `docs/CURRENT_STATE.md`を参照してください。未コミット変更を保持し、push/mergeは行っていません。

---

## Step 7k-51時点の記録

### 実装した内容

- Cloud Run APIと、2分間隔で実行するScheduler復旧処理のテンプレートを追加しました。APIとWorkerはゼロスケールとインスタンス数上限を維持し、専用IDと非公開タスク認証を使います。Cloud Tasksのkill switchは既定で無効です。
- 明示確認、保護された`production` Environment、変更不能なArtifact Registryのイメージdigest指定を必須とする手動Hostedリリースworkflowを追加しました。migration適用後にAPIとWorkerをトラフィックなしでデプロイする構成です。workflowは実行していません。
- IAM・Secretの設定手順と停止・復旧手順を記録し、CURRENT_STATEとCURRENT_TASKを更新しました。

### 当時の未完了内容

- 音声は引き続き`audio_analysis_jobs.audio_wav bytea`に保存されています。Storage分離は未実装です。既存のsubmit、claim、retry、fencing、終端時cleanupの各RPCはbytea契約に依存しています。既存ジョブ、所有者認可、attempt fencingを保つには、前方互換のdual-readとバックフィルを設計する必要があります。アップロード経路だけを変更すると、キュー内のジョブを処理できなくなります。このためFreeプランの容量適合は未確認で、現行のDB音源上限320 MiBは500 MBのDB容量を前提とした本番運用に適しません。
- Hosted Supabase Freeへの適合、Cloud Tasks/Run/Scheduler/IAMの実動作、費用目標、SCNet同時実行時の資源負荷、Dockerイメージとhealthcheck、新規のクリーンな隔離DBでのmigration適用は未検証です。これらの確認が済むまで本番機能を無効にしてください。

### 当時の検証結果

- Frontend：テスト192件、typecheck、lint、buildが成功しました。
- Go：`audioanalysis`、`audiojobs`、`audiobudget`、`authn`、`cmd/server`のrace testが成功し、`go vet ./...`とサーバーbuildも成功しました。全体の`go test -race ./...`は既存の`internal/service`テスト内にある`httptest.NewServer`のIPv6 bindで、sandboxから`operation not permitted`となり失敗しました。
- migrationの前方互換ガードと`git diff --check`は成功しました。このStepではmigrationファイルを追加していません。
- 外部DNS/ネットワークが利用できず、Pythonテストに必要な依存要件を解決できませんでした。
- YAML parserで追加workflowとCloud Run/Schedulerの全YAMLテンプレートを読み込めました。`actionlint`、Supabase CLI、PostgreSQL clientは環境にありません。`/var/run/docker.sock`へのアクセスが拒否されDocker buildを実行できませんでした。workspace内にcheckpointファイルもありません。
- 最終Git差分は、記載したworkflow、デプロイテンプレート、README、状態記録、報告書のみです。

### 本番適用に必要な外部設定と承認

レビュー担当者を設定した保護GitHub `production` Environment、Supabase access tokenとproject ref、GCP Workload Identity Federation providerと最小権限のrelease identity、GCP project/region、Artifact Registryのイメージdigest、Cloud Run service identity、Secret ManagerのDSN、Cloud Tasks queue、Scheduler OIDC identity、invoker IAMの設定が必要です。まず非公開Storageへの移行とバックフィル、隔離DB・統合検証を完了し、音声の保存容量上限と保持期間を実測に基づいて定め、バックアップ・復元を検証してください。そのうえでスモーク確認とトラフィック切替の手順を承認してください。リリースworkflowはrevisionにトラフィックを割り当てない構成です。
