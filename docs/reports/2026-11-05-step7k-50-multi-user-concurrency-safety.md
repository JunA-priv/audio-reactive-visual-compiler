# Step 7k-50 — マルチユーザー・同時実行安全性

実施日：2026-11-05（Asia/Tokyo）  
Status：**partial — ローカルコード/自動テストと既存local Supabase実証により、単一解析枠の範囲を評価。Hosted/Cloud Runは未検証のため公開可能判定はNO-GO。**  
Hosted Supabase / GCP / Cloud Run / migration / DB data：**今回変更なし**

## 要約

- APIはES256 JWTの署名、issuer、`authenticated` audience/role、expiry、UUID subjectを検証し、検証したsubjectをrequest contextにだけ保持する。Audio Analyzeはbodyを読む前にそのsubjectでquota reservationを行う。
- 解析はリクエストごとに0700のtemp directory、0600の入力WAV、専用output directoryとPython Island process groupを持つ。process内slot、DB global/user concurrency、reserve/start/settle、lease recoveryが重なってSCNetの同時実行を1件に制限する。
- Step 7k-47でlocal Supabaseの実JWT・実PostgreSQL quota・API・SCNetを通した同一ユーザー競合、別ユーザー競合、429、成功、cancel、SIGTERM、cleanupを確認済み。Step 7k-46では独立TCP connectionによるreservation raceとlease recovery、RLS/ACLを隔離DBで確認済み。
- 今回、二つの異なるsubjectを続けて同じAPI handlerへ送り、subjectが各Reserveへ分離されること、入力/outputのrequest directoryが共有されないことをGo race testとして追加・実行した。
- これは逐次リクエストのrequest isolationを追加証明する。二つのSCNet推論の同時並列動作は現仕様では許可されず、multi-tab UI実ブラウザ検証・Hosted runtime検証は未実施。

## 実装上の境界と根拠

### JWT/session・ユーザー境界

`api/internal/authn/jwt.go`はES256のみを許可し、issuer/audience/expiry/role/UUID subjectを確認する。Authorization headerは1つだけ受け付け、principalは個別HTTP request contextに保存される。署名/claim不正・未認証は401。JWTや音源はquota ledgerに保存しない。

`frontend/src/auth-client.ts`はsessionを`sessionStorage`へ保存し、tabごとのsession境界とする。期限前refresh、refresh失敗時session clear、sign-out時clearを実装。sessionStorageはブラウザの永続localStorageと異なり同一originの別tab間共有ではない。ただし同一tab内の複数コンポーネントでrefreshを同時呼び出す競合・複数タブ実ブラウザ動作は今回のE2E対象にしていない。

Audio quota migrationのentitlement/control/usage各tableはRLS + FORCE RLS、アプリroleへの直table ACLなし。Dedicated `arvc_audio_analysis` roleは4つの固定search_path SECURITY DEFINER RPCのみ実行可能。Reserve RPCは渡されたverified user IDのentitlement、user/service daily/monthly、user/global concurrency、burstを確認。これはDB role自体にend-user JWTを渡す仕組みではなく、Go APIが検証済みsubjectを適切に渡す信頼境界である。

### SCNet request isolation / lifecycle

`api/internal/audioanalysis/handler.go`は各accepted requestで`os.MkdirTemp`により独立directoryを作成し0700へ設定。WAVを0600で排他的作成し、outputは同directory配下の専用folder。結果はそのpathから読み、request終了時に`RemoveAll`。Python Islandにはrequest固有input/output pathをCLI引数で渡すため、共有ファイル名の衝突なし。子processはprocess groupとして起動し、request cancelでSIGTERM後500msで残存groupをSIGKILL、child wait後にtemp cleanupする。Python stdout/stderrは破棄し、request logに音源/結果/JWTは出さない。

### Quota /同時実行

- Go `Handler.slots`はprocessごとにcapacity 1。slot使用中に到着してhandlerへ届いた別解析は即時429 `analysis_busy`。
- PostgreSQL Reserve/Start RPCはglobal control rowを`FOR UPDATE`してserializeし、global/user quota/concurrencyを再検査。複数API process/instance間でもDB global limitが共有される。DB ReserveとStartの両方で判定する。
- 解析quotaのReservationはpre-SCNet upload/WAV検証中はreserved。Python開始直前のStart成功でrunning/attempt chargeとなり、success/failure/cancelでterminal settle。同じterminal state再試行はidempotent、別terminal state変更は拒否。pre-start失敗はreleaseで課金しない。
- 900秒のdefault lease（許容60–1800秒）を設定。Reserve時に期限切れreservedをrelease、期限切れrunningを`expired_charged`へ回復。API timeoutは600秒。プロセス強制終了時も次ReserveでDB leaseが回復する。
- 予約レース時はDBが一件だけ許可し、他は429となる。process slotでも保護するため、DB状態不整合や複数instanceでも単一process内推論が並列化しない。

## 検証結果

### 今回実施したローカル検証

- 新規`TestAnalyzeKeepsUserAndRequestStateIsolated`：異なるsubjectで2リクエスト、Reserveに渡るuser IDが異なる、入力/output pathおよびparent request directoryが異なる、両レスポンス200を確認。
- `GOCACHE=/tmp/arvc-step7k50-gocache go test -race ./internal/audioanalysis ./internal/authn ./internal/audiobudget`：3 packages PASS。
- Frontend `npm test -- src/auth-client.test.ts src/audio-analysis.test.ts src/api-connection.test.ts`：3 files / 23 tests PASS。
- 新しいDB接続・Authデータ・quota/entitlement変更は行っていない。Step 7k-49に記録されたDevelopment/Test共有DB/Auth/Storageのreadinessを踏まえ、今回の静的/自動検証に実DB書き込み検証は不要と判断した。既存実DB証拠はStep 7k-46/47報告から引用。

### 再利用した既存local実環境実証

- Step 7k-47：実local JWTのmissing/invalid拒否、実entitlement/default-deny、user quota/rate limit/kill switch、SCNet standard + Timeline v1 + succeeded settlement、同一user二重requestと異なるuser競合の429、upload前cancel release、推論cancel settle、SIGTERM時cancel、temp/child cleanup、最後にtest Auth user/entitlement/usage cleanupとcontrol default-deny復元を記録。
- Step 7k-46：隔離restoreしたPG17.11/Migration 019で、独立2 TCP connectionの同時Reserveが`reserved`一件/`concurrency_exceeded`一件、user/global daily/monthly/concurrency、burst、release/settle idempotency、lease recovery、専用role ACL/RLS invariant 7/7を確認。
- これらは今回の実行日に再度実DBで確認した結果ではない。migration/functionを今回変更していないため、そのまま既存証拠として扱う。

## 並列アクセスと公開構成

**複数ユーザーの同時HTTPアクセスは可能だが、解析を同時に2件実行できる設計ではない。** APIが受け取れる解析が1件だけの間は他ユーザー/同一ユーザー別tabはHTTP 429となる。Cloud Run `concurrency=1, max instances=1`ではCloud Run側でも1リクエストしかinstanceへ割当てず、instance上限到達中はCloud Runが最大30秒空きを待ち、枠が空かなければrequest自体が失敗し得る。従って全ケースがアプリの429へ到達する保証はない。[Cloud Run concurrency](https://docs.cloud.google.com/run/docs/about-concurrency) [Cloud Run max instances](https://docs.cloud.google.com/run/docs/configuring/max-instances)

**公開前に必須:** Hosted JWT/JWKS・Frontend/API origin/CORS・signup/invite policy・Hosted DB role/RLS/migration parity・quota/entitlement値・global kill switch/運用手順・Cloud runtime acceptanceを確定し、別の公開前canaryで確認する。local evidenceはHosted証明にならない。serial analysisを保つならCloud candidateは2 vCPU/4 GiB、concurrency 1、max instances 1（他のrevisionを含め実際の上限確認）、API 600秒より長いrequest timeout。複数instanceを許すときもquotaのDB global concurrencyを強制し、requestがplatform queue/rejectかAPI 429かを計測する。

**SCNet推論を並列化する場合に必要:** (1) capacity 1のGo slotを構成可能なbounded semaphoreにする、(2) DBのglobal/user concurrency limitを同意された値へ更新しReserve/Startのatomic lock/claimを維持、(3) Cloud Run concurrencyとmax instancesをinstanceあたり・全体の推論数上限に合わせる、(4)各instanceでの同時SCNetのCPU/RAM/tmp/timeoutを実コンテナ測定しlimit内に余裕を確認、(5) quota/429 UXと負荷/kill switch/cancelを実環境で検証する。**このステップでは上限を変更していない。**

性能根拠：Step 7k-36のWSL2 CPU/2 threads SCNet 60秒入力はPython peak RSS 1,438.1 MiB、separation 55.468秒。Step 7k-37dのローカルDocker 2 vCPU/4 GiB測定はcontainer peak memory 1,847,947,264 bytes、HTTP解析62.49秒/57.43秒、OOMなし。別環境/設定で単純比較不可。2並列のピークメモリ/実時間/CPU throttleは**未測定**で、1.85 GiBを単純に2倍した値も計画値として保証しない。

**費用:** 既存Step 7k-39の概算ではrequest-based 2 vCPU/4 GiB・60秒解析はfree tier考慮前CPU 120 vCPU-s + RAM 240 GiB-s。東京はCloud Run価格表の対象であるが、free tierはbilling account内共有で、Artifact Registry、egress、logging等を含む請求上限ではない。月1,000円以内は現時点で保証できない。parallelism自体は処理時間/instance数と請求を増やすため、推論並列化は費用目標に対する再見積り後の性能改善とする。[Cloud Run pricing](https://cloud.google.com/run/pricing)

## 未確認・残存リスク

- 実ブラウザで同一ユーザー複数tabのsession refresh/logout/429表示、二ユーザー切替後のTimeline/setting表示混線なしをE2E確認していない。コード経路上解析結果は呼出し元React stateへ返却され、APIに他user解析結果を読む履歴APIはない。
- 実Python processを二つ同時起動する試験は行っていない。これは現行quota/slotで禁じる経路のため。process-group lifecycle/cancelは既存Step 7k-43とStep 7k-47実証に依拠。
- Hosted Supabase/RLS/JWKS、Cloud Runのqueueing・429/5xx・startup/cold/warm・実CPU/RAM/temp・2件以上並列時の動作と費用は未検証。Cloud Run instance最大数はrevision単位設定がdeployment間で一時超過する場合もあるため、公開前確認対象。
- 月quota/burst/entitlementの運用値・新規signupの初期entitlement付与方式が未確定なら、公開直後も実ユーザーはdefault-denyとなる。無制限に開く設定は不可。

## 推奨判定

- **現行仕様で維持:** SCNet standard、process/global/user concurrency 1、max instances 1、DB fail-closed、429、request isolated temp/process、reservation lease recovery。
- **公開前必須:** Hosted auth/origin/CORS/DB access、signup policy、最小entitlement/quota数値、運用kill/rollback、local以外のcanary検証。現状はNO-GO。
- **将来の性能改善:** 一度に1解析が製品上許容できる間は並列化しない。待ち時間UXが必要なら明示queueまたは429 retry guidanceを設計。並列化は負荷測定と費用再見積りの後、slot + DB limits + Cloud scalingを同時に変更する。

## 変更ファイル

- `api/internal/audioanalysis/handler_test.go`：request user/path isolation regression testを追加。
- `docs/reports/2026-11-05-step7k-50-multi-user-concurrency-safety.md`：本報告。
- `docs/CURRENT_STATE.md`、`CURRENT_TASK.md`：Step 7k-50のstatusと結論を追記。
