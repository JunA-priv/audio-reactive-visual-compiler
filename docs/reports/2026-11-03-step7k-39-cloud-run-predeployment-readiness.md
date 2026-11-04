# Step 7k-39 — Cloud Runデプロイ準備・公開前検証

調査日：2026-11-03
Status：**completed（read-only readiness調査） / 公開NO-GO**
範囲：資料・コード調査、公式仕様/料金照合、設計・チェックリスト。GCP、Hosted Supabase、Docker、実装、依存、DB、秘密情報にはアクセス・変更していない。

## 1. 結論

Cloud Run Serviceは技術的に実行候補だが、現時点では公開・デプロイ不可。ローカルでGo→Python Island→SCNet、認証付き60秒解析、Timeline v1、Editor表示、cancel、2 vCPU/4 GiB内の動作は確認済み。ただし、Hosted Supabase issuerが現行JWT validatorのloopback-only条件で拒否されること、Hostedの鍵/issuer設定、公開origin/CORS、利用者単位および全体の音源解析費用・乱用制限、Hosted DB/Storage接続・権限が未検証または未対応である。これらは公開前ブロッカー。

推奨する次工程は、まず別のL3設計・実装タスクでHosted Authに対する明示的issuer/JWKS trustを設計し、ES256、issuer/audience/role/expiry/subjectの検査とJWKS更新、fail-closedを保つこと。次に公開originとAPI経路、Signup/招待、利用制限、停止手段、Hosted DB/Storageの必要範囲を確定する。実装後、test Hosted projectおよびCloud Run test revisionで認証・実音源・cancel・SIGTERM・リソース・費用を段階検証する。

## 2. 根拠と既存データフロー

- `Dockerfile`: Go APIをPID 1として、同一コンテナのPython Island CLIを子プロセス起動。Python 3.14.10 slim、CPU PyTorch、`ffmpeg`/`ffprobe`、`AUDIO_ANALYSIS_THREADS=2`、`PORT=8080`、non-root UID 10001。Demucs開発extra/公式重みを含めない。checkpointをnamed build contextから読み、42,434,545 bytes・固定SHA-256検証後にmode 0444で配置。最終イメージに重みを含み、実測イメージサイズはStep37d報告の3,344,634,775 bytes。
- `api/cmd/server/main.go`: `PORT`があると`0.0.0.0:$PORT` bind。Hosted向けに`AUDIO_ANALYSIS_ENABLED=true`とAuth初期化が必要。`BLUEPRINT_MODE`既定値は`fixture`であり、公開用モード・AI機能の承認を意味しない。
- `api/internal/audioanalysis/handler.go`: multipart WAV 16 MiB、clip 60秒、同期解析、既定timeout 600秒、process内slot 1。requestごとのprivate temp directory、Python Island child、request cancel/timeoutでprocess group終了、deferでtemp cleanup。
- Step37dユーザー実測: 正規ローカルJWTで60秒SCNet解析HTTP 200×2（62.49/57.43秒）、Timeline v1・60秒・44.1kHz・各6,000点、Peak Memory 1,847,947,264 bytes、2 vCPU/4 GiBでOOMなし。キャンセル後Python Islandとtemp directory消失。これはCloud Run性能データではない。
- Step38ユーザー確認: 通常ローカルブラウザでSupabase Auth login、SCNet解析、Timeline/Effects/audio sync、cancel成功。Frontend 179 tests/typecheck/lint/build成功。Cloud Run実測ではない。
- `frontend/src/auth-client.ts`: Auth URLはloopback-only。Viteの`ARVC_API_PROXY_TARGET`も開発時だけでloopback限定。Productionの静的FrontendからCloud Run APIへ接続するorigin/base pathは存在しない。

## 3. Cloud Run適合性

| 項目 | 判定 | 根拠・対応 |
|---|---|---|
| Service方式 / port / architecture | verified-local（候補） | Goは`PORT`を受け0.0.0.0へbind。Cloud Runはingress containerの`PORT`を提供する。Linux/amd64のCloud Run build/起動は未確認。対象architectureを明示してbuildし、test revisionで確認。 |
| CPU / memory | verified-local / Cloud unverified | 2 vCPU/4 GiBのDocker制限下でlocal peak 1.85 GB、OOMなし。Cloud Run CPU platformは変動し、RSS/起動/同時通信等も含めた余裕はCloud実測が必要。candidate 2 vCPU/4 GiB、concurrency 1は妥当な初期値。 |
| Min/Max instances | proposed | min 0、max 1は課金・同時処理を抑える初期案。ただしmax 1は全ユーザーの認可・rate limit・monthly quotaを代替しない。max reached時の待ち/429/負荷を検証する。 |
| 同時実行 | implemented-local | APIはprocessごとに解析slot 1。Cloud concurrency 1ならSCNet同時処理を避けられる。revision/instanceの増設・他endpointは別制御。 |
| Request timeout | implemented-local / configuration required | API timeout 600秒。Cloud Run service request timeout最大60分。少なくともAPI timeoutより長い設定を明示し、cold startupも含む総時間を考慮する。初回Cloud cold requestがブラウザ/API timeoutを超えないか測る。候補900秒。 |
| Startup/readiness | unverified | Cloud Runはport listenを待ち、startup probeを設定可能。`/healthz`はHTTP 200だがSCNet checkpointは推論時検証のため、HTTP healthだけではモデル準備完了を証明しない。起動時モデルロードはなく、最初の解析がロード時間を含む可能性を実測。startup probe `/healthz`を設定し、初回推論も別途検証。 |
| Checkpoint/image | verified-local | checkpointは固定hash/size検査、image内0444。Image 3,344,634,775 bytes。Cloud Run registryからpullできる権限、build context/BuildKit cacheのアクセス制御と保持を設定。imageへのアクセスはcheckpoint入手権限相当。 |
| CPU threads / Python load | verified-local | 2 threadsでローカル計測。解析ごとに子CLIが実行される設計。Cloud CPU allocation / cold start / Python model loadを測る。 |
| Temp filesystem | implemented-local / Cloud risk | Cloud Runのcontainer filesystemはmemory-backedで、書込量がinstance memoryを消費し、容量上限がない。Goは最大16 MiB音源と解析成果物をtempに置く。実際のCloud peakにはPython/SCNet、Go、input/output tempを含め、必要なら専用size-limited in-memory volumeを検討。 |
| Request size | compatible with margin | APIは16 MiB上限。HTTP/1 Cloud Run上限32 MiBなのでAPIの上限が先に適用。ローカル60秒合成WAV 10,584,044 bytes、multipart余裕あり。ただしFrontend source upload制限と実音源変換を保ち、413動作を確認。 |
| Cancellation / shutdown | local verified / Cloud unverified | client abortでGo request context→Python process group kill→temp cleanupをローカル確認。Cloud Runはshutdown時SIGTERM後10秒でSIGKILL。現行`main.go`は`e.Start`を使用し、graceful signal shutdown handlerが見当たらない。Cloud terminationは進行中requestを切り得る。Go SIGTERM/graceful shutdownをL3実装タスクで確認・対応し、test revisionで進行中解析中の停止を検証する。 |

Cloud Run runtime contractは`PORT`, timeoutの適用、filesystemがmemory-backedであること、shutdown猶予を規定する。request-based billingは処理中requestと起動/停止の課金対象があり、min 0でも全時間が無課金とは限らない。[Container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)・[Health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks)。

## 4. Hosted Supabase Auth・Frontend境界

### 認証現状

`api/internal/authn/jwt.go`の`NewValidator`はHTTP schemeかつloopback hostのみを許可し、path `/auth/v1`を必須とする。JWKSはissuerに`/.well-known/jwks.json`を付加して取得し、別JWKS base URLは設定できない。Hosted issuer (`https://<project-ref>.supabase.co/auth/v1`)はscheme/hostの両方で拒否される。これは確認済みのコード上の非互換であり、Hosted認証ブロッカーである。

現行validatorはES256のみ、exact issuer、audience `authenticated`、expiration必須、role `authenticated`、UUID subjectを検証する。JWKS clientは4秒timeout、10分refresh intervalを指定し、ロード失敗はvalidator初期化失敗となる（fail-closed）。Supabase公式DocsはHostedのJWKS discovery endpointが`https://<project-id>.supabase.co/auth/v1/.well-known/jwks.json`であり、asymmetric ES256 keysに対応すると記載する。[Supabase JWT](https://supabase.com/docs/guides/auth/jwts)・[Signing keys](https://supabase.com/docs/guides/auth/signing-keys)。ただし対象Hosted projectのissuer、signing algorithm、audience/role/sub claimsは機密・Hosted設定を読まず未確認。JWTや秘密鍵の取得・表示はしていない。

### 公開境界

- FrontendはBearer tokenを同一origin `/api/v1/audio/analyze`へ送る実装。ローカルVite proxyは本番routingではない。
- API CORS (`api/internal/service/http.go`)は`localhost:5173` / `127.0.0.1:5173`のみ許可。本番HTTPS originからのbrowser API呼出しは成立しない。Frontend/API same-origin reverse proxyか、厳格な本番origin allowlistのCORSのいずれかを設計する。
- `frontend/src/auth-client.ts`もSupabase URLをloopback-onlyに限定。Hosted Authへ接続するproduction buildは現状拒否される。
- Frontendはlogin UIを実装するが、公開Signup・招待制の確定状態はコードからは保証できず、Hosted Auth設定も未確認。意図的なpublic signupか招待/allowlistかを決定し、test projectで試験する。
- `/healthz`は未認証。解析POSTはJWT必須。Auth issuerが直っても、有効な一般ユーザー全員に高コストの解析を許可することは費用防御にならない。
- 解析にはper-user rate/monthly capがなく、handlerのslotはprocess単位。Cloud Run `max=1`, `concurrency=1`はinstance resource guardにすぎず、料金上限ではない。アプリ側ユーザー/API全体quota、burst limit、利用資格、運用kill switchを公開前に決める。
- 解析ログにはcontent length/status/elapsed/cancelledなどがある。音声payload/JWT本文は当該handler loggerに記録しない設計だが、Cloud loggingでauthorization header、request body、音源名/ユーザー識別子が他middleware/proxy等から出ないことをtest revisionで確認し、retention/accessを決める。
- Supabase Data API/DB/Storage接続、production secrets、service account least privilege、project/asset UI公開範囲は今回未検証。Step32およびOPEN_ISSUESにはHosted DB role/connection、signup、abuse制御等の未解決が残る。

Hosted Auth対応の最小変更対象は、`api/internal/authn/jwt.go`とそのテスト（explicit HTTPS allowlisted issuer + JWKS URL構築/到達、algorithm/claims/key rotation/fail-closed）、`frontend/src/auth-client.ts`のHosted URL origin validation/tests、`api/internal/service/http.go`のproduction CORS origin設定/tests。既存ローカルissuerの受入・隔離を維持し、任意URL受入や署名検査の弱体化をしない。実際の構成を決めてから変更する。

## 5. 費用モデル（Cloud Run部分・2026-11-03参照）

Googleのrequest-based Tier 1 standard rates: CPU $0.000024/vCPU-second、memory $0.0000025/GiB-second、requests $0.40/million。free tier per billing account/month: CPU 180,000 vCPU-s、RAM 360,000 GiB-s、2M requests。東京asia-northeast1は掲載regionに含まれる。料金は100ms単位で切上げ、他プロジェクトの同一billing account利用分とfree tierを共有する。[Cloud Run pricing](https://cloud.google.com/run/pricing)。

安全側の単純モデルとして60秒requestにCPU 2×60=120 vCPU-s、memory 4×60=240 GiB-s、1 requestを計上。startup/shutdown課金、1 requestあたり実処理57〜62秒の差、instance lifecycle、retryを含まない。この仮定ではfree tierのCPU/RAM両方で約1,500解析/月が上限相当（startup等を除く）。ローカル時間をCloud実測として扱っていない。

| 60秒解析/月 | Run compute/request free tier考慮前 | Cloud Run compute/request概算（free tier適用後） |
|---:|---:|---:|
| 0 | $0 | $0 |
| 10 | $0.0348 | $0 |
| 100 | $0.3480 | $0 |
| 500 | $1.7400 | $0 |
| 1,500 | $5.2206 | およそ$0、startup等で超過し得る |
| 2,000 | $6.9608 | 約$2.24 |

単価式: per request `120×0.000024 + 240×0.0000025 + 0.0000004 = $0.0034804`。なお上表の前-tier総額は厳密値で、2,000件ではfree CPU 180,000 s/RAM 360,000 GiB-sを差し引いた超過分がおよそ$2.24。

その他:

- Artifact Registry無料枠はbilling account合計0.5 GiB。3,344,634,775 bytesを約3.12 GiBと換算し、単一tag/1 imageだけを保持する仮定では、超過約2.62 GiB×$0.10/GiB-month ≈ **$0.26/月**。複数revision/tag・Build cache・scan・外部downloadは別。image retention policy必須。[Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)
- Cloud Logging ingestion: 50 GiB/project/month free, then $0.50/GiB; >30-day retention has separate charge. 小規模でログを抑えれば通常free allowance内だが、verbose/request logsや長期retentionは別計算。[Cloud Logging pricing](https://cloud.google.com/products/observability/pricing)
- Cloud Run egress: output/response volume、client location、proxy/cache、internet transferで変わる。Artifact Registry image pull to same region Google service is free; user-facing egressは本概算で確定しない。
- Supabase Free/Pro等の実プラン、DB/Auth/Storage egressとpause要件は今回未確認。Step32はFree候補とPro固定費が¥1,000/月目標に適合しない可能性を記録しているが、最新プラン価格・用途条件は別途公式確認が必要。
- 上記Cloud Run computeを0〜500/月で無料枠内と見ても、固定Artifact image保管だけで概算$0.26/月（1 image仮定）。Free tierは請求上限ではない。budget alertは通知であり停止機能ではない。Cloud Billingは適用遅延やin-flight課金があるため、費用抑制はmax instances + application quota + service disable/traffic=0手順 + budget alertの組合せで行う。Spend capが利用可能なら適格性/範囲を別に確認し、請求の絶対上限と扱わない。

## 6. デプロイ方式・段階検証・復旧（提案のみ）

1. `asia-northeast1`候補でprivate Artifact Registry standard repositoryを設計。Build pipelineから固定tag (`git SHA`) とimmutable image digestを記録。latest/tag mutable参照はdeployに使わない。BuildKit cacheを公開せず、checkpointを含むimage/cacheへのread/write IAMを最小化する。不要な古いimage/tagをretentionで整理。
2. SecretsはSecret Manager等を候補に、runtime service identityだけが必要secretをaccess。Frontendに置くのはSupabase publishable/anon keyのみ（公開鍵としての扱いを確認）。JWT signing private key、DB password、service role keyをimage/build arg/browserへ置かない。未使用ならDB/Storage/AI integrationsを無効に保つ。
3. Cloud Run Service候補: 2 CPU, 4 GiB, request-based, concurrency 1, min 0, max 1, request timeout 900s, startup probe `/healthz`, ingressは最小の必要範囲（Frontend/APIを同一HTTPS origin proxyできる場合はinternal/all設定を設計）。`--allow-unauthenticated`はサービスのfront doorでCloud IAM認証を外す意味であり、end-user JWT middlewareは残す。ただし公開internet ingressでもAPIの利用者認可とquotaは別途必須。
4. 最初はCloud Run test revisionにtrafficを流さず/限定し、正規Hosted JWT・未認証・invalid/expired/role/audience違反・JWKS timeout/rotation・CORS/preflightを確認。次に少数authorized testerで実音源60秒、16 MiB boundary、Timeline v1、Effect同期、cancel、client timeout、SIGTERM、temp cleanup、startup/cold/warm CPU/RSS、OOM/429を試験。logs/monitoringをPII/audio/tokenなしで確認。
5. 本番昇格時は revision digest/configを保存し、段階traffic 0→small canary→100%を明示承認後に実施。異常時は前revisionへtraffic戻し、またはservice ingress/trafficを停止し、quota/AI key kill switchを実行。budget alertだけで自動停止できると想定しない。今回これらのコマンドは実行していない。

## 7. 公開前チェックリスト

| 要件 | 現在の状態 | 必須/任意 | 必要な変更・検証 / 影響範囲 / 完了条件 | リスク |
|---|---|---|---|---|
| SCNet container/4 Stem/Timeline | verified-local | 必須 | Cloud test revisionで同一契約・HTTP200確認 | medium: cloud runtime差 |
| Image/checkpoint integrity | verified-local | 必須 | private registryへ固定digest配布、SHA/sizeをstartup/analysisで確認 | high: weight/image access |
| Cloud build architecture/startup/cold | unverified | 必須 | target linux architectureでbuild/deploy candidate、cold/warm/load timeを計測 | high: unsupported architecture/latency |
| 2 vCPU/4 GiB, concurrency/max | verified-local / unverified Cloud | 必須 | Cloud peak memory、CPU throttling、queue/429を計測。OOMなく余裕を記録 | high: OOM/availability |
| Timeout/upload/request limits | partially implemented | 必須 | Cloud timeout >= handler 600s; 16MiB and 60s negative/positive boundary | medium |
| Hosted Supabase URL/Auth validation | missing for hosted | 必須 | explicit hosted issuer/JWKS support and trust/rotation tests; real Hosted test project | critical: all protected routes unavailable or unsafe workaround |
| Frontend Hosted Auth origin | missing | 必須 | Hosted URL validation/config and redirect allowlist test | high |
| Production API routing/CORS/HTTPS | missing | 必須 | same-origin route or HTTPS API endpoint + strict origin allowlist; browser preflight/auth test | high: browser blocked / overly broad CORS |
| Signup/invite/eligibility | unverified | 必須 decision | decide closed/invite/public; configure Hosted Auth and verify unauthorized user blocked | high: unsolicited usage |
| Per-user/global Audio Analyze quota | missing | 必須 | rate/burst/day-month/service-wide limits, 429 semantics, kill switch; integration test | critical: runaway cost/abuse |
| Public endpoints / auth boundary | implemented locally; hosted unverified | 必須 | classify health vs protected functions, direct API route tests; no auth bypass | high |
| Logs/data/privacy/retention | partially implemented | 必須 | inspect runtime logs, remove sensitive headers/body, retention/access policy, publish privacy/retention terms | high |
| Hosted DB/Storage/IAM | unverified; Cloud UI deferred | 必須 if enabled | least privilege roles, network/secret provisioning, RLS and restore/rollback test; keep disabled otherwise | critical if enabled |
| AI Blueprint generation/cost | default fixture; hosted mode unverified | 必須 decision before exposed | keep disabled until entitlement/budget/provider caps, credentials, kill switch proven. AI budget is separate from audio-analysis quota | critical cost |
| SIGTERM/graceful shutdown | unverified | 必須 | graceful server shutdown within 10 s, live request/child cleanup, Cloud test | high: terminated analyses/temp |
| Image registry/cache/IAM | missing cloud config | 必須 | private AR, least-privilege build/deploy/read identities, retention/access audit | high: checkpoint disclosure |
| Monitoring/stop/recovery | partially designed | 必須 | alerts + manual stop owner/runbook, revision rollback exercise, spend monitoring; alerts != cap | high |
| Cost / 1,000 yen target | estimate only | 必須 decision | confirm current Cloud/Supabase plans, image count, logs, egress and budgets; billing export after canary | high: free tier not cap |
| License/publishing | previous decision treats rights resolved for development | 必須 publication verification | existing user decision accepted in scope; retain evidence for SCNet weights/source/code and demo assets before public distribution | legal |
| Optional liveness probe | unverified | 任意 | add only if meaningful endpoint/operation; startup probe enough for initial service | low |

## 8. 判定・次工程

**Read-only調査はcompleted。公開可能判定はNO-GO。** L3の次工程として、(1) Hosted issuer/JWKS + React Supabase URL/CORS/routing design and minimal implementation, (2) usage admission/rate/cost guard and signup policy, (3) Hosted DB/Storage/IAM scope decision, (4) graceful SIGTERM process cleanup, (5) test revision canary validation, (6) budget and rollback/stop runbookを別々に具体化する。まずHosted Auth・利用制限・インターネット公開境界を解決するまでCloud Run serviceを外部公開しない。

未確認: Hosted projectのissuer/algorithm/claim config、Signup state/redirect allowlist、Hosted DB roles/network, Cloud region build/runtime architecture, actual cold start/RSS/throughput, request logs, Artifact Registry exact retention/egress, live Cloud/Supabase pricing, audio-analysis quota policy, legal publication evidence. GCP/Hosted/Dockerの状態は調査していない。

## 9. 公式資料

- [Cloud Run pricing](https://cloud.google.com/run/pricing) (current rates, request billing, Tokyo/free tier)
- [Cloud Run container runtime contract](https://docs.cloud.google.com/run/docs/container-contract) (PORT, request timeout, in-memory filesystem, SIGTERM)
- [Cloud Run quotas and limits](https://docs.cloud.google.com/run/quotas) (request size 32 MiB HTTP/1, max 60 min)
- [Cloud Run health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks) (startup probe)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing) (storage/free tier/transfer)
- [Cloud Logging pricing](https://cloud.google.com/products/observability/pricing) (ingestion and retention)
- [Supabase JWT guide](https://supabase.com/docs/guides/auth/jwts) / [signing keys](https://supabase.com/docs/guides/auth/signing-keys) (JWKS and algorithms)
- Repository: `api/internal/authn/jwt.go`, `api/cmd/server/main.go`, `api/internal/audioanalysis/handler.go`, `api/internal/service/http.go`, `frontend/src/auth-client.ts`, `frontend/vite.config.ts`, `Dockerfile`, `docs/CLOUD_RUN_LOCAL_CONTAINER.md`, Step32/37/37d/38 reports.
