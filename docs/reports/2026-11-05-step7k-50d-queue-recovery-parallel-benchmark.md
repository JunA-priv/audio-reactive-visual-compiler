# Step 7k-50d — 永続解析ジョブのquota冪等性・復旧・2並列実測

実施日：2026-11-05（Asia/Tokyo）  
Status：**partial**  
Hosted Supabase / GCP / Cloud Run / shared Development-Test DB：**未接続・未変更**

## 結果

ジョブの再配送・lease回復に対してquota usageをjob単位で一行に限定し、同じジョブのretryで成功利用回数が増えない方式を追加した。claim attemptを各worker mutationに渡し、古いattemptのquota settle/job finish/requeueを拒否する。DB完了記録前にプロセスが落ちた場合は推論を再実行して状態を回復する。したがってquotaの二重計上は防ぐが、SCNet推論のexactly-once実行や、未保存だった解析結果そのものの復元は保証しない。

実SCNet 2件の同時実行は測定しなかった。Docker hostは16 CPUを報告したが、RAM 7.4 GiB中のavailableが約3.0–3.2 GiB、2 GiB swapのうち約1.6–2.0 GiB使用中だった。既存単一解析の過去値（約1.85 GiB peak）を考慮し、OOMリスクのある負荷は掛けない判断とした。checkpointは存在し、42,434,545 bytes / SHA-256 `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`であることだけをread-only確認した。Docker SCNet image build/runはしていない。

## quota方針・障害境界

| 境界 | 復旧動作 | quota扱い |
|---|---|---|
| claim直後、reserve前 | 15分lease切れで次claimがattemptを進める | usageなし、未消費 |
| reserve後、start前 | 同一jobのreservationを再利用。expired/released pre-start行は再予約状態へ戻す | started_atがない限り未消費 |
| start後、SCNet実行中にWorker停止 | lease後に同じreservationを再利用しattemptをfenceして再推論 | 開始済みjobとして一回消費 |
| quota failed settle後、job finish前 | 同一usage行を再活性化し、次attemptで再推論 | failed attemptもjob全体で一回だけ消費 |
| quota succeeded settle後、job finish前 | lease後に同じusage行を再活性化し、結果を再生成してfinish | 一回消費。推論は再実行され得る |
| job finish後、HTTP応答前 | 同じIdempotency-Keyのjob状態/resultを返す | 再計上なし |
| retry上限到達 | jobを`worker_lease_expired`でterminal化。開始済みreservationは`expired_charged` | 一回消費 |
| start前cancel | lease/RPCでreservation release、job canceled | 未消費 |
| start後cancel | handlerが解析process groupを停止しquota canceledへsettle | 一回消費 |

`audio_analysis_usage.audio_job_id`にunique partial indexを追加し、既存同期解析用のReserve/Start/Settle RPCとその意味は変更していない。非同期失敗後の再試行は同一started_atを保ち、利用枠をretry回数分減らさない。started後に最終失敗・cancelとなるjobも課金対象である。quota ledgerとjob状態は別RPCなので単一transactionではない。SQLが予約を再利用し、attempt-fencedな復旧を行う範囲で整合を保つ。

## 実装

- `supabase/migrations/20261105000200_step7k50d_audio_job_quota_idempotency.sql`：usage/job一対一、attempt付きclaim、job quota reserve/start/release/settle、attempt-fenced finish/requeue。旧unfenced claim/finish/requeue RPCはアプリroleからrevoke。
- `supabase/verification/step7k50d-audio-job-idempotency.sql`：fail→retry→success、settle/finish間lease crash、stale attempt、duplicate RPC、kill switch、pre-start cancel、retry exhaustion、RPC ACLをrollback transactionで検証。
- `supabase/verification/step7k50b-audio-analysis-jobs.sql`：新しいclaim attempt/fenced completion経路を通るようqueue fixtureを更新。
- `api/internal/audiojobs/postgres.go`：attempt-aware RPCとjob quota APIを追加。
- `api/internal/audioanalysis/handler.go`、`jobs.go`：既存同期handlerを保ったままjob-scoped admissionを渡す。解析handlerのreserve/start/settleはjobとattemptへ結び付く。
- `api/internal/audioanalysis/handler.go`：15分以上経過した機能固有のorphan temp directory（analysis/upload prefixのみ）を起動時に掃除。active解析deadline 10分より長いage thresholdを使う。
- 関連Go tests、`.github/workflows/backend-and-migrations.yml`、API契約/env docs、工程状態記録。

## DB・データ保全検証

volumeなし、localhost専用portの新規PostgreSQL 17.11 containerに、forward migration 042 → 050b → 050dを順番に適用した。queue migration直前にsynthetic Auth user、entitlement、成功usage履歴、disabled control値を挿入し、両job migration後も値が保持されることをassertした。データは合成fixtureのみ。verification SQLは全てtransaction内でrollbackし、containerを削除した。共有DBへ接続していない。

queue verificationではclaim上限2/3件目待機、per-user制限、foreign owner拒否、cancelとfinish競合、attempt 1→2→3、lease recoveryを新claim RPCで確認。新しいidempotency verificationでは同一jobの複数reserveが同じreservationを返すこと、started failure後とsuccessful settlement後のlease recoveryが同じreservationを再利用すること、usage row/daily quota countが各一件であること、旧attemptのsettle/finish拒否、同一attemptの二重finish拒否、pre-start cancel未計上、started cancelは一回計上、kill switch、retry上限時の`expired_charged`とterminal failure、RPC権限を確認した。

最初のqueue fixtureは新しいfinish RPCのjob-linked usage条件を満たさず失敗した。fixtureを実際のjob quota RPC順（reserve/start/settle）に直し、fresh databaseで適用から全SQL検証を再実行してPASSした。

## 検証

**実施:**

- `GOCACHE=/tmp/arvc-step7k50d-gocache go test -race ./internal/audioanalysis ./internal/audiojobs ./internal/audiobudget ./cmd/server` — PASS。
- 同4 packageの`go vet` — PASS。
- PostgreSQL 17.11 disposable DB：3 migrations + sentinel preservation + queue + idempotency/recovery SQL — PASS。
- stale temp cleanup（fresh/unrelated directoryを維持し、対象prefixの古いdirだけ削除）を含むaudioanalysis tests — PASS。
- 変更workflow YAMLとembedded shell `bash -n`、両forward migrationのfilename/destructive-operation scan、`git diff --check` — PASS。

**今回は未実施（影響ファイルなし、または安全な測定資源なし）:**

- Frontend test/typecheck/lint/build：Frontend code変更なし。
- Go全package suite：今回のGo差分に関連する4 packageに限定。
- SCNet Docker image build、実SCNet 2並列、3件目の実解析、CPU/RAM/latency/cold-start測定：RAM余裕が不足するため未実施。
- GitHub Actions workflow実行：Hosted GitHub更新禁止のため未実施。

## 残る制約・次の最終確認

- 二並列解析性能、プロセスごとの実メモリ、cold start、CPU割当、月額費用は未測定。Cloud Run max 2でOOMなしとは判断できない。
- DBはclaim leaseが切れた後に新attemptを許可する。通常handler timeout（10分）が15分job leaseより短く設定されているが、host suspend等で旧推論が残存した場合、DB fencingはquota/job更新を拒否する一方、外部プロセスの二重推論を強制排除するものではない。
- SIGKILL時のGo defer cleanupは実行されない。次回API起動時に15分超の対象prefixディレクトリを削除する。コンテナごとのephemeral filesystem、永続diskのquota/監視、Cloud Run termination lifecycleは未実測。
- Cloud Tasks/OIDC/outbox、Hosted Supabase、Cloud Run、RLS/Storageの実環境接続は引き続きStep 7k-50cの未実装・未確認範囲。
- 統合E2E、二ユーザーの一連のUI操作、実SCNet負荷、クラッシュ注入を含む最終総合テストは公開前工程へ持ち越す。

本工程では外部サービス、本番、共有DB、ユーザー実データへの操作を行っていない。
