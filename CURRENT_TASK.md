# CURRENT_TASK — Step 7k-55：Hosted Supabase互換性修正

**Status: completed（ローカル実装・隔離検証まで。Hosted/GCP/GitHub未適用）—** Storage key kind別header、Free IPv4 Session Pooler専用role/project-ref/TLS検証、017/018初回baseline方針、migration manifest/dry-run fail-closed workflow、local fixture Hosted拒否、8時間read-only OIDC DB healthcheckと通知/費用運用を実装。Go対象package race/vet/build、静的migration/workflowガードPASS。隔離DB 23 migrations read-only確認。Hosted接続/GCP資源/production CIは未実施。公開はHosted/課金設定と実CLI/Hosted相当dry-run確認までNO-GO。詳細：[Step 7k-55 report](docs/reports/2026-11-05-step7k-55-hosted-supabase-compatibility.md)。

---

# HISTORICAL — Step 7k-54：Hosted Supabase移行準備

**Status: partial（調査・条件付き計画。Hosted適用NO-GO）—** main `42627b771108dbc40f33dc561388c943955c9ffa`をread-only確認。新規空project、データ非移行、Free枠・Auth/DB/Storage/IAM・backup/recoveryを整理。Hosted適用前ブロッカー：(1) Storage clientが新形式`sb_secret_`をBearer送信、(2) Go DSN parserがFree IPv4 pooler role usernameを拒否、(3) migration 018はHosted適用禁止コメントがある一方release workflowは未適用migrationを全適用し、017はlocal fixture quota関数を追加するため適用対象が未確定。Hosted DB role/credential、Auth key、region、CLI経路も未確認。Hosted/GCP/GitHubへの接続・更新・適用なし。詳細：[Step 7k-54 migration readiness](docs/reports/2026-11-05-step7k-54-hosted-supabase-migration-readiness.md)。

---

# HISTORICAL — Step 7k-52：Supabase Storage移行・非同期解析統合

**Status: completed（Hosted適用なし）—** 新規音声をprivate Supabase Storageへ保存し、既存`audio_wav bytea`ジョブとのdual-readを維持。job/user単位の参照、upload intent・outbox・Worker claim/fencing・quota settlement・terminal cleanupを統合。Storage uploadはno-overwrite、owner read policy、service-only mutation、制限付きobject key/sizeを適用。DB/Storage部分失敗はintent/cleanup outboxと再試行で回復可能。旧byteaは削除・backfillせず保持。隔離Supabase Storage/DB live round trip（owner/他ユーザー/anonymous、dispatch、duplicate delivery、結果GET、quota一回、Storage delete）PASS。Go race/vet/build、Step 7k-52 SQL verification、Docker image build/healthcheck、workflow/YAML/shell/diff checks PASS。WSL再起動後も開発/隔離Supabase DB volumeを保持し、API/Vite healthyを確認。Hosted/GCP/共有DB変更・push/deployなし。

**未実施・公開制約：** 実SCNet推論負荷、実ブラウザE2E、Hosted障害/容量/費用試験は未実施。Step 7k-51の実Hosted/GCP設定は未適用で公開NO-GO。既存開発・隔離Supabaseは稼働・保持。一時DB roleは`NOLOGIN`、テスト行とStorage objectは0件。専用検証image/cache volume・一時credential/build成果物は削除済み。空のroot所有`/tmp/arvc-step7k52-isolated`のみOS権限で削除できず、実行中Supabase containerからは未mount。

---

# HISTORICAL — Step 7k-51：クラウド公開準備

**Status: partial —** `deploy/cloud-run/audio-api.service.yaml`、Scheduler recovery job、production Environment承認を必須とするdigest固定Hosted release workflow、停止/復旧とIAM/Secret設定を追加。Cloud Tasksは既定disabled。Storage分離・既存bytea jobの安全な移行は未実装であり、Free容量適合/費用/実クラウド接続・Docker/SCNet統合は未確認。Hosted/GCP/共有DB変更なし。公開NO-GO。詳細は[Step 7k-51 readiness](docs/reports/2026-11-05-step7k-51-cloud-release-readiness.md)。

---

# HISTORICAL — Step 7k-50e：Cloud Tasks配送・Cloud Run Worker

**Status: partial / production disabled.** Job-ID-only Cloud Tasks adapter、transactional dispatch outbox migration案、重複配送/attempt fencingと接続する専用OIDC HTTP Worker、reconcile wake endpoint、Cloud Run Worker templateを実装。Cloud Tasksは明示flagなしでは起動できず、template/env例もdisabled。対象Go packages test/race/vet、build、diff check PASS。補完検証で隔離PostgreSQL 17.11に042/050b/050d/050eを適用しPASS。50e専用dispatch SQL、既存queue/quota回帰、sentinel保持をrollback検証。初回検証で見つけたPL/pgSQL曖昧参照3箇所を修正後、fresh DBで再PASS。Hosted/GCP/共有DB/deployなし。Scheduler/Cloud IAM/real SCNet 2並列/費用は未検証。Hosted Supabase Freeの現行DB予算内に既存bytea queue/resultsが収まるか未証明。詳細：[Step 7k-50e報告](docs/reports/2026-11-05-step7k-50e-cloudtasks-worker.md)。

---

# HISTORICAL — Step 7k-50d：永続ジョブのquota冪等性・復旧・SCNet並列検証

**Status: partial.** 050d forward migrationでjob/attemptにquota ledgerを結び、1 job = 1 reservationを実装。started failure/retryもstarted_atを保持しquotaを1回消費、開始前キャンセルは未消費。attempt-fenced reserve/start/settle/finish/requeue/claimでstale Workerを拒否し、lease expiry時に再claim/終端化。古いattemptでの二重完了、settle後/finish前クラッシュ、kill switch、pre-start cancel、ACL、データ保全を隔離PostgreSQLで検証。Go関連packages race/vet PASS。実SCNet 2並列はDocker hostで空きRAM約3.0–3.2GiB、swapほぼ満杯のため実行を見送り、負荷を掛けず未確認とした。Hosted/共有DB/GCPは未接続。[Step 7k-50d報告](docs/reports/2026-11-05-step7k-50d-queue-recovery-parallel-benchmark.md)。

---

# HISTORICAL — Step 7k-50c：SCNet永続キュー・Hosted Supabase/CI-CD

**Status: partial / not production-ready.** Additive job migration、owner/idempotency/queue lifecycle RPC、Go async API + DB polling worker、既存同期解析/Reserve-Start-Settle再利用、React polling/cancel/reload復元、CI candidate/preflight workflowを実装。完全隔離PostgreSQLでmigration前後のAuth/entitlement/usage/control sentinel保持、queue cap・2 claim/3件目待機・owner拒否・cancel・lease再claim・quota検証を実施。Go全race suite（loopback許可）、Frontend全192 tests/typecheck/lint/build成功。Cloud Tasks/OIDC/outboxと専用Cloud Run workerは未実装でHosted asyncはfail-closed。実SCNetを2並列で測定しておらず性能・¥1,000/月未確認。Hosted/GCP/共有DB/push/deployは未実施。詳細：[Step 7k-50c報告](docs/reports/2026-11-05-step7k-50c-durable-queue-hosted-cicd.md)。

---

# HISTORICAL — Step 7k-50b：SCNet並列化・解析ジョブキュー

Step 7k-50cで当時未実装だった項目を実装・隔離検証。50b時点の記録：[Step 7k-50b報告](docs/reports/2026-11-05-step7k-50b-audio-analysis-job-queue.md)。

---

# CURRENT_TASK — Step 7k-50：マルチユーザー・同時実行安全性の検証

**Status: partial —** local実装と過去の実DB/SCNet証拠を根拠に単一解析枠の安全性を評価。異なるsubjectを連続送信する際のReserve identityとrequest専用入力/output path分離をGo race testとして追加。Go race tests（audioanalysis/authn/audiobudget）とFrontend auth/API tests 23件成功。Step 7k-46/47でisolated PostgreSQL atomic quota race/lease recovery/RLS・実local JWT/SCNet user isolation・429/cancel/SIGTERM/cleanupは既に検証済み。今回DB/Auth/Hosted/GCP/Cloud Runは未変更。SCNet同時推論上限1を維持。Hosted auth/origin/quota/canaryとCloud実測がないため公開NO-GO。詳細：[Step 7k-50報告](docs/reports/2026-11-05-step7k-50-multi-user-concurrency-safety.md)。

---

# CURRENT_TASK — Step 7k-49：環境プロファイル・起動スクリプト・運用マニュアル整備

**Status: partial — WSL2の3プロファイル・起動/停止/Health経路と運用ガイドを実装・検証。** Development 5173/8080、Test 5174/8081（Test portは変更可）、Production config-only checkを追加。優先順位はprocess env > ignored profile > API/Frontend dotenv。API local startupは全process envを尊重。remote Supabase/DSN、非loopback bind、proxy不整合、占有/検査不能port、Production startをfail-closed。起動PID/PGIDをfingerprintし今回launcherが起動したサービスだけ停止。実際に両profileを起動してAPI/Vite HTTP 200、stop後listenerなしを確認。Local Supabase Auth health HTTP 200、DB変更なし。Shell/profile tests PASS、Frontend 191 tests/typecheck/lint/build PASS、Go全9 packages PASS（通常sandboxではIPv6 test bind拒否、loopback許可で完走）。TestのDB/Auth/StorageはDevelopmentと共有され、独立Test Supabase/entitlement provisioningなし。Production hosted origins/signing/secrets未設定。Windows cmd.exeからbatch dispatchを実行しProduction checkは想定placeholderで拒否、Development checkは5173 unowned listenerを検出してfail-closed。Windows経由のstart/stop受け入れは未完のためpartial。詳細：[Step 7k-49報告](docs/reports/2026-11-05-step7k-49-environment-profiles.md)。

---

# CURRENT_TASK — Step 7k-48：レスポンシブUI・編集導線改善

**Status: partial — 実装とFrontend自動検証完了、実ブラウザ表示確認待ち。** 1100px以下でPreview→Timeline→音源→範囲→Effectの順に配置し、スマートフォンでは制作手順ナビを隠して指定の4領域を先頭に表示。音源・範囲・Effectをネイティブdetailsアコーディオン化し、閉じてもReact component/control状態を保持する。項番を画面順の1〜5に統一。矩形/多角形選択、解析、Timeline、Effect/色編集コードの機能変更なし。Frontend全15 files/191 tests、typecheck、lint、build成功。実ブラウザ・Playwright・Chromiumが環境になく、境界幅/実操作/横スクロールの実画面確認は未実施。詳細：[Step 7k-48報告](docs/reports/2026-11-04-step7k-48-responsive-visual-editor.md)。

---

# CURRENT_TASK — Step 7k-47：ブラウザECONNRESET原因・修正・受け入れ

**Status: completed — 修正後のWindowsブラウザ60秒解析、Timeline反映、Effect適用・再生/seek同期が成功し、DB/プロセス/secret cleanupも完了。** 118.05秒音源の0–60秒multipart（10,584,359 bytes）はHTTP 200。Vite/Go相関ログとDBの唯一のusage `succeeded` が一致しactive leaseなし。最初のCORS early 403と、そのproxyReq後Origin削除による`ERR_HTTP_HEADERS_SENT`の2原因を特定し、Origin除去をVite proxy前middlewareへ移動。Frontend回帰2件/typecheck成功、修正後Vite結合POSTは401でGo auth handler到達。Guard付きcleanupはtest usage 1件とEntitlement 1件のみ削除、既存Auth user 1件を保持、controlをdisabled/all limits 0/lease900へ復元。Migration019、role属性/membership、7/7 DB invariant確認。8081/5174のみ停止、8080/5173未操作。mode600の一時DSN/password/logsを削除し、既存バックアップ未変更。**Browser cancellationは未検証。** 詳細：[Step 7k-47報告](docs/reports/2026-11-04-step7k-47-local-supabase-audio-analysis-integration.md) Sections 18–20.
**Historical note:** 10:49 UTCの28P01と未実施記録は、追加許可前の状態です。11:21 UTCに認証情報を再発行して受け入れを実施し、Section 9方針のcleanupを完了しました。
**Incident investigation (read-only):** Browserでは502または5分超Pending。現在のDBにはusage 0、active leaseなし。API/Viteは稼働しPython子なし、APIログはpipeのみで過去request eventを取得できず。502はGoではPython非zero exitまたはinvalid outputとして返す実装、Vite upstream 502も排除できない。5分はGoの600秒deadline未満で、SCNet 60秒は20秒chunk/50% overlapのCPU処理、UIにclient timeout/進捗応答なし。OOMは未確認。原因未確定、追加解析/DB/code変更なし。最小の次観測（Network `error.code`、safe API log、ledger before/after、Python exit/signal）と修正判断手順はStep 7k-47報告Section 10。
**Startup failure follow-up:** Safe `.env`/pgx comparison confirms target parsing succeeds, but WSL Pg Ping returns `28P01`; decoded password differs from the previously verified DSN. PostgreSQL HBA shows container-local socket/127.0.0.1 trust/peer but Docker-bridge `172.16.0.0/12` SCRAM-SHA-256; logs show 11 SCRAM failures, latest HBA line 92. The claimed container-internal psql success therefore did not validate the password. `run-local.sh` preserves explicit `API_ADDR`/DSN overrides. The 8081 API is healthy using the previously verified secret. No DB/auth/.env/HBA change or analysis request. The `.env` DSN still requires operator correction or valid process override. Report Section 12 records the read-only evidence.

# CURRENT_TASK — Step 7k-46：Supabase手順書・隔離DB復元検証

**Status: completed —** 既存Supabase DB・volume・networkをread-onlyで再確認し、backup size/hash一致とarchive TOCを確認。専用internal network/volume/container（PG17.11、no host ports）へrestore成功。Migration 019 apply/history、`arvc_audio_analysis` LOGIN/TCP接続、RLS/ACL/RPC invariant 7/7、Go `NewPostgres` ping/default-deny、entitlement/quota/kill switch/burst/settlement/lease/retention、独立2 connection競合を実DB検証。fixture削除後usage 0/default-deny、既存DBは018のまま。詳細：[Step 7k-46報告](docs/reports/2026-11-04-step7k-46-supabase-setup-migration.md)。未確認：CLI migration statements metadata（direct SQL applyでNULL）、Hosted/HTTP実JWT全経路。

# CURRENT_TASK — Step 7k-45：ローカル実環境統合検証・Hosted移行判定

**Status: partial / Hosted移行・一般公開NO-GO。** `go vet ./...`、audioanalysis/audiobudget/authn/cmd-server race tests、serviceのCORS/auth focused testsは成功。`go test -count=1 ./...`は既存service testの`httptest.NewServer` IPv6 loopback bindがsandboxで`operation not permitted`となり未完。API binary buildは成功したが、独立loopback listenerも同じOS socket制約で起動できず、health/SIGTERM実測は未確認。Step 7k-44の2秒WAV→SCNet standard/Timeline v1/fake reservation/temp cleanup成功を再利用。DB target・migration適用状態・roles/ACL/RLS・backup/restoreはread-onlyでは特定不能。Docker/DB/Hosted/GCP操作なし。実DB、通常WSL2の全Go suite/API signal、Hosted signing key/plan/origin/quota/cost、multi-user/tab検証が残る。詳細：[Step 7k-45報告](docs/reports/2026-11-04-step7k-45-local-runtime-integration.md)。

---

# CURRENT_TASK — Step 7k-44：ローカル統合検証・公開前Readiness評価

**Status: partial（自動回帰とhandler→実SCNet統合完了、実DB/API-process integration一部未確認） / 公開NO-GO。** Frontend 188 tests/typecheck/lint/build、Go focused/race・CORS/auth tests、`go vet ./...`、`git diff --check`成功。Go全suiteは既存service httptest IPv6 bind sandbox制限で未完。検証済みcheckpointをread-only確認し、2秒WAVのPython Island / SCNet standard実解析がHTTP 200、Timeline v1、fake reservation started/succeeded、temp cleanupを確認。最初の502はcheckpoint不在によるものと特定し、その後正常化。ローカルAPI binary SIGTERM試験はsandboxがIPv4 socketを拒否し起動前に停止。Migration 019は既存012/016のschema/roleに続くadditive順、static invariant成功。DB未接続・未適用・restore/権限未確認、Docker/Hosted/GCP操作なし。Hosted key/plan/origin/quota/費用未確定、二user/複数tab E2E未確認。詳細：[Step 7k-44 Readiness報告](docs/reports/2026-11-04-step7k-44-local-integration-readiness.md)。

---

# CURRENT_TASK — Step 7k-43：SIGTERM・Python Island終了処理と一時ファイルcleanup

**Status: completed（ローカル実装・自動検証） / 公開NO-GOを維持。** SIGTERM/SIGINT root contextからrequest contextへキャンセル伝播し、HTTP受付停止と8秒上限Graceful Shutdownを実装。ffprobe/Pythonをprocess group起動し、cancel時TERM→500ms後残存group KILL。direct child wait/reapとgroup killを待ってから既存request temp directoryを削除。開始前reservation release、SCNet後canceled settlement（最大3秒）、DB lease recoveryとStep 7k-42 lifecycleを維持。`go test`/race対象package、`go vet ./...`、`git diff --check`成功。`go test ./...`は既存service httptest IPv6 bind sandbox制限で完走せず。テストprocessでのsignal受信以外の実アプリ/Docker/Cloud Run動作は未確認。依存・API contract・quota schema変更なし。詳細：[Step 7k-43報告](docs/reports/2026-11-04-step7k-43-sigterm-shutdown-cleanup.md)。

---

# CURRENT_TASK — Step 7k-42：Audio Analyze専用利用制御

追加検証：Frontend test 14 files / 188 tests、typecheck、lint、buildは成功（Frontend実装変更なし）。

**Status: completed（ローカル実装・mock/静的検証） / 公開NO-GOを維持。** 新規`api/internal/audiobudget`で専用Postgres Reserve/Start/Release/Settle clientを実装。JWT subject確認後bodyを読む前にquota reservationし、multipart/WAV検証後SCNet直前にcharged transition、終了結果をsettle。Pre-start拒否はrelease、started attempt/cancel/timeout/failureはcharge。process-local slot/cancel/temp cleanup維持。Additive Migration 019はdefault disabled・quota 0、service/user daily/monthly limits、user/global concurrency、burst、kill switch、lease recovery、lazy 90日retention。専用`arvc_audio_analysis` roleは4つのprivate固定search_path RPCのみEXECUTE。Go package/handler/server testsとSQL source invariants成功、`go vet ./...`成功。全`go test ./...`は既存service httptestのsandbox IPv6 loopback bind制限で完走せず。Migration未適用、role credential/DB settingなし、実DB atomic concurrency/RLS検証なし。GCP/Hosted/Docker、本番操作なし。AI budget/SCNet/Timeline v1/Blueprint v1/Effects不変、依存追加なし。詳細：[Step 7k-42報告](docs/reports/2026-11-04-step7k-42-audio-analysis-quota.md)。

---

# CURRENT_TASK — Step 7k-41：Hosted Supabase JWT・Frontend公開経路対応

**Status: completed（ローカル実装・自動検証） / 公開NO-GOを維持。** Go JWT validatorへ明示的local/hosted trust modeを追加し、Hosted canonical Supabase HTTPS issuer/JWKS、redirect拒否、JWKS refresh失敗時fail-closedを実装。既存ES256/issuer/audience/exp/role/UUID subject検証と従来のloopback任意port互換を維持。Frontend Hosted HTTPS Authと共通`VITE_API_BASE_URL` helperを追加し、Audio Analyze / Cloud API / Blueprint Generateのroutingを統一。Bearer token、AbortSignal、Vite相対`/api` proxyを維持。Go CORSへHTTPS exact-origin allowlist、不許可・複数Origin header拒否を追加。Frontend 188 tests、typecheck/lint/build、Go focused tests、`go vet ./...`成功。Go全test suiteは既存service httptestのsandbox IPv6 loopback bind拒否で完走せず。Hosted実接続・実ブラウザ・CORSは未確認。quota/migration/SIGTERM、GCP/Hosted/Docker操作なし。Timeline v1 / Blueprint v1 / SCNet / Effects不変。詳細：[Step 7k-41報告](docs/reports/2026-11-04-step7k-41-hosted-auth-frontend-public-route.md)。

---

# CURRENT_TASK — Step 7k-40：Cloud Run公開ブロッカーの解消設計

**Status: completed（read-only調査・実装設計） / 実装・デプロイ未完了。** Hosted Supabase JWT、Frontend HTTPS/API経路+CORS、Audio Analyze quota、Hosted DB/Storage、SIGTERM/child cleanupの現状・変更対象・回帰/異常テスト・工程依存・L3権限境界を調査。限定検証では招待利用者のSCNet解析とbrowser-local Editorに絞り、Project/Asset/AI/Demucsを公開経路に含めない提案。認証の署名/claims、RLS/private Storage、request cancellationは既存保護を維持する設計。Audio quotaはAI token budgetと別のatomic user/service counter/kill switchが必要。Go signal handlingは未実装。コード・migrations・Hosted・GCPは変更せず、Cloud公開NO-GOを維持。詳細：[Step 7k-40設計報告](docs/reports/2026-11-03-step7k-40-public-readiness-remediation-plan.md)。

---

# CURRENT_TASK — Step 7k-39：Cloud Runデプロイ準備・公開前検証

**Status: completed（read-only readiness調査） / 公開NO-GO。** Cloud Run candidateのPORT、resource、request/upload、timeout、checkpoint/image、Hosted Supabase JWT/JWKS、Frontend origin/CORS、abuse防御、費用、IAM/registry、shutdown/rollbackを既存実装・公式資料から調査。現行Go validatorはloopback HTTP issuer限定のためHosted Supabaseと非互換。production FrontendのHosted Auth/API routingとCORS、利用者別/全体Audio Analyze quota、Hosted DB/Storage権限、SIGTERM shutdown、Cloud上の性能・costは未解決。ローカル実測値をCloud実測として扱わず、費用は公式request-based rates/free tierを用いた試算。GCP、Hosted Supabase、Docker、ソース実装・依存は変更なし。調査完了はdeploy/public readinessを意味しない。詳細：[Step 7k-39報告](docs/reports/2026-11-03-step7k-39-cloud-run-predeployment-readiness.md)。

---

# CURRENT_TASK — Step 7k-38：React Visual EditorへのSCNet統合

**Status: completed —** 既存 `/app` によるログイン済みSupabase session、ブラウザ音源crop、JWT付きAudio Analyze、Timeline反映、Blueprint/Effects、音源Preview同期、AbortControllerキャンセルを通常ローカルブラウザでユーザー確認済み。SCNet標準モデルで解析成功。Vite `/api` proxyへloopback限定の`ARVC_API_PROXY_TARGET`を追加し、Step37d API port 18084へ接続可能。SCNet 60秒Summary/Timeline伝播、401 session expiry、AbortSignalのFrontend test追加。Frontend 13 files / 179 tests、typecheck、lint、build成功。通常開発・実行の標準エンジンはSCNet standard、Demucsは擬似教師データ生成と性能比較用に限定。Cloud Runでは未検証。詳細：[Step 7k-38報告](docs/reports/2026-11-03-step7k-38-scnet-visual-editor-integration.md)。

---

# CURRENT_TASK — Step 7k-37d：Docker bridge認証付きSCNet統合検証

**Status: completed —** 通常WSL2の実測報告に基づき、既存JWTによるSCNet 60秒解析2回成功（62.49s / 57.43s）、Timeline v1・各連続系列6,000点・NaN/Infなしを確認。Peak Memory 1,847,947,264 bytes、2 vCPU / 4 GiB、OOMなし。キャンセル時はPython Island PID 1805267（入力 `/tmp/arvc-audio-analysis-4225982304/clip.wav`）を確認し、curl exit 28後に解析プロセスと一時ディレクトリが消失。Go API/Auth中継は稼働継続、health HTTP 200、検証スクリプトPASS。値はユーザーからのWSL2実測報告であり、Cloud Run測定ではない。JWT、認証、API、Dockerfileは変更せず、既存コンテナも停止・削除していない。詳細：[Step 7k-37d報告](docs/reports/2026-11-02-step7k-37d-bridge-auth-scnet-validation.md)。

---

# CURRENT_TASK — Step 7k-37d：Docker bridge認証付きSCNet統合検証

**Status: partial — Docker daemonへ接続できず実測待ち。** `docker ps`は`/var/run/docker.sock` permission denied。権限変更、sudo、コンテナ/Supabase操作、credential参照は行っていない。既存のGo JWT validatorが要求するissuer `http://127.0.0.1:54321/auth/v1`と導出JWKS URLを維持するため、検証用step37eのnetwork namespace内loopbackに限定したPython TCP中継スクリプトとWSL2手順を用意。bridge、JWKS、JWT、60秒推論、cgroup計測、キャンセルはすべて未実測。詳細：[Step 7k-37d報告](docs/reports/2026-11-02-step7k-37d-bridge-auth-scnet-validation.md)。

---

# CURRENT_TASK — Step 7k-37c：SCNet Docker実推論・リソース検証

**Status: partial — awaiting the normal WSL2 Docker execution.** This workspace cannot access `/var/run/docker.sock`, so read-only inspection of `arvc-scnet:step37` / `arvc-scnet-step37` failed before any container change. No existing container, Supabase service, Docker settings, credentials, or files were modified/read. Host checkpoint tests (5 passed) and Go timeout/cancel/auth rejection/temp-cleanup tests passed. Added WSL2 command sequence for read-only inspection, a generated deterministic 60s fixture, an isolated host-network test container (preserving the loopback Auth issuer and API auth), 401/valid JWT cases, response validation, cgroup/stats sampling, cancel, and stop/exit inspection. Actual Docker/JWT/audio/resource results are pending; 2vCPU/4GiB fit is not established. Detailed commands/results: [Step 7k-37c report](docs/reports/2026-11-02-step7k-37c-scnet-docker-runtime-validation.md).

**Network finding:** Docker Desktop host networking provides the host-side localhost path, but WSL2 NAT has a separate Linux loopback. Recommended no-config route is to keep host networking and the API bound to 127.0.0.1, then invoke Windows `curl.exe` from WSL. Bridge + port mapping alone cannot preserve current JWT/JWKS because the loopback issuer and key URL are coupled. Official Docker/Microsoft sources and read-only checks are in [network investigation](docs/reports/2026-11-02-step7k-37c-docker-desktop-network-investigation.md). This is a route recommendation; no real JWT request was run.

---

# CURRENT_TASK — Step 7k-37a：SCNet checkpointビルド方式の修正

**Status: partial —** 500KiB上限を超えるcheckpoint転送をBuildKit secretからNamed Build Contextへ変更。Dockerfileは`--mount=type=bind,from=scnet_weights,...,ro`で別コンテキストをread-only mountし、42,434,545 bytesとSHA-256を検証後にのみmode 0444で配置する。通常build contextの`.dockerignore`除外とGit ignoreを確認し、hash/sizeを再検証。Cloud Run配布時のimage/BuildKit cacheアクセス制御をガイド・報告へ追記。Docker Buildxを試したが、この実行環境から`/var/run/docker.sock`へpermission deniedのため、build成功とStep37 runtime計測は未完。Python/Go/Frontendソース変更なし、cache削除・push/deployなし。詳細：[Step 7k-37a報告](docs/reports/2026-11-02-step7k-37a-scnet-checkpoint-build-context.md)。

---

# CURRENT_TASK — Step 7k-37：SCNet対応Cloud Runコンテナ構築・ローカル検証

**Status: partial —** Go/Python単一コンテナ用Dockerfile、Named Build Contextによるcheckpoint固定検証/配置（37a修正）、non-root実行、CPU-only Python、ffmpeg/ffprobe、`PORT` bind、2-thread設定、Docker build context除外とローカル手順を追加。Go→Python既存統合テストで合成60秒音源からHTTP 200・Timeline 6,000点を確認（host計測約40秒。Docker測定ではない）。Python 76 tests、対象Go tests/vet、mypy、変更対象Ruff、offline lock、diff-check成功。Docker CLI/BuildxはあるがDocker socket permission deniedでビルド・起動不可。コンテナimage size/RSS/CPU/health/stopは未測定。全Go suiteはsandbox localhost bind拒否でservice packageが失敗、対象server/audioanalysis testsは成功。GCP操作なし。詳細：[Step 7k-37報告](docs/reports/2026-11-02-step7k-37-scnet-cloud-run-container.md)。

---

# CURRENT_TASK — Step 7k-36：SCNet本格移行・Demucs開発用分離

**Status: completed —** Python Islandの標準separatorをSCNet standardへ移行。公式SCNet commit/config/checkpointを固定し、checkpoint size/SHA-256、`weights_only=True`、strict state loadを検証してCPU上で4 Stemを生成。Demucs本体は保持し、base runtime依存から外して任意の`demucs-dev` extraと明示CLI経路に限定。既存Feature ExtractorとTimeline v1を維持し、GoのJSON shapeも不変。60秒demo4入力で4 stem・Timeline生成を実行。Python Island 76 tests、PoC 12 tests、mypy、変更対象Ruff、compileall、lock、Go tests/vet、diff-check成功。全Ruffには既存E501 14件。Cloud Run実測・デプロイは未実施。詳細：[Step 7k-36報告](docs/reports/2026-11-02-step7k-36-scnet-production-integration.md)。

---

# CURRENT_TASK — Step 7k-35：SCNet採用判断に必要な最小追加検証

**Status: partial —** 同一ホスト・CPU・入力・2 threadsでDemucs/SCNetを各3プロセス測定。warm推論中央値52.18s / 47.95s、Peak RSS 2,149 / 1,418MiBで、この条件ではSCNetに速度・メモリ上の利点なし（隔離依存関係とchunk設定差あり）。PoC CSVを全Gate×イベント・5系列の28行に修正し、JSON整合性・欠落/異常ケースを回帰テスト化。既存Renderer command比較とdemo3低音量区間の調査を実施。demo4のtarget annotation interval未完了、Snare正解ラベルなし、実ブラウザ評価なしのため精度・視覚評価は未完了。技術採用は判定保留、本番Demucs維持。PoC 12 tests / Python Island 76 tests / mypy / Ruff / py_compile / diff-check成功。詳細：`docs/reports/2026-11-02-step7k-35-scnet-adoption-validation.md`。

---

# CURRENT_TASK — Step 7k-33d：SCNet公式checkpointによる実測評価

**Status: partial —** 公式Google Drive再取得と同一と確認されたcheckpointの実SHA-256/sizeを再検証し、PoC pinを`f8aff3bc…` / 42,434,545 bytesへ更新。PyTorch `weights_only=True`によるsafe loadと、公式configに対する372 tensor entriesのstrict state loadをPyTorch 2.14.1 CPUで確認。PoC 7 tests、Python Island 64 tests、mypy、PoC Ruff、py_compile、CLI help、diff-check成功。Python 3.12専用環境の依存取得はcache不足・DNS失敗で未完。SCNet推論・Demucs特徴量比較・性能計測は未実施。実用性は判定保留。本番Demucs維持。詳細：`docs/reports/2026-11-02-step7k-33d-scnet-measured-comparison.md`。

# CURRENT_TASK — Step 7k-33c：SCNet実測比較・実用性判定

**Status: partial —** 公式SCNet checkoutはoriginとcommit `5d95bf96b19c3eede63248d171efeca8e3abb948`に一致。checkpoint実ファイルは42,434,545 bytes / SHA-256 `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`で、PoC期待値42,434,986 bytes / `1bc0d1…`と不一致。第三者の標準checkpoint記録との同一性・取得元を確認できず、検証を維持して推論は未実施。PoC 7 tests、Python Island 64 tests、mypy成功。Ruff全体で既存E501 14件、今回のPoC違反0件。DNS制約で隔離依存の取得不可。Demucs比較、性能測定、実用性は判定保留。本番移行は推奨しない。詳細：`docs/reports/2026-11-02-step7k-33c-scnet-measured-evaluation.md`。

# CURRENT_TASK — Step 7k-30：WebM / MP4動画書き出し対応

**Status: partial —** 既存Canvas capture / `renderEditorFrame` / AudioContext同期を共有するWebM・MP4出力を実装。MP4は無音H.264、音声付きH.264/AAC LCを`isTypeSupported()`で個別判定し、Recorder MIMEとBlobの`ftyp`を検証後に`.mp4`保存。未対応時は選択/書き出しを無効化し、WebMへ暗黙fallbackしない。Frontend全テスト・typecheck/lint/build・diff-check成功。ブラウザがなくMP4実生成・再生・ffprobeと実codec対応は未確認。詳細：`docs/reports/2026-11-02-step7k-30-webm-mp4-export.md`。

---

# CURRENT_TASK — Step 7k-28：Audio Analyze失敗調査

**Status: partial —** 43.14–103.14秒の60秒WAV相当データを確認し、44.1kHz stereo PCM16 / 2,646,000 frames / 10,584,044 bytesを回帰テスト化。demo4音源のFFmpeg cropはffprobe適合・非無音。Go→Python 60秒FixtureはHTTP 200、6,000 Timeline points。Gate Mode Off/Soft/Middle/Hardの送信・伝播、Frontend 166 tests、typecheck/lint/build、Go audioanalysis tests/vet、diff-check成功。HTTP 422の誤解を招く音量文言を修正。Windows ChromeのrequestログとAPI process確認不可のため根本原因は未確定。Gate Mode追加前のGo processがmultipart fieldを拒否した可能性は仮説。詳細：`docs/reports/2026-11-02-step7k-28-audio-analysis-failure.md`。

---

# CURRENT_TASK — Step 7k-27：Particle BurstのDemo比較・原因特定・最小修正

**Status: partial —** Demo1 TimelineのKick Strength（min 0.251 / median 1.0）と既存demo4 acoustic-stem Timeline（Hard min 0.0433 / median 0.0992）を比較。Renderer再現で同じcount 32のBurstが一般Binding 0.9/0.1ではDemo値で30 draw commands、Strength 0.05246で0件。生成されたKick-bound Particle BurstのみBindingをStrength 1 / Threshold 0へ適用し、同じ弱イベントで12 commands（opacity >0.08）を確認。Attack/Release、Effect固有値、保存済みProject、Timeline、API、Renderer式は不変。Frontend 164 tests、typecheck/lint/build、diff-check成功。Windows Chromeでの修正後見た目と実ユーザーBlueprintの設定は未確認。詳細：`docs/reports/2026-11-02-step7k-27-particle-burst-regression.md`。

---

# CURRENT_TASK — Step 7k-26：Kick検出・Binding反応の調査と既存パラメータ調整

**Status: partial —** BindingでStrength ≤ thresholdが0になり、解析後の既定BlueprintはSong sourceでKickイベントを参照しないことを確認。demo4のStrength閾値別件数をGateごとに測定し、新規Kick BindingのみThreshold 0 / Strength 1 / Attack 0msへ調整。既存保存Binding、Timeline、Kick detectorは不変。Frontend 163 tests、Python 65 tests、Go audioanalysis tests/vet、typecheck/lint/build、mypy/Ruff成功。実ブラウザと正解ラベルによる効果は未確認。詳細：`docs/reports/2026-11-02-step7k-26-kick-response-investigation.md`。

---

# CURRENT_TASK — Step 7k-25a：Kick Detection Gate Mode UI配置

**Status: partial —** Step 7k-25の4モードを実装し、Gate Mode選択UIを「4・エフェクト」内の共通カラー下・Effect一覧上へ配置しました。状態はEffect個別でなくEditor全体に保持され、Effect追加・削除・種類変更で変わりません。変更は次回Audio Analyzeにだけ適用し、既存Timelineは再解析しません。Python 65 tests、Frontend 161 tests、Go audioanalysis tests、mypy/Ruff、typecheck/lint/build、go vet、git diff --check成功。demo4 189.960秒drums stem：Off 994、Soft 647、Middle 395、Hard 138 events。Hard時刻は既存Timelineと完全一致。正解ラベルによる検出精度は未評価。実Windows Chrome UI確認未実施のためpartial。詳細：`docs/reports/2026-11-02-step7k-25-kick-gate-modes.md`。

# Step 7k-25 — Kick Detection Gate Mode

Gate values: Soft `(score p85×0.08 / floor 0.035, low p65×0.04, sub/body 0.40, decay 0.90)`; Middle `(0.13 / 0.055, 0.08, 0.55, 0.70)`; Hard retains legacy `(0.18 / 0.08, 0.12, 0.70, 0.50)`; Off disables these acceptance gates while retaining nonzero score, local maximum and 120ms merge. API multipart `kickGateMode` is optional and defaults to Hard. Timeline v1 fields remain unchanged.
# Step 7k-24a：Kick注釈UIの音声配信エラー修正・候補試聴・ドラッグSeek

**Status: partial — 音声Range配信を小分けstreaming化し、想定されるブラウザ切断時のConnectionResetError/BrokenPipeError tracebackを抑制。候補単位試聴、候補行ラベル操作、playhead drag seekを追加。Python 58 tests、Node UI helper 9 tests、mypy、Ruff、JS syntax、git diff --check成功。sandboxではloopback bind不可、Chromeなしのため実HTTP・実ブラウザ操作は未確認。詳細は`docs/reports/2026-11-02-step7k-24a-annotation-ui-fixes.md`。

# Step 7k-24：Acoustic Kick Annotation & Evaluation

**Status: partial — ローカル注釈UIと完了区間評価を実装し、自動検証完了。** 注釈UIはloopback専用HTTPサーバー、音源/候補/TimelineのSHA-256照合、drums stem波形・2,925候補のレビュー、Kick/negative label、評価区間、JSON保存・再開で構成。Step 7k-22既存manifest経路は維持し、別CLI modeで全音源検出からcomplete区間のみ採点する。Python 48 tests、mypy、対象Ruff、JS syntax check成功。sandboxのloopback bind拒否でHTTP起動・実ブラウザ操作・人手聴取は未確認。確定ラベルなし、精度値なし。詳細：`docs/reports/2026-11-02-step7k-24-kick-annotation-tool.md`。

---

# Step 7k-23：Acoustic Drum Kick Evaluation Dataset

**Status: partial — 対象音源を分離し、未確認のKick候補・ゲート診断データをローカル作成。** Windows/聴取確認できず、全候補はunverified。評価CLIへ未確認イベントをtruth labelsとして渡しておらず、Precision/Recall/F1は未算出。音源ライセンスもunknown。Stemは4本とも44.1kHz stereo PCM16、189.960秒で正常。既存解析ロジック/API不変。詳細：`docs/reports/2026-11-02-step7k-23-acoustic-drum-dataset.md`。

---

# Step 7k-22 — アコースティックKick検出精度の定量評価

**Status: partial — ローカル評価CLI・Synthetic回帰検証を追加。アコースティック正解ラベル付き音源がなく、実音源の数値評価は未実施。** 検出器、Timeline/API契約は変更なし。Python 40 tests、Frontend 160 tests、Python source mypy、Frontend typecheck/lint/build、git diff --check成功。全Python Ruffには既存E501 findings、strict mypy testsには既存annotation/TypedDict findingsが残る。詳細：`docs/reports/2026-11-02-step7k-22-kick-quantitative-evaluation.md`。

---

# CURRENT_TASK — Step 7k-20：デフォルトEffect構成の変更

**Status: partial — 新規Editor向け既定値を追加し、自動検証完了。実ブラウザ表示は未確認。** 新規Editorと音声解析完了後だけに周波数バー→インク拡散を適用。既存デモ/Fixture用Blueprint、Project読込、生成API応答は維持。Frontend 159 tests、typecheck、lint、build、git diff --check成功。詳細は`docs/reports/2026-11-02-step7k-20-default-effects.md`。

---

# CURRENT_TASK — Step 7k-18：円形Effectの描画補正・UI文言最適化

**Status: partial — 円形Effectのピクセル幾何補正と表示文言見直しを実装し、自動検証は完了。実ブラウザでの画素受け入れは未確認。** Stage/Regionの幅・高さを個別に半径へ掛けていたため円が楕円化していた。対象の円・放射型EffectをRegionのStage pixel短辺基準へ修正し、Region clipとPreview/WebM共通Rendererを維持。Frontend 158 tests、typecheck、lint、build、git diff --check成功。詳細は`docs/reports/2026-11-02-step7k-18-circular-effects-and-ui-copy.md`。

---

# CURRENT_TASK — Step 7k-19：Cloud Project UIの一時非表示と再有効化メモ整備

**Status: partial — 実装・自動検証完了、実ブラウザ表示確認は未実施。** Cloud Project UIと一覧自動取得を止め、音声解析・AI生成に使う認証欄は維持。Cloud API/UI実装・テスト・DB契約は保持。Frontend 158 tests、typecheck、lint、build、git diff --check成功。再有効化手順を`docs/CLOUD_PROJECT_REACTIVATION.md`へ記録。詳細は`docs/reports/2026-11-02-step7k-19-cloud-ui-defer.md`。

---

# CURRENT_TASK — Step 7k-17：音声・解析結果を含むプロジェクト保存と再読み込み

**Status: partial — 実装・自動検証完了、実ブラウザ保存/再読込は未確認。** `.arvproj v1`の任意metadataにMusic Summaryを加法追加し、旧v1/音声なしファイルを維持。Blueprint、Timeline、crop WAV、Summaryを復元し、再解析なしにPreviewとBlueprint再生成を再開可能にした。Maximum call stackの原因は大きなBase64文字列を正規表現で一括検証していたこと。サイズ上限後に文字ごとの線形検査へ変更。Frontend 157 tests、typecheck、lint、build成功。Cloud v1は変更なし。詳細は`docs/reports/2026-11-02-step7k-17-project-audio-persistence.md`。

---

# Step 7k-16e — エフェクト生成UIの重複解消

**Status: partial — 生成操作と制作手順を整理し、自動検証は完了。** 調査でAudio Analyze成功時の自動Blueprint生成は行われず、初期BlueprintをEditorへ読み込んだ後、認証済みの既存生成APIを別操作で呼び出す設計と確認。必要な生成ボタンは解析セクションへ一つに集約し、独立した「3 · エフェクトを生成」セクションを削除。制作手順は5段階に整理。API・保存契約・生成条件は不変。Frontend 154 tests、typecheck、lint、build、git diff --check成功。実ブラウザ未確認。詳細は`docs/reports/2026-11-02-step7k-16e-generation-ui-cleanup.md`。

---

# Step 7k-16d — 範囲選択の秒数スライダー統合

**Status: partial — 波形直下の選択時間スライダー、自動検証は完了。** 開始/終了の2本のスライダーを削除。範囲長を1本で調整し、開始位置を固定して終了位置を更新する。波形操作との双方向同期と再生状態への非干渉を確認。Frontend 154 tests、typecheck、lint、build、git diff --check成功。実ブラウザ未確認。詳細は`docs/reports/2026-11-02-step7k-16d-duration-slider.md`。

---

# Step 7k-16c — 波形直接操作による範囲選択改善

**Status: partial — 波形上の範囲設定・移動・試聴位置操作、自動検証は完了。** 開始/終了スライダーは既定で閉じた詳細調整に配置。新規ドラッグ・端点変更・区間移動を最大60秒/音源durationへ制限。Frontend 152 tests、typecheck、lint、build、git diff --check成功。実ブラウザ操作は未確認。詳細は`docs/reports/2026-11-02-step7k-16c-waveform-direct-range-selection.md`。

---

# Step 7k-16b — 波形付き音声範囲選択モーダル

**Status: partial — 実装・自動検証完了、実ブラウザ受け入れ未確認。** 音源デコード後に波形モーダルを開き、選択範囲の操作・試聴から既存WAV crop/Audio Analyze/Editor反映へ接続した。Frontend 152 tests、typecheck、lint、build、git diff --check成功。詳細は`docs/reports/2026-11-02-step7k-16b-waveform-selection-modal.md`。

---

# CURRENT_TASK — Step 7k-16：Editor UI統合最適化

**Status: partial** — Editorの情報階層と操作導線を調整し、Frontend自動検証は成功。実ブラウザの見た目・操作感は未確認。

- Previewを先に見せる配置を維持し、幅1,100px以下ではPreviewをコントロールより前に配置。アスペクト比は既存のCanvas intrinsic寸法を維持。
- 音源選択 → 範囲・解析 → Blueprint → Edit / Preview → Exportの順序と前提状態を表示。既存の解析・生成・Export条件は変更なし。
- Timelineに再生時間と7 Audio Sourceの利用可能状態を表示。Effect選択/Delete、Region編集モード、Effect位置操作との違いを明確化。
- Effectの基本設定とBindingを見つけやすくし、Advanced accordionは閉状態を維持。
- Frontend tests 146件 / typecheck / lint / build 成功。Blueprint / Timeline / Project / Cloud v1、Renderer / WebM、APIに変更なし。実ブラウザは未確認のためpartial。

詳細：[Step 7k-16報告](docs/reports/2026-11-01-step7k-16-editor-ui-integration.md)。

# Step 7k-16a — UI文言・ボタン視認性

**Status: partial — UI文言の日本語化と自動検証は完了。** 146 Frontend tests、typecheck、lint、build、git diff --checkが成功。22件の失敗は表示文言・ARIAラベルなどの旧期待値に起因し、期待値を現行UIへ更新した。ボタンの通常・hover・active・focus-visible・disabled配色は維持。実ブラウザでの視認性確認は未実施のためpartial。詳細は`docs/reports/2026-11-01-step7k-16a-ui-copy-button-visibility.md`。

**Browser `write ECONNRESET` follow-up（read-only）:** 調査時点で唯一のlocal entitlementは約26分前に失効、usage 0。60秒WAVは10,584,044 bytes（multipart込みでも16MiB未満）。GoはReserveをbody read前に行い、expired entitlementなら403早期返却。未読body >=256KiBではGo HTTP/1が接続をcloseするため、Vite転送中の`write ECONNRESET`を説明する有力経路。ただしrequest-correlated logsはなく特定リクエストの確定原因ではない。Go ReadTimeout 30秒も未排除。解析リクエスト・コード/DB/サービス変更なし。次はentitlement有効確認後、許可された1回の試験でContent-Length/upload時間、Vite timestamp、API safe stage/statusを相関。詳細はStep 7k-47報告Section 13。
