# Step 7k-45 — ローカル実環境統合検証・Hosted移行判定

実施日：2026-11-04  
Status：**partial（許可済み自動検証完了、実DB/API listener統合は環境制約・未承認のため未完）**  
Hosted限定検証移行：**NO-GO**  
一般公開：**NO-GO**

## 実施結果

| 項目 | 結果 | 補足 |
|---|---|---|
| `go test -count=1 ./...` | 未完 |全package（cmd/server含む）はpass。既存`internal/service/TestOpenAIResponsesRequestUsesStrictStructuredOutput`が`httptest.NewServer`のIPv6 loopback bindで`socket: operation not permitted` panic。 |
| `go vet ./...` | 成功 |全package。 |
| focused race tests | 成功 |`internal/audioanalysis`、`internal/audiobudget`、`internal/authn`、`cmd/server`。 |
| focused service回帰 | 成功 |Hosted/local CORS、health、JWT + generation budget関連。 |
| SCNet統合 | 成功（Step 7k-44証拠を再利用） |2秒PCM WAV→Go handler→Python Island→SCNet standard、HTTP 200、Timeline v1、fake admission started/succeeded、temp cleanup。test auth/DBはfake。今回モデルを再取得・再実行していない。 |
| API binary build | 成功 |`/tmp`へ検証用binaryをbuild。 |
| API binary / health / signal | 未実施 |`API_ADDR=127.0.0.1:0`でのlistener creationが`socket: operation not permitted`。processはhealth check前にexit 1し、SIGTERM/SIGINTを送っていない。 |
| local DB read-only identification | 不確定 |ConfigはDB port 54322 / project id `audio-reactive-visual-compiler`。psql/pg_isready/Supabase CLIなし。`ss`はnetlink EPERM、`/proc/net/tcp{,6}`に54321/54322 listenerなし、postgres processなし。ただしDBが別network namespaceか、既存container内かを確認できないためDB停止とは断定しない。 |
| migration / role / backup / restore | 未確認 |実DB connectionなし。applied migration history、role/RPC/ACL/RLS実状態、snapshot/restore可能性、専用DB分離可否を特定できていない。 |
| Docker / Hosted / GCP | 未操作 |Docker inspect/execを含め一切実行なし。Hosted/GCP操作なし。 |
| `git diff --check` | 成功 |最終確認済み。 |

このtool実行環境は許可範囲内のGo subprocess startまではできたが、OS socket APIがsandbox policyで拒否される。これはGo実装のlisten失敗ではなく、kernel sandboxの拒否ログ（`socket: operation not permitted`）によるもの。通常WSL2の結果と同一視せず、通常WSL2でのAPI health/signal確認は未実施として残す。

## Audio Analyze専用quota / migration

Step 7k-42のsource static invariant testsはfocused race runに含めてpass。Migration 019の既存順序と依存role/schemaはStep 7k-44でsource review済み。今回の許可範囲ではDBに接続・変更していないため、実DBにStep7k-42 migrationが適用済みか、`arvc_audio_analysis` role/4 RPC/table ACL/RLSが想定どおりか、DB backup/restoreが成立するかは**すべて不明**。

read-only probeの根拠：`supabase/config.toml`は54322を設定しているが設定値は実DB identityの証明ではない。`psql`、`pg_isready`、Supabase CLIがなく、`ss`もnetlink EPERM。procfsのhost TCP/TCP6 tableには54321/54322のlistenerがなく、visible process listにもpostgresはなかった。Docker操作は禁止のためcontainer namespaceを調べていない。この情報だけで既存local Supabaseが停止中、migration未適用、または対象DBが安全と結論しない。

実DB testの条件はStep 7k-44報告の手順どおり、対象identity確定、検証専用DB分離、事前snapshotと別DBへのrestore実証、migration checksum/order review、明示apply permissionのすべてが揃うこと。揃わない間はdefault-deny schemaのまま実DB検証を保留する。必要なtestはdefault-deny/entitlement、user/global daily/monthly quota、別pool atomic race、user/global concurrency、burst/kill switch、pre-start release、started settlement/retry、lease recovery、DB断時fail-closed、全table ACL、role membership、security-definer owner/search_path、RLS/FORCE RLS。

結果は**実DB検証未実施**であり、いずれも成功扱いしない。

## SIGTERM・実process検証

Step 7k-43の`go test -race ./internal/audioanalysis ./cmd/server`でsignal context、root cancellation、graceful/deadline shutdown、process group kill/direct-child wait、handler settlement/cleanup unit testsはpassしている。Step 7k-44のhandler→実SCNet integration testでは2秒解析成功とfake reservation lifecycle/temp cleanupも既に確認済み。

今回API binaryをfixture mode・Audio Analyze disabled・loopback-onlyで独立build/runした。mainはserver initializationまで到達した後、`net.Listen`のsocket生成で`operation not permitted`となり、health HTTP request、SIGTERM/SIGINT、accept停止、API exit time、live Python process/temp directory、実DB quota settlementは観測できなかった。socket bindを回避した別transportで実API検証できる構成は既存契約にないため、ここでserverやAPIを変更して検証は行わない。

## 複数セッション・同時実行の検証計画

Hosted検証用の二つの別ユーザーを持ち、次をbrowser test matrixとして固定する。別userは各userのJWTをそれぞれのtabへ結び、同時解析応答、Timeline/Editor/Effects、logout/401後に相手の認証・画面・結果が変わらないことを確認。同一userの複数tabでは各tabの`sessionStorage` refresh lifecycleを観察し、結果の相互上書き、refresh token rotation/logout race、cancelが他tabのrequest/stateをcancelしないことを確認する。各API requestのAuthorization headerはそのtabのsessionだけから来ることをtest server記録で検証し、token value自体は出力しない。

QuotaはDB統合でuser cap分離とglobal capを独立poolでbarrier同期して検証する。Cloud Run並列負荷試験は行わない。将来の並行利用はCloud Run managed scalingを優先し、独自worker管理は導入しない。capacityを上げる前にCloud Run concurrency/max instances、database global in-flight/quota、費用上限を整合し別承認の負荷検証を行う。

## Readiness判断

| 段階 | 判定 |
|---|---|
| Step 7k-41〜43ローカル実装 | 完了（過去報告のscope内）。 |
| SCNet local handler integration | 完了（Step 7k-44で実測済みの証拠を再利用）。 |
| Go自動回帰 | focused/race/vet成功。全suiteはIPv6 bind sandbox制約で未完。 |
| API binary runtime / real SIGTERM | 未完（sandbox socket creation拒否）。 |
| quota real DB / migration history / privilege | 未完。target identity・migration state・snapshot/restoreとも不明。 |
| Hosted Supabase limited validation | **NO-GO**。実DB前提・target/permission未確定に加え、Hosted project ref、ES256 signing key/JWKS・audience、Supabase plan/DB direct-connect可否、test user/signup policyが未確認。 |
| Cloud Run private revision / public | **NO-GO**。GCP project/billing/region、HTTPS frontend/API originsとCORS値、quota数値、CPU/RAM/concurrency/max instances/ingress、logging/egress/image retention、実費・rollback未確定。 |

Hosted移行前に、通常WSL2でGo全suiteとAPI binary health/SIGTERMを再実行し、検証専用local DBを明示承認下で特定・backup/restore・migration/ACL/RPC/quota/cancel/lease検証する。その結果をレビュー後、Hosted settingsのread-only確認とtest-project operationを別途明示許可し、valid/invalid JWT・CORS・実DB role・二user/複数tab・SCNet解析を確認する。Step7k-45完了だけでHosted移行や公開GOに変更しない。

### 未決定の費用・環境設定

- Quota件数（user/global daily/monthly、burst、同時数）：未設定のまま。Step7k-40の20 global / 5 user月間値は仮案で確定値ではない。
- Supabase planとdirect PostgreSQL専用role/LOGIN credentialの利用可否：不明。
- Hosted project ref、issuer/JWKS signing keyのES256確認、audience/claims、Auth invite/signup policy：未確認。
- frontend exact HTTPS origin、API HTTPS base URL、CORS allowlist：未確定。
- GCP project/region/pricing、Artifact Registry保持、税/為替/egress/logging/Supabase費用、月1,000円目標の全額見積り・hard stop：未確定。budget alertをhard spend limitとみなさない。

## 変更ファイル・境界

- `docs/reports/2026-11-04-step7k-45-local-runtime-integration.md`
- `docs/CURRENT_STATE.md`
- `CURRENT_TASK.md`

runtime/source/test/migration/Frontendは変更していない。実DB read/write/apply、DB credential、Docker、Hosted Supabase、GCP操作なし。既存未コミット変更は保持。依存追加・API/auth/quota schema変更なし。

Step 7k-45の結論：**partial**。Hosted移行・公開ともに**NO-GO**。
