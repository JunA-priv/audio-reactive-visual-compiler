# Step 7k-50c — SCNet永続キュー・Hosted Supabase/CI-CD対応

実施日：2026-11-05（Asia/Tokyo）  
Status：**partial / 本番リリース不可**  
Hosted Supabase / GCP / Cloud Run / 共有DB / GitHub push / deploy：**未実施**

## 要約

Step 7k-50bのmigration案を実装・隔離検証し、local profileで使える永続非同期解析API/workerとEditor queue UIを追加した。待機中はquota reserveもSCNet実行も行わず、worker claim後に既存の同期Audio Analyze handlerを呼び、既存Reserve/Start/Settle契約を通す。PostgreSQLが状態と実行権限の正本。DB claimはglobal 2、user 1、eligible FIFO近似。Cloud Tasks/Hosted worker transportは今回実装していないのでHosted jobsはfail-closed。

## 変更内容

- `supabase/migrations/20261105000100_step7k50b_audio_analysis_jobs.sql`：private job tableとSECURITY DEFINER RPC。owner、idempotency/hash、bounded payload/result、global/user claim cap、lease/retry、cancel marker、queue expiry、24h terminal retention、terminal audio purge。
- `supabase/verification/step7k50b-audio-analysis-jobs.sql`、`step7k50b-preservation-{before,after}.sql`：submit/claim/cancel/get/finish/retry、quota、所有権、lease、migration前後のsentinel保持検証。
- `api/internal/audiojobs/`、`api/internal/audioanalysis/jobs.go`：PostgreSQL store、非同期受付/状態/result/cancel、process内1解析のpolling worker、既存解析handler/quota経路再利用。
- `api/cmd/server/main.go`とenv samples：opt-in local jobs feature、Hosted mode fail-closed、graceful worker shutdown。
- `frontend/src/audio-analysis.ts`、`VisualEditor.tsx`、tests：queued/running/done/error/cancelled、poll/cancel/reload restore、Timeline result反映、source change guard。同期API helperは維持。
- `.github/workflows/backend-and-migrations.yml`、`release-candidate.yml`、`production-release-readiness.yml`、`scripts/tests/check-forward-migrations.sh`：PR race/SQL migration/preservation/destructive scan、main artifact、Environment gate付きproduction readiness only。Production apply/deployは実装せずworkflowから接続しない。
- `docs/API_CONTRACTS.md`：新規APIとHosted transport制限を明記。

## DB・データ保全検証

共有Development/Test DBには接続・変更していない。volumeなし・localhost port 15439だけにbindした使い捨てPostgreSQL 17.11 containerへ、quota migration 042とqueue migrationを適用した。042前後ではなくqueue migration直前にsynthetic Auth user、entitlement、成功usage履歴、disabled kill-switchの個別値を投入。queue migration後に4 sentinelすべてが保持されることをassertし、queue RPC検証をrollback transaction内で実施した。結果：2ユーザー分のclaimが上限2、3件目wait、同一userの待機制限、他ownerの参照拒否、queued cancel、lease再claim、cancel/finish競合、result owner read、音源cleanup、既存quota Reserve/Start/Settle整合チェック成功。Migrationはforward-onlyで既存表のDROP/初期化なし。検証終了後、使い捨てcontainerを停止・削除した。

これはAuth/DB sentinelの非破壊検証であり、Hosted migration history、既存の本物ユーザーデータ、Cloud Storage権限、Supabase RLS運用を証明するものではない。

## テスト結果

- `GOCACHE=/tmp/arvc-step7k50c-gocache go test -race ./...` — Go全package PASS。既存service httptestがIPv6 loopbackを要求するためsandbox socket permissionを許可したローカルtest runで完了。
- `GOCACHE=/tmp/arvc-step7k50c-gocache go vet ./...` — PASS。
- Frontend全suite — 15 files / 192 tests PASS。`npm run typecheck`、`npm run lint`、`npm run build` PASS。
- workflow YAML parse、migration guard shell syntax、`git diff --check` — PASS。
- 実SCNet 2件の同時inference、Docker CPU/RAM/実行時間、Full Supabase CLI workflow、Cloud Tasks delivery、ブラウザ実表示 — 未検証。

## 安全・運用上の未完了

- Cloud Tasks enqueue/OIDC、outbox相当のdispatch recovery、redelivery/backoff、Cloud Run worker専用service/min0 wakeupを未実装。現在のpolling goroutineはローカルprofile専用である。
- Workerがquota Start後に解析を完了し、job finish前にhard-crashした場合、lease retryで解析が再実行される可能性がある。DB claimで同時実行/二重deliveryは抑止するが、inference+quota settlementをまたぐexactly-once crash recoveryは未成立。2回目のReserveが課金回数へ影響し得るため、production前にjob attemptとquota reservationを同一のidempotent contractへ結ぶ必要がある。
- PR workflowは定義したがGitHub Actions上では未実行。main release artifactはfrontend+Go binary+差分migration inventoryまでで、SCNet checkpointを含むCloud Run imageを作成しない。production workflowはprotected Environment readiness placeholderで、reviewers/variablesの実設定も未確認。
- Hosted JWT/JWKS、専用DB role/connection pool、RLS/Storage policy、CORS/HTTPS、Secrets、Cloud Run IAM/OIDC、migration compatibility、backup/restore readinessは実接続なし。
- 既存同期API互換はfocused Go/Frontend testsで確認。Cloudflare Pages deploy設定、実ブラウザE2Eは未確認。

## 性能・費用

キューclaim上限は2だが、実SCNetを2並列で走らせた実測値はない。Step 7k-50の既存単一解析測定（2vCPU/4GiB、60秒入力で約57–62秒、peak memory約1.85GiB）を2倍して費用や容量を推定しない。Cloud Run min instances 0/max 2/concurrency 1は候補であり、Cold start・RAM/OOM・CPU・Cloud Tasks/DB/Storage/egressの実使用量が未測定。月額¥1,000以内を保証できない。

## 本番前に必要な承認・作業

1. Crash-after-Start settlementを解決するquota/job idempotency契約とfailure semanticsを確定。
2. Cloud Tasks + OIDC + dispatch recovery/outbox + dedicated worker実装、min0復帰・重複配送を隔離統合テスト。
3. 2件の実SCNet Docker測定と同時RAM/CPU/latency/cost model、必要に応じてglobal capを調整。
4. Hosted clone/backupを用いたforward migration、JWT/RLS/ACL/Storage ownershipとrestore drill検証。
5. GitHub Environment reviewers/project identity/secrets/backup readiness設定をレビューし、本番migration/deployの別途明示承認を得る。

本作業では本番対象への操作を実施していない。
