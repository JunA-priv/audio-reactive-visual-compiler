# Step 7k-50b — SCNet 2並列化・永続解析ジョブキュー

実施日：2026-11-05（Asia/Tokyo）  
Status：**partial / not deployable**  
Hosted Supabase / GCP / Cloud Run / DB適用：**未実施**

## 調査・判断

- Step 7k-42/46/47/50の報告、Audio Analyze handler、JWT subject context、quota RPC/migration、Editor、環境profile、Docker/Cloud Run候補を確認した。
- 現行同期APIはGo process slot 1、DB Reserve/Start/Settle、user/global concurrency policyを持つ。受付時Reserveをそのままキュー登録へ使うと、枠不足が429になり、待機要件を満たさない。待機ジョブはqueued状態で保持し、実行workerがclaimした後に既存Reserve→Start→Settleを行う必要がある。
- Cloud Tasksは明示的なFIFO/exactly-onceを保証しない。今回の最小候補はPostgreSQL durable queue + DB claimで、各API/Worker processにSCNet slot 1、全DB claim上限2とする構成。ローカルも同じDB claim方式で検証可能。Cloud Tasksを重ねると再試行/所有権/二重claimの責務が増えるため、今回追加しない。
- Queue順序は`created_at, job_id`順のeligible FIFOを提案する。同一ユーザーの先行jobがactiveなら後続userを先にclaimできるため、厳密FIFOは保証しない。
- Cloud Run候補（min 0、concurrency 1、max instances 2）は候補に留める。既存実測は単一SCNetの2vCPU/4GiBのみで、2並列RSS/CPU/遅延は未測定。¥1,000/月も請求上限として保証できない。

## 今回の変更

- additive migration `20261105000100_step7k50b_audio_analysis_jobs.sql`を追加。private DB tableとsubmit/claim/cancel/get/finish RPCのスケッチを含む。queued/running上限20件、音源合計320MiB、user waiting上限2、15分待機期限、冪等性key + content hash、24時間TTL、user ownership predicate、worker lease/retry、terminal時の音源byte purgeを表現している。
- migrationは**未適用**。共有Development/Test DBを変更していない。

## 未実装・未検証（完了条件未達）

- Goの非同期受付/状態/結果/cancel APIとPostgres job storeがない。
- Durable worker、既存解析関数の再利用、quota admissionのworker移行、claimとquotaの回復整合がない。
- React queue state、polling、reload復元、Timeline反映、cancel UIがない。
- MigrationはSQL parser/隔離DBで未検証。RPC権限・RLS・状態遷移・競合・retry/lease・kill switchの実DB検証がない。
- したがってmigrationを適用してはならず、Step 7k-50bは未完了。必要な次工程はGo job lifecycle/store/worker、API/Frontend、隔離PostgreSQL検証、Go race/Frontend regressionを揃えること。

## 費用・性能

実測変更なし。同期実装の過去実測は60秒入力・2vCPU/4GiBで約57–62秒、peak memory約1.85GB。2並列の性能とCloud Run料金への影響は未測定で、月¥1,000目標の達成を主張しない。
