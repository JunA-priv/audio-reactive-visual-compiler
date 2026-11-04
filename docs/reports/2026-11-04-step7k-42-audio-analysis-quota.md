# Step 7k-42 — Audio Analyze専用利用制御

実施日：2026-11-04  
Status：**completed（ローカル実装・mock/静的検証）**  
公開判定：**NO-GOを維持**  
範囲：Go runtime、専用additive migration、read-only DB privilege verification SQL、関連資料。DB適用・接続は実施していない。

## 実装内容

### 専用quota store

`api/internal/audiobudget/`を新設し、`arvc_audio_analysis`だけが呼び出せるReserve / Start / Release / Settle RPC clientを追加した。DSN userは固定role名を要求し、remote接続ではpgxの`sslmode=verify-full`相当（TLS hostname verificationを含む）を必須とする。poolは最大4接続、各DB操作とstartup pingは3秒以内。DB詳細・DSN・RPC error本文はログ/APIへ出さず、未知結果や接続障害はunavailableとして扱う。

### Reservation lifecycle

Audio Analyze routeは次の順で動く。

1. JWT middlewareとhandler内のverified principal確認。principalなしは401で、quota storeを呼ばない。
2. 認証済み`sub`でReserve。entitlementなし403、quota/concurrency/burst超過429、disabled・未設定・DB障害503。
3. 既存process-local slot取得後、request body受信、WAV validation。ここまでの413/415/422/upload cancel/process busyはReleaseし、quota chargedにはしない。
4. SCNet runner呼出し直前にStart RPCで`reserved`→`running`へ移し、UTC quotaのcharged timestampを記録。kill switch、資格、quota、lease、capacityをもう一度確認する。
5. SCNet success/failure/cancel/timeout/output validation failureを`succeeded / failed / canceled`でsettle。Settlement失敗時は200結果を返さず503、DBのrunning leaseが後日charged expiredへ回復する。
6. Pre-start releaseは同じreservation IDに対して冪等。Settleの同一終端状態retryも冪等で、別終端状態への二重settleは拒否。

既存`analysis_busy` slot、request timeout、child cancellation、temp cleanup、Timeline v1 / Summary payloadは維持。公開APIにIdempotency-Keyは追加していないため、重複HTTP POSTは別reservationとして扱う。解析開始した各POSTは1 attemptを消費し、短時間user limit、user/service quota、concurrencyがretryを制限する。

### Migrationと権限

新規`supabase/migrations/20261104000100_step7k42_audio_analysis_quota.sql`は次のadditive tableだけを作る。

- `audio_analysis_entitlements`: enabledと明示user daily/monthly/concurrent limits。rowなし・enabled false・limit 0は拒否。
- `audio_analysis_control`: global kill switch、service daily/monthly limits、global concurrency、user burst window/limit、lease。seed rowはdisabledかつ全quota/rate値0。
- `audio_analysis_usage`: user UUID、reservation state、created/started/finalized/lease時刻、安全なerror codeのみ。media、filename、JWT、request payloadは保存しない。

Reserve/Startはsingleton control rowを`FOR UPDATE`し、日次/月次UTC quota、user/service limits、user/global concurrent capacity、burst admissionを原子的に判定する。Startは日付/月境界をまたぐuploadのquotaを再確認する。Reserve時に期限切れpre-start rowをunbilled release、期限切れrunning rowをcharged `expired_charged`へ移す。Finalized ledgerは次回Reserve時に90日超の行を削除する（lazy retention。定期schedulerは追加していない）。

専用roleは`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`で、4つの`SECURITY DEFINER SET search_path=''` RPC以外のtable/function権限は与えない。3 tableはRLS + FORCE RLS、app/service rolesを含む直接ACLなし。Function ownerは既存migration規約に合わせ`postgres`。Migrationでlogin passwordを作らないため、実行にはmigration適用後にoperatorが別手順でLOGIN credentialを安全に設定する必要がある。これは未実施。

具体的なglobal/user quota件数は定義・初期化していない。¥1,000/月は費用目標であり、この実装や未設定quotaは料金上限を保証しない。

## 変更ファイル

- `api/internal/audiobudget/postgres.go`, `api/internal/audiobudget/postgres_test.go`, `api/internal/audiobudget/migration_test.go`
- `api/internal/audioanalysis/handler.go`, `api/internal/audioanalysis/handler_test.go`
- `api/cmd/server/main.go`
- `api/.env.example`
- `supabase/migrations/20261104000100_step7k42_audio_analysis_quota.sql`
- `supabase/verification/step7k42-audio-analysis-privilege-invariants.sql`
- `docs/API_CONTRACTS.md`, `docs/ENVIRONMENT_SETUP.md`, `docs/SECURITY.md`, `docs/OPEN_ISSUES.md`
- `docs/CURRENT_STATE.md`, `CURRENT_TASK.md`, 本報告

Step 7k-42開始時点から存在した他の未コミット変更は保持し、本報告の成果へ含めていない。

## 検証

- `go test ./internal/audiobudget ./internal/audioanalysis ./internal/authn ./cmd/server`：成功。
- `go test ./internal/service -run 'Test(HostedCORS|LocalCORS)'`：成功。
- `go vet ./...`：成功。
- `go test ./...`：cmd/server、aibudget、assets、audioanalysis、audiobudget、authn、blueprint、projectsは成功。service packageの既存`TestOpenAIResponsesRequestUsesStrictStructuredOutput`が`httptest.NewServer`のIPv6 loopback bindで`socket: operation not permitted` panicし、suite全体は完走不可。Step 7k-41と同じsandbox環境制約で、quota変更起因のtest failureではない。
- Frontend実装は変更なし。Frontend test（14 files / 188 tests）、typecheck、lint、buildを実行し、すべて成功。
- `git diff --check`：成功。
- Go static testsはDSN role/TLS validation、default-deny、migration RPC数/privilege markers、日/月境界・lease/retention marker、API正常/異常/status/lifecycle、pre-start release、charged failure/cancel/timeout、DB failure fail-closedを確認。

## 未実施・未確認

- Local/Hosted DB migration適用、role LOGIN/password作成、control/quota/entitlement設定なし。
- 実PostgreSQL atomic race、quota境界、kill switch、lease recovery、RLS/ACL privilege SQLの実行なし。専用verification SQLは作成・静的レビューまで。
- Hosted Supabase/GCP/Docker/本番、Audio Analyze実SCNet実行・実JWTは未操作/未接続。
- `psql`/`pg_format`/`sqlfluff`がこの環境にないため、DB parserによるSQL syntax validationは実施できず。migration SQLは静的確認とGo source-invariant testのみ。
- `arvc_audio_analysis`のoperator LOGIN credential provisioning、final quota値、user onboarding/entitlement grant手順、quota変更の監査主体は別途決める必要がある。

## 対象外変更

既存AI generation budget/table/RPCは変更・流用していない。SCNet、Timeline v1、Blueprint v1、Effects、Frontend、API success payload契約、既存JWT検証を変更していない。既存migrationの書換えなし、新規依存なし。quota件数固定なし。DBへのwrite/apply、GCP/Hosted Supabase/Docker操作なし。秘密情報・JWT・実user IDを追加/記録していない。

## 次工程への引き継ぎ

別途承認・target確認・backup後、local test DBへMigration 019を適用し、role LOGIN credentialとsecure server DSNを構成する。Operatorが費用枠・限定検証人数を決めた後、global/user quotaとentitlementを明示設定し、verification SQLを実行。その上で複数Postgres poolからの同時Reserve、daily/monthly rollover、burst, kill switch, pre-start release, started failure/cancel settlement, process crash後lease recovery、90日retention、direct table/RPC denialをDB integration testする。これらが通った後にHosted DBのrole/network/TLS/integrationを別承認工程とし、SIGTERMとCloud Run test revisionはさらに後続工程で行う。

Step 7k-42のローカル実装完了後も公開判定は**NO-GO**。
