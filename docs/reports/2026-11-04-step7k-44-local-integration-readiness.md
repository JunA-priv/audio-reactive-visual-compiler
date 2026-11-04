# Step 7k-44 — ローカル統合検証・公開前Readiness評価

実施日：2026-11-04  
Status：**partial（自動回帰検証完了、実DB・ローカル統合環境の一部未確認）**  
公開判定：**NO-GOを維持**  
対象：Step 7k-41〜43の回帰評価、Step 7k-42 migration静的レビュー、ローカル実行可能範囲の統合確認。

## 結果概要

| 領域 | 結果 | 根拠・未確認 |
|---|---|---|
| Frontend回帰 | 成功 | 14 files / 188 tests、typecheck、lint、build成功。実ブラウザ／Hosted Auth接続ではない。 |
| Go focused回帰 | 成功 | audioanalysis、server、audiobudget race tests成功。Hosted/local CORS、health、JWT+budget service tests成功。 |
| Go全体test | **環境制約で未完** | `TestOpenAIResponsesRequestUsesStrictStructuredOutput`の`httptest.NewServer`がIPv6 loopback bind (`socket: operation not permitted`)でpanic。他のpackageはpass。 |
| Go vet / diff check | 成功 | `go vet ./...`、`git diff --check`成功。 |
| Audio Analyze + Python Island実解析 | **成功（局所経路）** | checkpointを読み取り専用検証。2秒synthetic PCM16 WAVをGo handler→Python Island→SCNet standardで解析しHTTP 200。Timeline v1、reservation started/succeeded、temp cleanupをtest assertionで確認。JWT/DBはtest fake。 |
| API binaryへのSIGTERM/SIGINT | **環境制約で未実施** | process harnessのIPv4 loopback用socket作成が`PermissionError: Operation not permitted`となり、API process起動前に停止。Step 7k-43のsignal unit/process-group testsはpass。 |
| quota実DB・Docker | **未実施** | psql / Supabase CLIなし。DB target/backup/restoreも未確認。Dockerは許可外のため呼び出していない。 |
| Hosted / GCP / browser multi-session | **未実施** | 許可外または未確定の設定・実環境。公開GO判断の証拠には含めない。 |

この実行環境は通常WSL2とは異なる制限付きsandboxである。IPv6の過去の失敗を再確認し、実API processの試験も行おうとしたが、local socket creation自体が禁止されていた。これは通常WSL2で同じ制限があることを示さない。handler内の実SCNet統合は完了したが、TCP listenerを使うAPI binaryの再実行は通常WSL2に残す。

## Step 7k-42 migration / role静的レビュー

Migration `20261104000100_step7k42_audio_analysis_quota.sql`は、既存の`20261101000100`〜`20261101001800`に続く新規additive migration。既存`20261101001200`で作る`arvc_internal` schemaと`arvc_asset_verifier` role、`20261101001600`で作る`arvc_ai_budget` role、Supabase標準`auth.users` / `anon` / `authenticated` / `service_role`に依存する。古いmigrationの書換えはない。

新migrationは専用`arvc_audio_analysis` role（NOLOGIN、non-superuser、role membershipなし）、entitlement/control/usageの3表、4つのprivate RPCを作成する。3表はRLS + FORCE RLSで直接ACLを全relevant roleからrevoke。roleに与えるDB CONNECT / `arvc_internal` schema USAGE以外の利用権はRPC EXECUTEに限定する。4 RPCは`SECURITY DEFINER`、owner `postgres`、空の固定search_pathで、default controlはdisabled / quota 0。具体的quota値・entitlementは入れていない。Go static SQL invariant testとverification SQL source checkはpassした。

適用順序はmigration filename上確認できるが、実DB migration history、target DBのidentity、現行schema/roleの実態は読めていない。psql、Supabase CLI、SQL parserは存在せず、verification SQLもDB上では実行していない。Docker commandは呼び出しておらず、local Supabase DB状態を推定していない。専用roleはmigration後もNOLOGINのため、server DSN用LOGIN credentialはoperatorが別工程で安全に準備する必要がある。

### 承認後の検証専用DB手順

1. 検証専用local Supabase project / database名、host、port、migration historyを記録し、Hosted・production・共有DBではないことを二者確認する。現在の`supabase/config.toml`はDB port 54322、project idは`audio-reactive-visual-compiler`を指定するが、現在稼働するDB identityを示す証拠ではない。
2. 適用前にschema/data/role membership/ACL snapshotを取得し、別の使い捨てDBへrestoreできることを検証する。失敗時はDBを破棄せず、snapshotからのrestoreかレビュー済みforward repairを行う。migrationはroleとtableを追加し、quota usageを作るため、単純な`DROP` rollbackは使わない。
3. reviewed checksumと全prior migrationの順序を照合後、明示許可された検証DBだけへapplyする。`arvc_audio_analysis`をLOGIN化する前にrole属性・membershipを検証する。
4. `step7k42-audio-analysis-privilege-invariants.sql`を実行し、4 function以外のtable/function grantがないこと、app rolesがRPCを実行できないこと、RLS/FORCE RLS、security definer owner/fixed search_path、disabled/zero defaultsを確認する。roleをLOGIN化した後もrole privilegeとmembershipを再検証し、credentialはDSN secretとしてのみ注入する。
5. 使い捨てuserと固定 test quota を隔離環境に作り、以下を独立Postgres connection / poolからテストする。fixture作成・削除はその専用DBだけに限定し、UTC day/month boundaryは過去時刻のledger fixtureで再現する。
6. 実行後にusage/entitlement fixtureを消去またはDBごと破棄し、verification結果、migration version、restore手順、role LOGIN状態、変更差分を記録する。

必須SQL/runtime case：

- control row欠落・disabled・各global quota 0、およびentitlementなし/disabled/expired/limit 0がdefault-deny。
- entitle済みuserの正常Reserve、同じuserと別userのuser/global daily・monthly cap境界。
- 独立poolをbarrier同期し、service quota/concurrency limit 1の下で複数Reserve競合を起こして、許可数を超える予約がcommitしないこと。
- 同一userの同時制限、global in-flight、request-window/burst、kill switchをReserveとStartの両方で確認。
- 入力/ffprobe/slot拒否はReleaseかつ非charged、Start済み成功・失敗・cancel・timeoutは1 charged attempt、settlement同状態retryは冪等、別state retryは拒否。
- 期限切れreservedはunbilled release、期限切れrunningはcharged `expired_charged`へ回復し、90日超finalized rowだけがretention対象となること。
- roleからdirect table SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGERをすべて拒否し、PUBLIC/anon/authenticated/service_role/AI budget/asset verifierはRPC EXECUTE不可、専用roleのみ4 RPCを実行可能。
- DB起動時未到達ならquota store初期化失敗でAPI routeを有効化しないこと、起動後connection interruptionでも解析を起動せずfail-closedとなること。

これらは計画であり、実行成功を意味しない。lease最低60秒、月次境界、複数pool競合、SQL privilegeは実DB適用なしでは確認できない。

## SIGTERM・Audio Analyze統合確認

Step 7k-43のmock/fake process-group tests、signal contextのSIGTERM/SIGINT delivery、shutdown deadline、handler cancel/settlement/temp cleanup testsは再度pass。API binaryに対しては、127.0.0.1 socket作成時にsandboxが拒否したため、起動・health check・signal送信・port closeを観測できなかった。実processでのaccept停止・8秒上限は未確認。

Python Island統合testはStep 7k-42後のJWT Principal / Admission必須契約に追従していなかったため、test-only fake admissionとverified test principal contextを追加した。初回実行は固定checkpoint不在でPython exit 2 / HTTP 502だった。その後ユーザー指定先のcheckpointを読み取り専用で検証し、再取得・変更なしで再実行した。Go handlerから2秒WAVをPython Island/SCNet standard CPUへ渡しHTTP 200（推論4.25〜5.32秒）となり、response `analysis.model=scnet_standard`、`featureTimeline.schemaVersion=1`、duration、reservation start + `succeeded` settlement、request temp root emptyをテストで確認。test auth principalとAdmissionはfakeであり、実JWT・DB quotaの証明ではない。実解析を含むshutdown/cancel時settlementは未確認。

実環境での再実行順序：検証済みSCNet checkpointの配置とhash確認 → quota DBを承認済みtest設定だけで起動 → local APIのloopback起動 → valid/invalid JWTとquota allowed/deniedを確認 → 正常SCNet解析でTimeline v1/response shapeとEditor入力を確認 → 長時間解析中にSIGTERMまたはSIGINTを送り、API exit時間、Python group、direct child wait、temp path、reservation stateをDB ledgerとOS process observationの両面から確認。Docker testは別途明示許可後、既存containerとnetwork/volumeに触れない使い捨て環境だけで実施する。

## Frontend / session isolation

Frontendは14 files / 188 tests、typecheck、lint、production buildが成功。Auth clientは`sessionStorage`を使い、API helperは既存routingを維持する。単一browser contextのunit testsは成功したが、別user二名と同一user複数tabの認証refresh、Editor状態、解析結果の相互非干渉を実ブラウザで試験していない。Hosted Supabase Auth login、実JWT、CORS preflight、実HTTPS API呼出し、Effects/Audio同期の再E2Eも未確認。

## Readiness判定

| 段階 | 判定 |
|---|---|
| ローカル実装 | Step 7k-41〜43の実装は完了。Step44では既存Python integration testのtest adapterのみ補修。 |
| ローカル自動回帰 | Frontend全項目、focused/race Go test、service CORS/auth focused test、Go vet、diff checkは成功。Go全suiteはsandbox bind制限で未完。 |
| ローカル実環境統合 | **一部完了**。handlerから実Python Island/SCNet standardまでの2秒CPU解析、Timeline v1、fake reservation settlement、temp cleanupは確認。TCP listener/API binary signal、実DB状態/適用/restoreは未確認。 |
| Hosted限定検証 | **移行保留**。project ref/ES256 key/issuer・audience/Auth policy、Supabase planと直接PG role接続可否、API/frontend origin、quota件数、secret provisioning、費用枠が未確定。Hosted設定・DB migration permissionなし。 |
| Cloud Run test revision | **未承認・未実施**。project/billing/region/Artifact Registry、CPU/RAM/concurrency/max instances/min instances/timeout/ingress/logging、private rolloutとrollback値、Cloud Run請求見積り・hard quotaが未確定。 |
| 公開GO | **不可**。GO条件は後述。Step7k-44完了でGOへ変更しない。 |

### 未確定の公開設定・費用条件

- Audio quota件数：global/user day/month、burst、user/global concurrencyはすべて別決定が必要。Step7k-40の20/month global・5/month userは仮案で、migrationは0/default disabledのまま。
- Hosted Supabase：project ref、issuer/JWKS到達性、Hosted signing keyがES256である証拠、JWT audience/role/expiry、signup/invite policy、plan、network policy、dedicated PG roleの接続手段・TLS hostname確認。
- Frontend/API：確定済みHTTPS frontend origin、公開HTTPS API base URL、exact CORS allowlist値、Auth redirect allowlist。
- GCP：project/billing account、region、image retention、Cloud Run resource/concurrency/max instances、logging/egress/Artifact Registry/Supabase費用、税・為替を含む総額と即時停止手順。月額1,000円は現在の実装で保証されず、budget alertのみをhard capとみなさない。

### Hosted限定検証へ進む前の条件

1. 通常WSL2環境で`go test ./...`を完了し、上記ローカルDB migration testとrestore手順を別途承認・実施する。
2. local DBでquota atomicity/role/RLS/lease/shutdown settlementを通し、専用LOGIN credential・TLS DSNの実運用設計を確認する。
3. 検証参加人数と費用再計算を確定してquota値を承認し、entitlementをdefault-denyのままtest accountだけへ付与する。
4. Hosted test projectのtarget、backup/rollback、ES256/claims/Auth policy、plan/network/PG login capabilityを確認し、Hosted操作の明示許可を得る。
5. Hosted Auth valid/invalid JWT、CORS exact origin、DB role/connection、quota allow/deny/kill switch、SCNet response、browser cancel、二user/二tab分離、停止後cleanupを非公開の検証アカウントで確認する。

### 公開GO・複数セッション検証条件

- local full suiteと実DB検証が完了し、Hosted testでAuth/JWKS/HTTPS/CORS/DB migration/privileges/quota/fail-closedを検証済み。
- 実ブラウザの正常/異常Audio Analyze、Timeline v1、Visual Editor、Effects/audio sync、cancel、different-user + same-user multi-tab isolationを確認。
- Cloud Run private test revisionで実SIGTERM中のAPI/Python終了・settlement/temp cleanup、memory/CPU/latency/cold start、ログ・egress・実費、ingress/traffic rollbackを実測し、上限と運用停止runbookを承認。
- 月額1,000円目標の全費用内訳、chosen quotaとCloud Run max instances/concurrency、DB global atomic quota/in-flightを整合し、並行利用試験で上限を超えないことを証明。
- すべてが通るまで公開はNO-GO。

Cloud Run並列負荷試験は本Stepで実施していない。managed scalingを使用できるなら独自worker管理を追加せず、同時解析数増加はconcurrency/max instances/global quota/cost再評価後に別工程とする。

## 変更ファイル・境界

- `api/internal/audioanalysis/handler_integration_test.go`：Step7k-42のtest auth principal/admissionを追加し、成功時のsettlement/temp cleanupを確認するようtestを同期。
- `docs/reports/2026-11-04-step7k-44-local-integration-readiness.md`
- `docs/CURRENT_STATE.md`, `CURRENT_TASK.md`

本Stepはmigration/DB/source runtime/frontend/API behaviorを変更していない。無断DB操作・Docker操作・Hosted/GCP操作・依存追加なし。既存の他の未コミット変更は保持。

Step 7k-44のreadiness判定はpartialであり、公開NO-GOを維持する。
