# Step 7k-40 — Cloud Run公開ブロッカーの解消設計

調査日：2026-11-03
Status：**completed（read-only調査・実装設計）**
公開/デプロイ：**未実施・NO-GO**
範囲：既存資料、コード、テスト、migrationsのread-only照合。ドキュメント以外のファイル、Hosted Supabase、GCP、Docker、DB、秘密情報は変更・操作していない。

## 1. 結論

Cloud RunでSCNet解析とReact Visual Editorの限定検証を行うため、アプリ本体のTimeline v1、Blueprint v1、SCNet、4 Stem、Preview同期には変更不要。公開可否を阻む差分は、(A) Go/FrontendのHosted Supabase設定をloopback専用から安全なHosted allowlistへ拡張、(B) APIのproduction originとHTTPS経路、(C) Audio Analyze専用の利用資格・ユーザー/全体quota・停止制御、(D) Hosted Supabaseとの接続は今回必要な範囲を絞る、(E) SIGTERM時にGoとPython Islandを一緒に終了・cleanupすること。

提案する限定検証は**招待/allowlist利用者のみ、SCNet Audio Analyze + ブラウザ内Editorのみ**とする。公開Signup、Cloud Project/Asset保存、Blueprint AI生成、Demucs実行は有効化しない。利用者はHosted Authで発行したJWTを持ち、解析時に固定された許可済みissuer/JWKSで署名検証する。全解析リクエストを認証後、音声bodyを受け取る前に共有DBのatomic reservationで認可・quotaを確認し、無効/上限超過/DB障害ではfail-closedする。

一つの大きな変更としてまとめず、**Auth/API経路 → Hosted quota/DB migration → SIGTERM cleanup → Hosted test revision**の順に分ける。DB migration、Hosted Auth設定/ユーザー招待、GCP revision/traffic/IAM/料金設定はL3権限が必要な別操作であり、本設計では行っていない。

## 2. 参照した実装と互換性

### ローカルにすでにある機能

- `api/internal/authn/jwt.go`: ES256署名、issuer完全一致、audience `authenticated`、`exp`必須、role `authenticated`、UUID `sub`、Bearer tokenサイズを検証。JWKS取得は4秒timeout・10分refresh、エラー本文/鍵をログに出さない。Auth middlewareが欠ける経路は解析401、Blueprint生成503のfail-closed構造。
- `api/internal/audioanalysis/handler.go`: `/api/v1/audio/analyze`は必ずAuth middlewareを経由。60秒/16 MiBの制限、1解析slot、非公開request temp directory、Python Island process group cancel、defer cleanupがある。超過/並行実行は既に413/429。ユーザー/月間quota・全service quota・停止用runtime gateはない。
- `api/internal/aibudget` と Migration 016: Blueprint AI専用 entitlement、回数/token/cost/concurrency予約、global stop、usage settlementがある。AI prompt/token課金のモデルであり、音源解析の回数・CPU時間・request cancellationとは異なる。テーブル/RPCをAudio Analyzeへ転用しない。
- `frontend/src/auth-client.ts`: Supabase REST password login/refresh/logoutとsessionStorageを実装。URLはloopback HTTPのみ、公開Signupなし。sessionStorageのaccess/refresh tokenはXSSからは保護されないため、JS/URL/logへ漏らさない。
- `frontend/src/audio-analysis.ts`: Bearer tokenとAbortSignal付きで相対`/api/v1/audio/analyze`を呼ぶ。`frontend/src/cloud-api.ts`と`frontend/src/VisualEditor.tsx`も相対`/api`を呼ぶ。`frontend/vite.config.ts`のproxyは開発用loopback限定。
- `api/internal/service/http.go`: CORSは `localhost:5173` と `127.0.0.1:5173` のみ。Authorization/Content-Type/Idempotency-Keyを許可するがHosted originのallowlist設定はない。
- `api/cmd/server/main.go`: `PORT`があれば`0.0.0.0:$PORT`へbind。`AUDIO_ANALYSIS_ENABLED`がrouteの起動時有無を制御。終了処理は `e.Start(addr)`、signal.Notify/Shutdown処理は存在しない。
- Project/Asset: UIはCloud機能を保留/非表示としている。Project Data API、Storage URLはloopback HTTPのみ。migration群はowner-scoped RLS、authenticated主体、Storage object keyとreservationで所有者を分離。`service_role`を通常のProject/Storage APIに使わず、Asset完了確認用`arvc_asset_verifier`は限定RPCだけを実行する別role。remote DSNには既に`sslmode=verify-full`検査がある。
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, Step 7k-39、Step 7g、Step 7b/7c報告: Hosted Auth/JWKS、Hosted migration/role運用、公開乱用制御が未検証。Hosted Project/Asset UIは公開に戻す前の再評価が必要。

互換条件：ローカルSupabase/`127.0.0.1:54321`を引き続きサポートし、認証 middlewareを省略しない。SCNet standard、解析request/response、Timeline v1、Blueprint v1、Preview/Effects、Demo/Fixtureの既存挙動を維持する。公開URLを任意に受け入れる設定にはしない。

## 3. A — Hosted Supabase JWT設計

### 設定/信頼モデル

1. `AUTH_ENV=local|hosted`のような明示モードを設ける案。`local`は従来どおりloopback HTTP issuerのみ。`hosted`は`https://<project-ref>.supabase.co/auth/v1`のcanonical HTTPS issuerのみを当面許可し、host、scheme、port、path、userinfo/query/fragment、trailing pathを検査する。任意のHTTPS issuerやURLから設定値でJWKSを自由に向けられる形にしない（SSRFと誤信頼を防ぐ）。Supabase custom domainを採用するなら、別途明示的なhost allowlist設計/テストを先に行う。
2. JWKS endpointはissuerから固定path `/.well-known/jwks.json`として導出する。HTTPS標準証明書検証を有効にし、redirectは同一許可origin/HTTPS以外を拒否する。別の `SUPABASE_JWKS_URL` を受けるならissuerと同一origin、固定pathに限定する。ログは現在同様、JWT/JWKS body/key/Authorizationを出力しない。
3. 署名アルゴリズムはまず現行ES256のみを維持。対象Hosted projectの実際のsigning keyがES256であることを、権限を持つ運用者が設定画面で確認する必要がある。ES256でない場合、検証を弱めたりHS256 secretを取得・埋込みして回避しない。別アルゴリズム対応は独立したセキュリティ設計・テスト・承認対象。
4. issuer exact match、audience `authenticated`、`exp`必須、role `authenticated`、UUID subject、最大token bytesを維持する。`nbf`/clock skewはlibrary現行挙動を明示してtestし、不要な緩和を加えない。middlewareでBearer headerが一意である条件を維持。
5. JWKS初期取得失敗・TLS/DNS失敗・不正JWKSではAPI起動をfail-closed（少なくとも解析routeを公開しない）。更新失敗時の既知keyの継続利用時間、unknown `kid`でのrefresh、rotation前後、key revoke後の挙動をlibrary versionに対してtestする。10分refresh intervalはキー失効即時反映ではないのでHostedのrotation/revocation手順と合わせて扱う。

### 変更対象とテスト

| 対象 | 最小責務 |
|---|---|
| `api/internal/authn/jwt.go` | explicit local/hosted issuer policy、HTTPS/JWKS origin allowlist・redirect/TLS、sanitized initialization errors、既存claim validator保持 |
| `api/internal/authn/jwt_test.go`（必要ならJWKS mock test file） | local回帰、正規Hosted形式、malformed issuer/HTTP remote/任意host/userinfo/port/path/query/fragment/redirect reject、signature/claim fail-closed、JWKS unavailable/rotation/unknown kid |
| `api/cmd/server/main.go`, `api/cmd/server/main_test.go` | Hosted mode config wiring、misconfiguration時起動拒否、既存loopback mode互換 |
| `api/.env.example` | Hosted issuer設定名とlocal/hostedの相互排他・secret禁止コメント（実値なし） |

Hosted projectへの実JWT検証はunit testの代替にならないが、鍵materialを報告せず1 authorized test userでintegration testが必要。CodexはHosted設定やJWTを取得しない。

## 4. B — Frontend公開経路設計

### 構成

**推奨**：FrontendをHTTPS static hosting、APIをCloud Run HTTPS endpointで分離し、`VITE_API_BASE_URL`（または同等のbuild-time public setting）を使ってすべての `/api/v1/*` 呼出し先を切り替える。Vite development `/api` proxyは維持し、local build/testの既定は相対URLのまま。Cloud Run側は許可するFrontend originを環境設定から厳密に指定する。Same-origin proxyは将来選択肢だが、現時点で実装/既存設定がなく別のproxy edgeを増やすので限定検証の第一案にしない。

- `frontend/src/auth-client.ts`: loopback HTTPはlocal devだけに許可し、hosted buildはHTTPS canonical Supabase project URLを許可する。Supabase URL/anon (publishable) keyはJSへbundleされる公開値であると認識し、secret/service_role/DB credentialsは絶対に `VITE_` 変数へ置かない。
- `frontend/src/audio-analysis.ts`, `frontend/src/cloud-api.ts`, `frontend/src/VisualEditor.tsx`: `API_BASE_URL`を使う共通API URL helper経由へ変更する対象。対象全endpointで同じAuthorization、AbortSignal、idempotency headerが保たれることを確認。CORS preflight OPTIONSにAuthorization, Content-Type, Idempotency-Keyを許可。
- `api/internal/service/http.go`: local origin既定を保ち、Hosted origin allowlistを厳格に設定。Origin完全一致のみ、wildcard/`null`/substring/suffix matchを拒否。Cookie認証なしのためallow-credentialsを有効化しない。Originが不許可でもJWT authを代替・省略しない。
- `.env.example`/Frontend build docs: Hosted domain/API endpointは公開設定として区別し、redirect URLはSupabase dashboard側でexact HTTPS originを登録する手順だけ記載。secretは含めない。

### Frontend/Authテスト

- Local envで現在のlogin/refresh/logoutとdev proxyが変わらない。
- Hosted canonical HTTPS Supabase originが通り、HTTP remote、任意host、userinfo/query/fragment、公開鍵未設定はfetch前に拒否。
- API URLはlocal相対`/api`または許可されたHTTPS API originのみ。HTTP remote、JS schemes、credentials、path/query/fragment、arbitrary originを拒否。
- audio analyze, Cloud API helper, Blueprint generateが同じbase URLを使い、Authorizationが1個、JWTがURL/query/status text/logに入らず、AbortSignalが伝わる。
- Browser integration: HTTPS static frontend originからHosted Auth、API CORS preflight、Bearer付き解析が成立。JWT期限切れ、401、API timeout、cancel、CORS拒否が既存UI表示へ戻る。

## 5. C — Audio Analyzeのquota・停止設計

### 既存機能を流用できる範囲

AI budget migrationの設計パターン（private control row、atomic reservation、user/service caps、concurrency, kill switch, fail-closed）は参考にする。ただしAIの`ai_entitlements`/`ai_generation_usage`やtoken costを音源解析に流用しない。異なる請求イベント・キャンセル・duration・retentionであり、混ぜると管理・監査意味が崩れる。

### 提案する別のAudio Analysis admission store

- 新しい専用migrationと、最小DB access実装を用意する。推奨は`arvc_audio_analysis`のような別NOBYPASSRLS/NOINHERIT/NOSUPERUSER roleで、private tableへ直接ACLを付けず、固定 `arvc_internal` schemaの `SECURITY DEFINER` reserve/settle RPCだけを実行可能にする。`search_path=''`、owner限定、PUBLIC/anon/authenticated/service_role execute revoke、grant対象を専用roleだけとする。既存AI/asset roleと共有しない。
- Controlはenabled/global kill switch、user daily/monthly allowance、service daily/monthly max accepted jobs、global in-flight max、user in-flight max、policy version、timezone/reset policyを持つ。Entitlementはdefault denyでallowlisted test userのみactive、有効期限を持つ。利用枠の数値は設計だけで決定未了。Hosted運用で明示決定する。
- ReserveはJWT validation直後、`Content-Length`/multipart bodyを読んだりTemp dirを作成する前に実行し、verified JWT subject UUIDだけを渡す。DB transactionがcontrol rowをlockし、enabled, entitlement, daily/monthly count, global/user concurrency, max requestsをatomically判断。DB timeout/unavailableは503で解析を始めない。unique reservation idをserver-generatedで作る。
- Upload/WAV/60-second検証を通過し、SCNet start直前に「charged attempt」へ確定する。input不正/413/ffprobe rejectはquotaを消費せずreservationをrelease。SCNet開始後の成功・失敗・client cancel・request timeoutはいずれも実費が発生し得るため利用枠を消費し、stateだけsafe code/elapsed/clip duration等を記録する。audio、stem、features、JWT、filenameはDBに保存しない。API process kill時にreservationが永久にglobal slotを塞がないようlease expiry/recoveryを定義し、未確定は安全側にconsumedとする。
- Error semantics: JWT missing/invalid=401、valid but not entitled=403、user/service quota or rate/busy=429（Retry-Afterは可能な場合）、kill switch/DB unavailable=503、bad audio/sizeは既存422/413。API response schemaは既存Error shapeを保ち、Timeline v1は変えない。
- Burst control: daily/monthly capに加え、DB atomic in-flight limitと短時間 user throttleを含める。現行in-process `slots`と `analysis_busy` 429は回帰維持。Cloud Run concurrency 1/max 1はresource guardの補助にすぎず、shared monthly cost capではない。
- Emergency stop: DB `enabled=false`（new reservationのみdeny）を通常kill switchとする。DB不可時もfail-closed。さらに運用runbookでCloud Run ingress/traffic停止または `AUDIO_ANALYSIS_ENABLED=false` の新revisionを使う二次停止を準備する。緊急停止がDB更新もGCP operationも要しないと誤認しない。quota control rowの編集権限はoperatorに限定する。

### ¥1,000目標の設計

無料枠を計上しない保守式でservice capを決める。既存API処理timeoutは600秒、候補Cloud Runは2 vCPU/4 GiB。Cloud Run request-based単価（Step39調査）に600秒全量を置くと上限推定は1 attemptあたり `2×600×$0.000024 + 4×600×$0.0000025 = $0.0348`（request feeを別途加算）となる。これは実測所要時間ではなく、安全側のmax-duration近似。実際の月間許容数は、月初為替/税、Artifact Registryの保持image数、ログ、egress、Supabase plan、その他同じbilling accountの利用、marginを引いて計算する。free-tierは共有・変動するためハードcap計算に含めない。

現行値だけで最終quotaを決めてはならない。限定試験の**仮候補**としてglobal 20 charged attempts/month、1 user 5/month、global in-flight 1、user in-flight 1、eligible users default-deny/allowlistを提案する。これは参加ユーザーが最大4人程度の小規模評価を想定した上限案で、採用決定ではない。600秒全量課金の上限近似で20回はCloud Run compute/request約$0.696、Artifact Registryの単一image約$0.262を足して約$0.958/月（Step39資料の概算為替¥156/$1・GCP税10%を当てれば約¥165）で、logging/egress/他image/他GCP usage/Supabase費用を除く。Supabase有料planならこの予算案は成立しない可能性が高い。運用者が参加人数と試験件数を決め、最新SKU/為替/税、image retention、Supabase plan、他 billing-account usage、marginを含めて再計算・承認した後で値を確定する。ユーザーquota合計はglobal cap以下にする。Cloud billing budget alertは監視補助でありhard stopの代替としない。実費上限はSupabase/GCPの全関連費用と請求遅延を含めて確認する。

### 変更対象

| 対象 | 最小責務 |
|---|---|
| `api/internal/audioanalysis/handler.go` | reservation lifecycleをmiddleware/serviceとして接続。認証後/body読込前 reserve、validation reject release、SCNet開始時 consume、success/cancel/failure settle。既存handlerのclip/TL/cleanup保持 |
| `api/internal/audiobudget/` (new package) | dedicated DB role、TLS verify-full, bounded pool/timeouts, atomic RPC, sanitized errors |
| `api/cmd/server/main.go` | hosted modeでquota store required、pool close、misconfig/DB unreachableはstartup fail-closed |
| `supabase/migrations/<new ordered migration>.sql` + `supabase/verification/<new invariant>.sql` | additive control/entitlement/usage, dedicated role/RPC/ACL/RLS/security hardening, finite retention/recovery design |
| `api/internal/audioanalysis/*_test.go`, `api/internal/audiobudget/*_test.go`, local integration test | eligibility/quota/concurrency/race/kill-switch/db-failure/settlement/cancel/restart cleanup/status, owner spoof prevention |
| `api/.env.example` | remote DB DSN variable名、TLS verify-full、secret handlingのみ |

具体的なSQL列/初期数値と既存 migration role handoffは、migration design reviewで決める。Hosted migrationを直接適用する操作は別許可。

## 6. D — Hosted DB / Storage境界

### 限定検証では使わない

Step38のVisual Editorは解析結果をbrowser memoryへ反映し、Preview音声もbrowser-localのcropを使うため、解析/Effect previewにProject persistenceやStorage uploadは必須でない。`PROJECTS_ENABLED=false`、AI generation off、Asset verifier未接続、Frontend Cloud Project/Asset UI hiddenのままにする。Hosted test userのAuth/JWTとAudio quota storeのみを使う設計が最小で、既存Project/Asset schemaやRLSを移行する必要はない。

### 後日Project/Assetを有効化する場合

- `projects.NewDataAPI`, `assets.NewService`はURLをloopback HTTP以外拒否。Hosted Supabase HTTPS URLの明示allowlist対応が必要。Requestではanon/publishable keyと個人JWTを使い、service_role keyを使わない。
- Migration 001-015にowner `auth.uid()`/claim scoped project RLS、Project mutation RPC、Asset table RLS、private bucket `arvc-project-assets`、object path `${owner}/${project}/${asset}`、pending reservationとverified ready transitionが存在する。Step7b/7c local invariantが強い。Hosted DBにmigrationsが適用済みとは確認できていない。
- `arvc_asset_verifier`はdirect table ACLでなく `arvc_internal.project_asset_mark_ready`のEXECUTEのみを使う専用role。Go DSN validatorはremoteの場合TLS `verify-full`を要求する。HostedでProject/Assetを使うなら同じroleの権限・credential作成・Secret Manager注入・RLS/Storage policiesをHosted test projectで再検証する。credentialは今回見ていない。
- Supabase Storage policyはuser JWT/owner path/reservationを使い、Goがbyte size/MIME/SHA-256を照合する。service_roleでRLSを迂回しない。bucket private、cross-user read/write/delete reject、oversize/content-type mismatch、orphan/pending retentionをHosted integrationで確認。
- Project/Assetが限定公開に不要なら、Hosted DB schema変更・既存データ移行は実施しない。利用を再開する別工程では、schema snapshot/backup、migration order、rollback/forward-onlyの確認と明示許可が必要。

## 7. E — SIGTERM・子プロセス・temp cleanup

### 現在の問題

Go APIをcontainer PID 1として起動しているが、`main.go`は`e.Start(addr)`の後にserver close処理を行わない。Python CLIは`exec.CommandContext`と独立process groupでrequest cancel時にgroup killし、handler deferがrequest tempを消す。client cancel動作はlocalでconfirmed。しかし親GoがCloud Run SIGTERMで即終了すると、HTTP handlerのContext cancellationとPython process group終了を保証するroot signal wiringがない。10秒grace中のactive request継続だけに依存すると最終SIGKILLでchildを孤児にする可能性がある。

### 最小対応案

1. `main.go`で`signal.NotifyContext`/root shutdown contextとEcho underlying `http.Server`を用い、SIGTERM/SIGINTを捕捉。新規request admissionを止める。
2. Server `BaseContext`等を通じてactive request contextにshutdown cancellationを伝播し、既存`exec.CommandContext`のprocess-group killを再利用。`http.Server.Shutdown`をgrace periodより短いdeadline（例8秒）で実行する。shutdown開始時は解析中requestを速やかにcancelし、10秒窓内にPython waitとdeferred temp removalを完了させる。600秒requestをそのままdrainしようとしない。
3. Shutdown deadline超過時は`Close`/強制終了に移る前にactive child terminationを完了させる。`WaitDelay`とprocess reapingをテスト。termination中に成功responseを返したと偽らず、切断/5xx等の動作を確認する。
4. signal handler/timeoutログにJWT、audio path、filename、payloadを含めない。checkpoint検証・SCNet設定を変更しない。

対象: `api/cmd/server/main.go`, `api/cmd/server/main_test.go`, `api/internal/audioanalysis/handler.go`/test (only if context hook must be explicit), possibly a small server lifecycle helper. Existing request client-cancel path must remain unchanged.

Tests: fake child waits until ctx cancellation then exits; start authenticated request, signal root cancellation, assert child/process-group termination and temp cleanup; normal request still returns 200; repeated signal/deadline does not hang; SIGTERM while idle; shutdown within 8s; existing client cancellation/timeout tests. Local container-level test should observe child PID/temp and API exit, then Cloud Run test revision validates actual 10-second SIGTERM behavior. Do not stop existing containers.

## 8. 順序・依存・別許可

| Phase | Work | Depends on | Permission boundary |
|---|---|---|---|
| 0. Policy decision | test users/invite only, 60s workload, max allowed monthly jobs/users, kill owner, no Projects/Assets/AI | none | Product/cost policy decision by user; no external change |
| 1. Local Auth/API design implementation | hosted auth mode validation, JWT/JWKS tests, frontend hosted settings/API URL, strict CORS | 0 | Source code change requires separate Step40 implementation authorization (L3) |
| 2. Analysis quota | additive migration/role/RPC, entitlement admin path, transaction/reserve/settle, rate limits/kill switch | phase1 identity/host config | New DB schema and role passwords are privileged; local migration first with backup, separate approval; Hosted changes separately approved |
| 3. Shutdown | root signal context, graceful stop, child/temp lifecycle | no schema dependency; can parallel only after design lock | Source code change separately authorized; no external service needed for local tests |
| 4. Local regression | Go tests/vet, Frontend tests/typecheck/lint/build, migration invariants/local Supabase integration, local Docker test if authorized | phases1-3 | Local reversible testing; do not alter existing runtime without approval |
| 5. Hosted readiness | inspect allowed Hosted Auth settings, provision test account/invite, apply reviewed migrations/roles, verify CORS/JWKS/DB/storage scope | phases1-4 | Needs explicit Hosted Supabase operation permission and secrets supplied through approved runtime path; no secret copy into docs |
| 6. Cloud test revision | private image push, deploy no/limited traffic, logs/resources/cancel/SIGTERM/quota/cost | 1-5 complete | GCP billing/resource and image push/deploy are expressly outside current task; require separate explicit L3 authorization |
| 7. Public canary | invite small cohort, monitor/stop, rollback | successful phase6 and user approval | External publication/traffic is a separate decision |

Local and Hosted configuration stay separate. Never make Cloud Run public before JWT/JWKS integration, service global/user quota, hard disable path, HTTPS frontend routing, no-secret audit, and SIGTERM cleanup tests pass.

## 9. Validation matrix and end conditions

### Normal / regression

- Local Supabase login/refresh/logout, existing local JWT positive and invalid issuer/claim tests unchanged.
- Hosted mocked JWKS ES256 positive; exact issuer/aud/role/exp/sub; unknown kid rotation; TLS/redirect/url allowlist; initial JWKS unavailable fails closed.
- Production static HTTPS frontend config; correct API base for audio, blueprint and cloud helper; CORS preflight allow exact origin/headers; local Vite proxy remains loopback only.
- Eligible invited user reserve succeeds once and returns the same SCNet `analysis.model=scnet_standard`, Timeline v1, duration/series as today; no API or Timeline contract changes.
- Quota: per-user daily/monthly cap, service cap, burst, one in-flight, competing concurrent reservations across independent store connections, timezone boundary, TTL recovery, duplicate retry semantics.
- Unlimited/unauthorized signup or non-entitled test user is denied before upload/body handling. Service cap/kill switch denies before Python process starts.
- Invalid WAV/413/clip >60 sec does not consume a costly attempt; once SCNet begins, completed/canceled/timeout/known failure consumes one attempt according to written policy.
- Quota DB unavailable/timeout returns 503 and launches no Python child; migration/config failure prevents hosted audio endpoint from being enabled.
- No audio/JWT/prompt/checkpoint/path/user email persists in quota table or logs; usage metadata is minimized and retention bounded.
- Project/Asset disabled: Hosted analysis flow does not attempt Data API, Storage, service_role or Asset verifier. If later enabled, rerun Step7b/7c SQL invariants + two-user data isolation + private Storage object policy + remote TLS tests against a test project.
- SIGTERM while analysis child runs, within Cloud Run grace; child reaped, request temp removed, container exits; ordinary browser cancel/timeout still works.
- Local tests: Go auth/audio/service, race/concurrency tests, mypy/Ruff/py_compile as relevant (no model behavior changes), Frontend 179+ tests/typecheck/lint/build, SQL invariants, `git diff --check`. Full existing tests must separate known sandbox bind limitations.

### Limited verification release conditions

Only after Phase6 explicit authorization, first test revision should pass all: HTTPS auth/session; no auth and invalid/expired/token from wrong project rejected; invited user permitted; non-invited denied; max requests enforced globally and per user; disabled switch and DB outage fail closed; 60-sec SCNet request returns Timeline v1 and Effects work; 16 MiB/invalid audio rejected safely; cancel and SIGTERM clear child/temp; peak memory within 4 GiB with recorded safety margin; Cloud startup/cold/warm time and total costs measured; logs contain no bearer/audio. Keep Project/Asset/AI generation disabled and no broad public Signup.

## 10. 未解決事項・判断/権限が必要な点

1. Hosted project ref/issuer domain, ES256 status, configured audience/claims, redirect URLs, signup setting and region are not read; operator must confirm in approved setting-review step.
2. Frontend API hosting plan/production domains are undecided. Recommendation: direct HTTPS API base + exact CORS allowlist for initial limited release; deployment hostname values are not yet known.
3. Test cohort size, per-user/day/month requests, service monthly request cap, short burst rate, retention period and shutdown operator are undecided. These are product/cost policy decisions, not safe assumptions for implementation.
4. Supabase pricing plan/availability and Cloud billing account's use of free tier/other projects are unknown. Monthly JPY 1,000 cannot be guaranteed from Cloud Run compute-only math. User chooses acceptable hard service quota after full cost budget and exchange/tax rules are set.
5. Hosted DB migration/role access is not needed for SCNet-only browser validation except new quota store; whether direct remote PostgreSQL with least-privilege login or authenticated Data API RPC is permitted for the Hosted plan must be established. Recommendation is a dedicated server-only DB role/RPC because it gives atomic global gating without using `service_role`; prove network/TLS/role provisioning on a test project before selecting.
6. No DB schema/policy diff is justified for Project/Storage in this limited step. If user requests cloud save/asset upload, that expands scope and requires separate migration/authorization review.
7. Cloud Run SIGTERM actual behavior, cold start, cgroup memory, usage billing, Artifact Registry retention, egress, canary and rollback remain untested.
8. No implementation, migration, setting, secret, user, service, revision, image, traffic, or cost resource was changed. Local source implementation, Hosted DB operations, and GCP deployment require distinct task authorization; deployment/public canary also require a final release decision.

## 11. 推奨する次の最小工程

次の実装工程（L3）は、まず限定利用ポリシーを合意し、Phase1のlocal unit tests中心のHosted-compatible auth/frontend config/origin/CORS実装を行う。Phase2はadditive local migrationとquota-store実装・privilege invariantsをレビューし、対象local DBをbackupして適用/検証する許可を別途確認する。Phase3でSIGTERM child/temp teardownを実装/testする。この3工程のローカル検証が通ってから、ユーザーが別途許可したHosted Supabase test project operation、続いてGCP private image push/test revisionを行う。

本報告でStep 7k-40設計完了とする。これによりStep 7k-39の公開NO-GOは解除されず、readiness、Hosted integration、deploy、publicationを完了したことにはならない。
