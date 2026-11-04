# Step 7k-47 — Local Supabase Migration 019 / JWT・SCNet HTTP統合

**状態: 部分完了 — Migration 019と実JWT/DB/Go/SCNet HTTP検証は完了しましたが、ブラウザー/Editor E2Eは未検証です。** 変更は承認済みの既存ローカル`postgres`データベースと独立APIテストプロセス1つに限定しました。Hosted/GCP操作は行っていません。

## 1. Phase A: 既存環境

2026-11-04の読み取り専用調査で、既存Supabase stackが稼働中であることを確認しました。DBコンテナは`supabase_db_audio-reactive-visual-compiler`、imageは`public.ecr.aws/supabase/postgres:17.11.0.006`、Image IDは`sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`、PostgreSQLは17.11です。既存named volume `supabase_db_audio-reactive-visual-compiler`、network `arvc-supabase-loopback`、loopback DB port 54322を使用します。コンテナ、volume、networkは変更していません。

ローカルAuth healthは`http://127.0.0.1:54321/auth/v1/health`でHTTP 200でした。DB名は`postgres`で、サイズは約12 MBです。最新migrationは`20261101001800_openai_gpt6_luna_budget_pricing`です。`arvc_audio_analysis`は存在せず、`arvc_ai_budget`と`arvc_asset_verifier`はLOGIN、`arvc_project_writer`はNOLOGINです。現在の件数は`auth.users`が1行、`public.projects`、`public.project_assets`、`storage.objects`は0行です（Storage bucketは1つ存在）。既存userはStep 7k-46のbackup時刻より前から存在します。この比較は変更前の新規backupの代わりにはなりません。

Step 7k-46のbackup fileは存在し、mode 600で、記載されたhashと一致します。

| File | Size | SHA-256 |
|---|---:|---|
| `step7k46-before-migration.dump` | 484,791 bytes | `419b29dda2dd504fa8fe90f766c0a73290d6d0133b7ebb15f0f99c95859e2f62` |
| `step7k46-globals.sql` | 8,274 bytes | `f603275fdafb4af16c9e5a19d989f0c0ec91bbe70e7c5027c5474b1730772706` |

DBコンテナの`pg_restore` 17.11でSupabase event triggerを含むarchive TOC読み取りに成功しました。TOCを読めることはarchive parsingの確認のみで、現在のDBを復元できる証明ではありません。Step 7k-46では別途このbackupを隔離DBへ正常復元しました。手順間に既存ローカルDBが変わる可能性があるため、Phase B前に新しいdumpとglobals backupを取得し、hash/TOCを再確認してください。

## 2. ツールと稼働アプリケーション

ホストの`docker`は利用可能でしたが、ホスト側の`psql`と`supabase` CLIは見つからず、以前使用したcache済みCLI pathもありません。PostgreSQL toolはDBコンテナ内にあります。読み取り専用`docker exec ... pg_restore --list`はサンドボックスに拒否されましたが、コマンド単位の明示的な権限昇格後にTOC確認に成功しました。過去の承認から一般的なDocker権限を推定していません。

loopback listener一覧には8080、5173、Supabaseのportが含まれていました。Editorは`http://127.0.0.1:5173/`でHTTP 200を返しました。API root `http://127.0.0.1:8080/`へのGETはHTTP 500でしたが、取得可能なprocess viewではプロセスの所有者を確認できませんでした。そのlistenerが意図したGo APIだと仮定せず、特定とテスト調整なしに置換/停止しないでください。通常のテスト対象routeは`POST /api/v1/audio/analyze`です。

`api/.env`は存在し、Gitでignoreされています。存在/真偽の概要のみを読み、値は表示していません。`AUDIO_ANALYSIS_ENABLED=true`、`AI_GENERATION_ENABLED=true`、`PROJECTS_ENABLED=true`が設定されています。`SUPABASE_AUDIO_ANALYSIS_DSN`は未設定で、Supabase URL、issuer、anon keyは設定済みです。`AUTH_ENV`は未設定で、Goの既定値は`local`です。Python Island実行ファイルは既定path `python-island/.venv/bin/python-island`にあり、FFprobeは既存のdefault/PATHに委ねています。この設定は要求された隔離Audio Analyzeテストprofileではありません。テストprocessではAI generationとProjectsを無効化し、quota DSNをGitに保存したり表示したりせずに渡す必要があります。`run-local.sh`は`.env`読み込み前のprocess単位feature flag上書きを保持します。別途スコープされたテストprocessのみ使い、明示的に必要でレビュー済みの場合を除き`.env`を編集しないでください。

固定済みSCNet standard checkpointは既定のTorch hub checkpoint pathにあり、42,434,545 bytes、SHA-256は`f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`と一致します。Python Islandはload時にサイズとdigestを確認し、モデルを自動ダウンロードしません。

## 3. MigrationレビューとPhase B適用計画

Migration file: `supabase/migrations/20261104000100_step7k42_audio_analysis_quota.sql`, SHA-256 `21b524f9ffd4677070f047c47447ca7a0fb36d048f6fdaf301d8050c13a33024`. It is additive and creates the `arvc_audio_analysis` NOLOGIN role, `audio_analysis_entitlements`, `audio_analysis_control`, `audio_analysis_usage`, and four fixed-search-path SECURITY DEFINER RPCs: `audio_analysis_reserve(uuid)`, `audio_analysis_start(uuid)`, `audio_analysis_release(uuid)`, `audio_analysis_settle(uuid,text,text)`. Tables are RLS-enabled and FORCE RLS; direct table privileges are revoked. Only the dedicated role receives RPC EXECUTE. Control and quota defaults deny access (disabled, zero limits). Reserve/start serialize on the control row and enforce user/global limits, burst and concurrency; reserve performs expired lease recovery and 90-day retention cleanup; start rechecks current buckets; release is pre-start only; settlement charges running attempts and is idempotent for the same terminal state. Exact grants/ACL are checked by `supabase/verification/step7k42-audio-analysis-privilege-invariants.sql`.

SQLはroleが既に存在すると処理を拒否し、作成するすべてのobjectに`IF NOT EXISTS`を使うわけではありません。無条件の再実行は安全ではありません。preflightで正確なtarget identity、最新migration 018、migration 019行なし、部分作成object/roleなしを確認します。migrationには`pg-delta: transaction=false` directiveがなく、確認上statementはtransaction対応です。Phase Bでは`psql --single-transaction -v ON_ERROR_STOP=1`の明示transaction内で適用しversion/nameを登録しました。したがってstatement失敗時はDDLとhistoryの両方がrollbackされます。失敗時は統合実行を停止し、適用済み扱いにしたり無条件再試行したりしないでください。復旧はfreshな変更前backupをレビュー後に同一ローカルstackへrestoreするか、transaction rollback済みの適用処理を修正します。破壊的なdropによるrollbackは計画していません。

標準のSupabase CLI migration commandは`supabase migration list --local`の後に`supabase migration up --local`ですが、CLIがなく追加installもしませんでした。Step 7k-46と本stepではSQLを直接適用し、version/nameを`statements=NULL`で登録しました。既存ローカル行はNULLでない配列を持ち（直前の行は3 statements）、Supabaseの[CLI reference](https://supabase.com/docs/reference/cli/introduction)によると`migration list`はtimestampのみを比較するため、このversion/name行は通常の前方`migration list`/`migration up`運用との互換性を保ちます。NULL配列がCLI取得SQLと同等だとは主張しません。この行に対する`migration fetch`/`migration down`動作は未検証で、rollback方法として使いません。前方のみのproject運用では、レビュー済みSQLを実行し、同じtransaction内で正確なversion/nameのhistory行を`statements=NULL`のまま挿入します。その後行を検証し、privilege checkを実行し、backupを保持します。statement配列を捏造したり、migration historyを書き換えたり、rollbackにCLI downを使ったりしないでください。migration SQL自体は変更していません。

migration後は`arvc_audio_analysis`のみをLOGINとして設定し、membershipなし、superuser/BYPASSRLSなしにします。保護された対話/一時secret機構で新しいrandom passwordを設定します（command-line literal、shell history、報告書、Gitには決して記録しません）。username `arvc_audio_analysis`、`sslmode=disable`で`127.0.0.1:54322/postgres`へのTCP接続を確認し、Goの`NewPostgres`がこのusernameを受け入れることも検証します。admin/service-role DSNは使いません。最初の接続probeではcontrol disabled/zero、entitlementなしを維持します。認可されたHTTPケースに限り、最小の一時limitと対象test userのentitlementを設定し、その後default-denyへ戻してtest ledger/config行を削除します。

## 4. JWT / HTTP / Python Island計画

Goの`AUTH_ENV`既定値は`local`です。issuerは設定済みローカルSupabase Auth issuerと一致し、validatorは`<issuer>/.well-known/jwks.json`からJWKSを取得します。有効tokenではissuer、audience、expiry、role、UUID subjectを検証します。JWTをログ出力/記録しないでください。既存のローカルloopback HTTP issuerを維持します。Hosted mode、HTTPS、Hosted credentialsは対象外です。

専用API processを空いているloopback portのみでbindし、test専用環境として`BLUEPRINT_MODE=fixture`、`AUTH_ENV=local`、Audio Analyze有効、AI generationとProjects無効、検証済み専用quota DSNを設定します。既存ローカルSupabase URL/issuer/anon key、Python Island path、FFprobe、CORS、request制約を維持します。8080が既にlistenしている場合はプロセスを特定して別portを使い、所有不明processを停止/置換しないでください。Hosted/prod credentialsを公開・再利用しないでください。Frontendは5173のままとし、API/DB経路が動作した後にのみ使います。

完了済みStep 7k-44の合成2秒WAVテストではGo handler → Python Island → SCNet standard → Timeline v1を実行しましたが、fake Authとquota admissionを使用しました。これは実JWT/DB HTTP統合の証拠ではありません。Phase Bでは既存Editor/browser経由のローカルAuth sessionを使い、bearer tokenをログへコピーしません。routeをend-to-endで検証し、安全な結果fieldとledger集計状態のみ確認します。

## 5. Phase B検証と安全チェックリスト

明示的な承認後に限り実施:

1. Recheck container/image/volume/network identity and migration state read-only; take fresh mode-600 custom-format DB and globals backups, record size/hash, and verify archive TOC. Do not stop/change the existing stack.
2. Apply only the migration to the confirmed local `postgres` DB, using the approved documented/native CLI path if available without installation, otherwise the reviewed atomic `psql` fallback above. Check history, role/membership, four RPC signatures and EXECUTE ACL, RLS/FORCE RLS, direct-table ACL, and all seven privilege invariants.
3. Provision the isolated dedicated LOGIN password safely; verify TCP login and Go quota store connection. Confirm default-deny before enabling any fixture limits.
4. Test missing/invalid JWT (401), no entitlement/control disabled/kill switch (denial), then one temporary explicitly entitled local user for normal reserve → start → SCNet → Timeline v1 → settlement. Verify response/ledger consistency without recording user ID or JWT.
5. Test user/global daily/monthly limits, burst/rate, concurrency and independent requests, pre-start release, post-start cancel/settle, duplicate settlement, lease recovery using safe short test leases, and fail-closed DB errors. Avoid altering unrelated users or existing AI budget data.
6. Exercise SIGTERM/SIGINT only on the identified test API process. Confirm child process termination, temporary file cleanup, and ledger terminal/recovery state. Then perform the requested browser checks if browser tooling is available; otherwise mark them unverified. Do not terminate an unidentified existing listener.
7. Restore default-deny and remove only test-created entitlement/usage rows. Recheck unrelated table counts, migration state and resource identities. Retain the pre-change backup; do not delete existing resources.

Phase B完了には、実ローカルJWT認証、専用DB reserve/settlement、SCNet standardのTimeline v1出力、必要な拒否/lifecycle確認、secret漏えいなし、承認済みローカルDB/test設定外への変更なしが必要です。Hosted deploymentは対象外のままです。

## 6. Phase Bの実行と結果

### 6.1 Backupとatomic migration

承認後の読み取り専用preflightで、DB `postgres`、最新migration `20261101001800`、`arvc_audio_analysis`なし、対象table/RPCなしを再確認しました。container/image/volume/network identityも既存の想定ローカルstackのままでした。migration適用直前に新規backupを取得しました。

| File | Bytes | Mode | SHA-256 |
|---|---:|---:|---|
| `/home/raric/arvc-db-backups/step7k47-before-migration.dump` | 484,791 | 600 | `4ed781ab40e6a75a499e27271822eaba2899783543706e59435527c3dc3bef84` |
| `/home/raric/arvc-db-backups/step7k47-globals.sql` | 8,274 | 600 | `28c58710d67b45532da3fc7d1ac764d94f6ed9af6ae2c2335ae6ed50b041b81b` |

backup directory modeは700でした。`pg_restore --list`で新archiveを正常に解析しました（TOC 755行）。これはarchive読み込み確認であり、新たなrestoreテストではありません。019 migrationと`(version,name,statements=NULL)`のhistory挿入を1つのtransactionでatomicに適用し、終了コード0でした。historyには`20261104000100 / step7k42_audio_analysis_quota`が記録され、直前は018です。最初のcommand wrapperは実行を試みた後zshの予約変数代入に当たりました。読み取り専用再確認でschema/historyに変更がないことを確認し、修正したsandbox外commandを正常実行しました。migration fileは変更していません。

### 6.2 Role、ACL、RLS

migrationは最小権限属性で`arvc_audio_analysis`をNOLOGINとして作成しました。最初のローカルinvariant実行では7件中6件成功でした。既存Supabase bootstrapが`supabase_admin`をgrantorとして`ADMIN OPTION`付きでroleを`postgres`へ付与しており、非superuserのpostgres接続からmigration内REVOKEを実行してもbootstrap grantが取り消されなかったためです。該当membershipを確認し、`supabase_admin`で`arvc_audio_analysis FROM postgres`のみをrevokeしました。他membershipは変更していません。その後、権限invariant 7件すべて成功しました。mode 600の一時SQL fileを通じてfresh random passwordでroleをLOGINにし、ローカル`postgres`への`arvc_audio_analysis` TCP loginに成功しました。最終role属性はLOGIN、non-superuser、CREATEDB/CREATEROLE/BYPASSRLSなし、NOINHERIT、membership 0件です。password/DSNは表示/commitせず、test専用一時fileはテスト後に削除しました。

最終確認でも7項目すべて成功しました。制限されたrole、membershipなし、private RPCへのEXECUTE grantは4つのみ、application roleからRPC呼び出し不可、SECURITY DEFINER/fixed search path、FORCE RLS/API roleの直接アクセス拒否、control既定値disabled/zeroを確認しました。

### 6.3 実Auth、HTTP、quota、SCNet

既存8080 listenerをrepo API server PID 7283（`api` working directory）と特定し、停止も置換もしませんでした。独立test Go APIは`127.0.0.1:8081`のみで、process単位の`AI_GENERATION_ENABLED=false`、`PROJECTS_ENABLED=false`、`AUDIO_ANALYSIS_ENABLED=true`、`AUTH_ENV=local`、専用DSNで稼働しました。`api/.env`は変更していません。ローカルAuth設定ではconfirmationなしsignupが可能なため、freshな実GoTrue JWTを得るため一意tag付き一時ローカルuserを3件作成し、tokenはmode 600の一時fileにのみ保持しました。

Observed HTTP cases:

| Case | Result |
|---|---|
| Missing JWT | 401 |
| Invalid JWT | 401 |
| Valid JWT, control disabled/default deny | 503 `analysis_control_unavailable` |
| Valid JWT, control enabled but no entitlement | 403 `analysis_not_entitled` |
| User daily/monthly quota exhausted | 429 `analysis_quota_exceeded` |
| Burst/rate limit exhausted | 429 `analysis_rate_limited` |
| Global kill switch off | 503 `analysis_control_unavailable` |
| Valid JWT + one entitled user + 2-second stereo PCM16 WAV | 200 |

成功HTTP応答には`musicSummary.summaryVersion=1`、`analysis.model=scnet_standard`、`featureTimeline.schemaVersion=1`、duration 2,000ms、feature 200点が含まれました。APIログの解析時間は約5.0秒、合計約5.4秒でした。対応するDB ledger行は`started`を経て`finalized`され、状態`succeeded`でした。ledgerにmedia内容やtokenは保存されません。

同一userの並行性は重複する2リクエストで確認しました。2件目は429 `analysis_busy`を返し、ledgerに行がないことからprocess内slotではなくDB予約段階で拒否されたと分かります。異なるuser間のglobal concurrencyも検証しました。user Aが唯一のglobal slotを保持中にuser Bは同じ429を受け、user Bのusage行は0件でした。解析開始後のclientキャンセル2件（concurrency probeを含む）とSIGTERMキャンセル1件はいずれも`canceled`としてsettleされ、成功リクエスト1件は`succeeded`のままでした。SCNet開始前にuploadをキャンセルした場合は`started_at`なしの`released`になりました。cleanup前のテスト終了時点ではcanceled 4件、released 2件、succeeded 1件で、reserved/running行はありませんでした。

SIGTERM scriptはPID 62474の実行ファイルとport 8081を確認し、DB行が`running`になるまで待ってから、そのtest API processのみsignalしました。HTTPは499で終了し、DB状態は`canceled`としてsettleし、serverは終了しました。既存PID 7283は8080でlistenを継続しました。Python Island/FFprobe子processや`/tmp/arvc-audio-analysis-*` directoryは残りませんでした。browser automation toolがないためブラウザーログイン/Editor操作は実施できませんでした。Frontend単体テストはbrowser E2Eの証拠ではありません。

### 6.4 Cleanupと回帰テスト

tag付き一時Auth user 3件と、それらのusage行7件、entitlement行2件を削除しました。Global controlをmigration既定値（`enabled=false`、全limit 0、`lease_seconds=900`）へ戻しました。最終確認ではtag付きtest user 0件、entitlement 0件、active reservation 0件、最新migration 019、membership 0件のLOGIN role、privilege invariant 7/7成功でした。JWT/password/DSN情報や解析fixtureを含むStep 7k-47一時file 57件をすべて削除しました。freshな変更前backupは保持しました。

Phase Bで完了済みのテスト:

- `go test -count=1 ./internal/audiobudget ./internal/audioanalysis ./internal/authn ./cmd/server` — PASS (all four packages). The first sandbox attempt could not download already-declared dependencies due DNS/network restriction; the same focused tests passed outside sandbox. No dependency manifest changed.
- Python Island `pytest -q tests/test_scnet_separation.py tests/test_cli.py tests/test_audio.py` — 20 passed, including pinned-checkpoint SCNet inference; two upstream PyTorch STFT/ISTFT window warnings.
- Frontend `npm test -- src/audio-analysis.test.ts src/visual-editor.test.tsx` — 49 passed.
- `git diff --check` — PASS.

## 7. 最終状態と残る制約

Migration 019、実ローカルJWT → 専用PostgreSQL quota RPC → Go API → Python Island → SCNet standard → Timeline v1 → 成功settlementまで検証しました。認証/quota拒否、同一userおよびglobal concurrency、開始前release、開始後cancel、SIGTERMキャンセル、cleanup、回帰テストに成功しました。test専用dataは削除し、controlはfail-closedに戻しました。

状態は**部分完了**です。Browser/React EditorへのログインとTimelineの視覚的反映を試しておらず、同一userの複数タブUI動作も確認していません。サンドボックス外で実行したGo全テストは成功しました。Step 7k-47完了のためにlease recoveryを再試験する必要はありません。Step 7k-46で同じPostgreSQL 17.11 image上の変更されていないMigration 019 SQLを使い、実DB leaseのbackdating/recoveryを検証済みです。Step 7k-47ではmigration/function変更はなく、実ローカルreservation、settlement、cancel、fail-closed動作も確認しました。history直接登録の`statements=NULL`行は公式reference上timestampによるCLI forward list/upに対応しますが、この行でのCLI fetch/downは未検証です。rollbackはmigration downではなくbackupからのrestoreです。ローカルroleはLOGINのままですが、一度限りのtest passwordは意図的に保持していません。今後API processで使用する前に管理されたローカルsecretを設定してください。既存`api/.env`は従来設定（AI/Projects flag有効、Audio DSN未設定）のままで、承認済みtest flagはprocess単位のみでした。Hosted/GCPと既存8080 API processには触れていません。

## 8. 残る検証: Go全テスト / Browser Editor E2E

### Go全テスト

サンドボックス内での初回実行:

```bash
GOCACHE=/tmp/arvc-go-cache GOPATH=/tmp/arvc-gopath GOMODCACHE=/tmp/arvc-gomod \
  /usr/local/go/bin/go test -count=1 ./...
```

サンドボックスのpolicyがIPv6 loopback bindを拒否し（`listen tcp6 [::1]:0: socket: operation not permitted`）、`httptest.NewServer`がpanicするまで`internal/service`以外の全packageは成功しました。test assertionの失敗ではありません。サンドボックス外での実行承認後、同じcommandで9 packageすべて（`cmd/server`、`internal/aibudget`、`internal/assets`、`internal/audioanalysis`、`internal/audiobudget`、`internal/authn`、`internal/blueprint`、`internal/projects`、`internal/service`）が成功しました。終了コード0。

### Browser利用可否と観測状態

このsessionではbrowser-control toolを使えず、Chromium/Chrome/Firefox実行ファイルもなく、frontendにPlaywright/Puppeteer packageもありません。そのためBrowser Editor E2Eは実施していません。通常のWSL2で読み取り専用確認したところ、`127.0.0.1:5173`のViteはHTTP 200を返し、既存Go server `127.0.0.1:8080`は`/`にHTTP 500を返しました。8080 processは停止/置換していません。`/`の500はAudio Analyze route固有の結果ではありません。

現在の前提では、追加ローカル設定なしにbrowser Audio Analyzeを成功させられません。`audio_analysis_control`はdisabled/zeroに戻され、entitlementはありません。一時`arvc_audio_analysis` passwordは破棄済みですがroleはLOGINのままです。control再有効化/user entitlement付与とrole password設定はローカルDB/credential変更であり、この残存検証では実施していません。

### 最小限の手動Browser Editor E2E

運用者が専用role用の新secretと、ローカルtest user用の一時entitlement/controlを明示的に用意した後:

1. Keep the existing 8080 API and 5173 Vite processes untouched. In a new API terminal, load `api/.env` using the plain key/value parser from `api/run-local.sh`, then apply process-only overrides: `AUTH_ENV=local`, `AUDIO_ANALYSIS_ENABLED=true`, `AI_GENERATION_ENABLED=false`, `PROJECTS_ENABLED=false`, `API_ADDR=127.0.0.1:8081`, and the dedicated `SUPABASE_AUDIO_ANALYSIS_DSN`. Do not put the DSN in a `VITE_` variable or print it. Start `go run ./cmd/server`.
2. In a separate terminal start a second Vite process without editing `.env`: `ARVC_API_PROXY_TARGET=http://127.0.0.1:8081 npm run dev -- --host 127.0.0.1 --port 5174 --strictPort`.
3. Open `http://127.0.0.1:5174/`, sign in through local Supabase Auth, upload a local WAV/audio file, choose a clip of at most 60 seconds, and run Audio Analyze. Expected: request returns HTTP 200; response has `analysis.model=scnet_standard`, `musicSummary.summaryVersion=1`, and `featureTimeline.schemaVersion=1`; Editor timeline duration and feature tracks reflect the selected clip.
4. Add/select an audio-reactive Effect and bind it to an available Timeline source (for example `bass.envelope` or `drums.energy`). Play/seek the preview. Expected: the source is shown as available and the effect follows playback without triggering a second analysis.
5. Start analysis on a longer clip and press the UI cancel action while processing. Expected: request aborts, UI returns to an interactive state, and DB ledger reaches `canceled` if SCNet had started, or `released` if it had not.
6. Afterward, restore default-deny, remove only the temporary test user's entitlement/usage/auth data, stop only the new 8081 API/5174 Vite processes, and keep the existing 8080/5173 processes running.

これは手動手順のみです。上記browser手順はいずれもPASSとは報告していません。運用者が実施するまで、ユーザー操作、目に見えるEffect応答、browser側cancel連携は未検証です。

## 9. Browser E2E準備（2026-11-04）

後の手動Editor実行に向け、migration、アプリケーションfile、Auth user、AI budget、Projects、Assets、Storageを変更せずにローカル環境を準備しました。

- `postgres`、migration `20261104000100`、専用roleを再確認しました。`arvc_audio_analysis`はLOGIN、non-superuser、`NOBYPASSRLS`です。passwordは表示せず新規設定し、API起動時にDB `Ping`を実施する`audiobudget.NewPostgres`初期化が完了しました。DSNはmode 600の`/tmp/step7k47-browser-dsn`と稼働test process環境のみにあり、Gitや`api/.env`にはありません。
- DBには既存の確認済みローカルemail Auth accountがちょうど1件ありました（報告用識別子`18a85084…`、mask済みemail `d***@example.test`）。password resetはしていません。既存のローカル認証情報を使ってください。準備前のentitlementは0件、controlはdisabled/zeroでした。
- そのaccountのみを対象とする一時entitlementを1件追加しました。有効、日次/月次limit 2、concurrency 1、2時間で期限切れです。singleton controlを有効にし、service日次/月次limit 2、global concurrency 1、60秒あたり2件のrequest windowにしました。leaseは900秒のままです。これにより解析1回とキャンセル試行の可能性を許可します。既存usage行はありませんでした。AI budget行数は10、Projects、Project Assets、Storage objectは0、Auth user件数は1のままでした。
- 最初のquota SQL案はtransaction内のquote構文errorによりCOMMIT前に停止しました。読み取り専用確認で既定状態が変わっていないことを確認しました。その後修正版のguard付きtransactionをcommitし、control/entitlementの正確な値を再確認しました。
- process単位で`AUDIO_ANALYSIS_ENABLED=true`、`AI_GENERATION_ENABLED=false`、`PROJECTS_ENABLED=false`、fixture unlimited無効、専用DSNを設定した独立APIを`127.0.0.1:8081`で起動しました。`/healthz`は200でした。既存`127.0.0.1:8080` API（PID 7283）は稼働状態を維持しました。
- `ARVC_API_PROXY_TARGET=http://127.0.0.1:8081`を設定した独立Vite processを`127.0.0.1:5174`で起動しました。Frontendは200、未認証のproxy経由Audio Analyze requestは401でした。既存Vite `127.0.0.1:5173`（PID 12875）は稼働状態を維持しました。
- Browser-control toolを利用できないため、login、SCNet画面フロー、Effects同期、browser cancelは未テストです。このprocessはaccount passwordを知りません。運用者が完了するまでBrowser E2EをPASSにしないでください。

### E2E後のcleanup

guard付きcleanup SQLを`/tmp/step7k47-browser-cleanup.sql`（mode 600）に準備しました。browser実行後、件数/state guardが引き続き一致する場合にのみ実行してください。

```bash
docker exec -i supabase_db_audio-reactive-visual-compiler \
  psql -U postgres -d postgres -X -v ON_ERROR_STOP=1 \
  < /tmp/step7k47-browser-cleanup.sql
```

これはglobal control行をdisabled/zero limitsに戻し、唯一の既存ローカルAuth userに限ってusageとentitlementを削除します。Auth user、AI budget、Projects、Assets、Storageは削除/編集しません。guardが1つでも失敗したらcleanup対象を広げず停止して調査します。新規8081 APIと5174 Vite sessionのみCtrl+Cで停止し、8080/5173はそのままにします。その後、`/tmp`から一時DSN、launcher、cleanup SQLを削除します。cleanup完了宣言前にcontrol既定値、entitlement 0件、active usageなしを再確認します。一時entitlementにはfallbackとして2時間の有効期限がありますが、期限切れでもglobal control行は無効にならないため、cleanupを明示的に実行してください。


## 10. Browser E2E 502 / Pending調査（読み取り専用）

### 観測したruntime状態

- API PID 184269 remains a child of `go run` PID 184227 on `127.0.0.1:8081`; Vite PID 184983 remains on `127.0.0.1:5174`. Both stdout/stderr are anonymous pipes; no log file is configured. The active process-session buffer yielded no retained request events. Neither process was stopped.
- At the snapshot there was no `python-island`, `python`, or `ffprobe` child and no `/tmp/arvc-audio-analysis-*` directory. Memory was 5.1 GiB / 7.4 GiB, 2.3 GiB available; swap use about 570 MiB. Memory PSI averages were 0. No OOM-kill lines appeared in accessible `dmesg`; cgroup memory event counters were unavailable. This does not rule out a past transient OOM.
- Read-only SQL confirmed control enabled with service daily/monthly 2, concurrency 1, burst 2 / 60 seconds, lease 900. One entitlement was enabled and unexpired. `public.audio_analysis_usage` had zero rows, including no reserved/running/failed/succeeded/canceled rows or leases. The table is in `public`, not `arvc_internal`; RPCs are in `arvc_internal`.
- Zero ledger rows do not match a request that successfully reserved and reached Python, unless rows were subsequently cleaned or a different DB/user was used. This is consistent with failure before admission, rejection before insertion, or cleanup, but does not identify which. No DB state was changed.

### コード経路の事実

- `frontend/vite.config.ts` proxies `/api` to loopback, default 8080; 5174 was configured to proxy to 8081. No Vite `timeout`/`proxyTimeout` is configured. Health 200 and unauthenticated proxy 401 prove reachability only at those probe times.
- `analyzeSelectedAudio()` fully decodes the source with browser `decodeAudioData`, then trims/resamples via `OfflineAudioContext` and encodes PCM16 WAV before calling `fetch`. A 118-second MP3 is decoded in full. Exactly 60 seconds of 44.1 kHz stereo PCM16 is 10,584,044 bytes, below the 16 MiB Go/frontend cap; selection is clamped to at most 60 seconds. A Network entry for POST `analyze` means browser conversion has completed; it can delay when that entry appears but cannot explain a request already pending.
- Go validates JWT, reserves quota, receives the multipart WAV to a mode-600 temp file, probes with ffprobe (20-second command timeout), calls Start, and launches Python. It accepts WAV/PCM16/44.1 kHz/stereo/<=60 seconds, with a 16 MiB body limit. Go server ReadTimeout is 30 seconds; WriteTimeout is unset. Analysis context timeout is 600 seconds.
- Python IslandのFFmpeg decode timeoutは`max(30, duration*2+20)`です（60秒なら140秒）。SCNet standardはrequestごとに固定modelをloadし、20秒chunk、50% overlap、`num_workers=0`、API既定4 threadでCPU推論します。60秒clipは重複する6 chunkを使います。検証済み2秒requestはpadding済み1 chunkを使い、合計約5.4秒でした。Pythonは進捗responseを送らないため、完了/失敗までUIはPendingです。
- timeout/cancel以外でPython子processがnonzero終了するとGoはHTTP 502 `analysis_failed`を返します。子processが正常終了しても出力が欠落/不正/不整合なら502 `invalid_analysis_output`を返します。Python exit/signalと経過時間はログに記録しますが、stdout/stderrは破棄され、診断情報が失われます。Vite upstream failure/resetもproxy 502を起こす場合があります。health probe成功でも一時障害は除外できません。UIは502を含むその他statusを共通の一般エラーメッセージに対応付けます。
- 5分時点ではGoの600秒deadlineに達していません。Frontendにはclient timerがなく、fetchはresponseを待ち、AbortControllerはUI/user lifecycle時のみ発火します。接続継続中のrequestは600秒で504 `analysis_timeout`を返す想定で、それ以前のcancelはキャンセル経路になります。5分Pendingは恒久停止の証明ではありません。
- Go ReadTimeoutはrequest読み込みを対象とします。遅い/停止した約10.6 MiB uploadはPython実行前の`receive_audio`で失敗する可能性があります。実際のupload長/速度は取得されていません。これはPython失敗や長時間推論とは異なる経路です。
- Quota拒否は通常403/429/503であり、502ではありません。Handlerは安全なstatusと経過時間、Python失敗分類/exit/signal/audio byte数を記録しますが、logは永続化されません。request固有log eventは入手できませんでした。

### 診断と残る不確実性

**確認済み:** APIは最大10分待機し、browserには独自timeoutがなく、60秒SCNet処理は検証済み2秒ケースより大幅に重く、APIが生成する502経路は2種類あります。Python診断出力は破棄されます。現在のsnapshotではDB設定正常、有効entitlement 1件、usage行なし、Python子processなし、一時directoryなしでした。OOMは確認されていません。

**未確認:** 502が`analysis_failed`、`invalid_analysis_output`、Vite/upstreamのいずれか、POSTがこのAPI/DBに届いたか、Python exit/signal/stage、payload byte数/長さ、SCNet load/inference時間、過去のピークRSS/OOM、Pendingが推論・upload・upstream応答喪失のどれか。以前の6.1/7.4 GiBとswap 571 MiBのsnapshotはOOMの証拠ではありません。現在のmemory PSIは0でした。

### 最小限の次回観測と再検証（未実行）

capture準備が整うまで解析を再送しないでください。明示的に承認したrequest 1件について、Chrome Network statusとresponse `error.code`、duration/payload byte数、API request-finished status/content_length/elapsed_ms、Python分類/exit/signal、ledger集計件数の前後のみ記録します。HARをexportせず、Authorization header、user ID、audio、DSN、response tokenも記録しないでください。必要なら、上限付き/秘匿化Python stderrとphase timingを取得する最小診断コード変更をレビューしますが、ここではコード変更していません。5分時点でPendingのrequestは、API eventが約600秒で504終了するのか、process終了時だけかを確認し、安全なledger状態と照合します。8081/5174を維持し、現時点で解析を再実行しないでください。

error codeが`analysis_failed`ならexit/signalを照合し、制御された追跡調査に限って上限付き/秘匿化Python stderrからdecode/checkpoint/model/OOMを特定します。`invalid_analysis_output`なら一時file cleanup前に検証段階と生成metadataを調べます。API JSON error codeも対応API eventもなければVite/upstreamを調査します。APIが約600秒で504を返した場合はresourceやtimeout変更を提案する前にphase timing/RSSを測定します。測定なしにtimeoutやmemory limitを引き上げないでください。

## 11. API quota-store起動失敗（DB読み取り専用、2026-11-04）

従来の一般的な`audio analysis quota store initialization failed`メッセージでは、config parsing、pool作成、DB Pingのどこで失敗したか分かりませんでした。`NewPostgres`はdriver原因を捨てて`ErrUnavailable`のみを返していました。stage、class、SQLSTATEのみを含み、元driver messageやDSNを決して記録しない安全な起動診断を追加しました。sandboxでの起動は`stage=ping cause=network`となり、sandbox network隔離と整合します。同じ`.env`設定を通常WSLで試すと`stage=ping cause=postgres sqlstate=28P01`で、PostgreSQLのpassword認証失敗でした。

`.env`内DSNのhost/port/database/usernameとURL形式は正しく、local `127.0.0.1:54322`、database `postgres`、user `arvc_audio_analysis`、`sslmode=disable`でした。値を出力しないprocess内比較により、decode後passwordが以前のローカルrole接続成功に使用した保護DSNと異なることが判明しました。最後に動作確認済みの一時DSNでAPIを起動すると`NewPostgres` Pingを通過し、`API server starting`まで進み、8082の`/healthz`は200でした。DB role password、schema、quota、migration、`.env`値は変更していません。

`api/run-local.sh`も修正し、`.env`読み込み後も空でないprocess単位の`API_ADDR`と`SUPABASE_AUDIO_ANALYSIS_DSN`上書きを維持します。現在`.env`の`API_ADDR=127.0.0.1:8080`が呼び出し元の8081指定を上書きしてしまうため必要です。修正版scriptをmode 600の保護一時fileから読み込んだ明示DSNと、process flag `AUDIO_ANALYSIS_ENABLED=true`、`AI_GENERATION_ENABLED=false`、`PROJECTS_ENABLED=false`で実行し、APIは8081で起動、`/healthz`は200を返しました。このinstanceは現在も8081（PID 226470）で稼働中です。最終snapshotでは8080と5173はlistenしておらず、既存Vite 5174（PID 212703）は稼働中でした。Audio Analyze requestは送信していません。

検証: `go test ./internal/audiobudget ./cmd/server`成功、`bash -n api/run-local.sh`と`git diff --check`成功。ユーザーの`.env`には不一致のDSN passwordが残っていますが、credential変更禁止の制約により意図的に触れていません。現在の8081 processを停止後、運用者が`.env`またはprocess overrideで正しい専用role DSNを渡すまでは、`API_ADDR=... AUDIO_ANALYSIS_ENABLED=true ./run-local.sh`だけで再起動しても失敗します。現在のprocessは保護一時DSNを使用しており、DB credential変更は不要です。

## 12. `28P01`の再確認: 実効DSN、pg_hba、server log（読み取り専用）

現在process環境に`SUPABASE_AUDIO_ANALYSIS_DSN`上書きはありませんでした。`run-local.sh`は`.env`値を変更せず（末尾CRのみ除去）コピーするため、実効値は設定DSNとbyte単位で同一です。同じ既存`pgx/v5`driverを使うGo診断で、実効targetは`127.0.0.1:54322`、database `postgres`、role `arvc_audio_analysis`、`sslmode=disable`と解析されました。parseは成功し、URI passwordのpercent-escape形式も有効でした。同じdriverのPingはSQLSTATE `28P01`で失敗しました。生DSN、password、password由来hashは表示していません。

DBコンテナはhost loopback port 54322をcontainer port 5432へmapします。networkは`arvc-supabase-loopback`（container `172.19.0.6`、gateway `172.19.0.1`）です。読み取り専用`pg_hba_file_rules`では次を確認しました。

- local Unix socket: `supabase_admin` uses `trust`; other roles use `peer`.
- host `127.0.0.1` and `::1`: `trust` (HBA lines 87-88).
- host `172.16.0.0/12`: `scram-sha-256` (HBA line 92), followed by wider private/public rules also using SCRAM.

したがってcontainer Unix socketまたは`-h 127.0.0.1`経由の内部`psql`テストでは専用role passwordを検証できません。該当接続方式は`peer`/`trust`です。公開portに到達するWSL clientはDocker network経由で転送され、失敗したserver接続はHBA line 92の`scram-sha-256`に該当しました。読み取り専用PostgreSQL logにはSCRAMに関する最近のpassword認証失敗が11件あり、最新は`2026-11-04T09:56:28Z`でline 92に一致しました。passwordや生log lineは出力していません。最初のSQLSTATEと一致したSCRAM ruleから、host requestがこのPostgreSQL containerに到達し、Goが提示したpasswordが拒否されたと分かります。

`.env` DSN target/userは正しく、pgxはpercent escapeを解析できています。DSN parse errorやDB port誤りではありません。secretを露出しない比較で、decode後passwordが以前検証済みの専用role DSNと異なることが分かりました。したがって直接原因はURI decode後のpassword値不一致（古い/誤った値、または意図したpasswordのencoding誤り）です。内部`trust`/`peer`テストでcontainer側認証が成功して見えた理由も説明できます。DB role/password、HBA、schema、quota、migrationは変更せず、API/Frontend/Supabase process停止や解析も行っていません。最小修正は運用者が現在のrole passwordを正しくURI-percent-encodeして`.env`に設定するか、有効DSNをprocess overrideとして渡すことです。client側不一致に合わせてDB role passwordをresetしないでください。

## 13. Browser `write ECONNRESET`追跡調査（読み取り専用）

### 収集した証拠

- 現在のlistenerは8081のAPI PID 246634と5174のVite PID 250201でした。どちらも停止していません。stdout/stderrはそれぞれ`/dev/pts/19`と`/dev/pts/12`に接続されていました。以前のVite session出力には`http proxy error` / `ECONNRESET`が5件ありましたが、request別timestamp、size、response code、対応API eventは保持されていません。Analyze requestは送信していません。
- 読み取り専用DB調査ではsingleton control有効（service daily/monthly 2、global concurrency 1、60秒あたりburst 2、lease 900秒）、`expires_at`が`2026-11-04 10:02:37 UTC`の有効entitlement 1件、`public.audio_analysis_usage`行なしでした。query時刻`2026-11-04 10:28:24 UTC`には、そのentitlementは約25分47秒前に期限切れでした。DB状態は時間依存であり、それ以前の各browser試行時点の状態を示すものではありません。
- Frontendは44-byte headerの44.1 kHzステレオPCM16 WAVを生成し、clipを60秒に制限します。正確に60秒の場合のWAV byte数は`44 + 60 * 44100 * 2 * 2 = 10,584,044`（約10.1 MiB）で、multipart framingと小さなform field分が加わります。FrontendとGoはいずれも最大16 MiBで制限するため、通常の60秒payloadは上限未満です。既存Go testでも同じWAVサイズとmultipart bodyが上限未満であることを個別にassertします。browserで観測した`Content-Length`はありません。
- Go handlerの順序はJWT認証 → `Admission.Reserve` → slot/content-type確認 → private一時fileへのbody読み込みです。entitlementが欠落、無効、期限切れの場合、handlerがmultipart bodyを読む前にMigration 019のreserve RPCが拒否し、HTTP 403になります。期限切れentitlementとusage 0行はこの経路に整合しますが、requestと相関するAPI eventがないため、特定browser試行がこの経路だった証明ではありません。
- Go server設定は`ReadTimeout=30s`、音声解析processing context timeoutは600秒です。Vite proxyには`timeout`も`proxyTimeout`も設定されていません。そのため遅いrequest-body uploadはGo read deadlineに達する可能性があります。5分Pendingだけでは600秒processing deadline到達を意味しません。
- Go 1.27.3 HTTP/1 server sourceでは`maxPostHandlerReadBytes=256 KiB`です。handlerがこれより大きいrequest bodyを読み切らずにreturnすると、serverはupload全体をdrainせず、connectionを再利用不可にしてresponse後に閉じます。Viteはbrowser requestをupstreamへstreamするため、Viteが約10.6 MBのbodyを書き込み中にGoが早期拒否すると、Viteで`write ECONNRESET`が発生する場合があります。このerrorはupstreamのwrite/resetを示しますが、それだけではquota早期拒否、read timeout、その他upstream切断を区別できません。

### 評価

**観測した期限後のbrowser試行で最も有力な原因:** entitlementが期限切れだったため、Goのquota予約はbody読み込み前に403を返しました。Goはmultipart bodyの大部分が未読のままconnectionを閉じ、転送中のViteが`write ECONNRESET`を記録したと考えられます。観測DB状態とhandler/server codeに裏付けられた有力な機序ですが、旧logに対応API eventがないためrequestと相関する証拠ではありません。

**別の原因候補:** APIの30秒`ReadTimeout`を超えるbody uploadによりupstream requestが閉じる/resetする可能性があります。失敗したbrowser requestの実Content-Length、upload所要時間、Go read-timeout logは取得されていません。通常の60秒browser WAVでは計算/テスト済みpayloadが16 MiB未満のため、サイズ超過の可能性は低いです。browser decode/resamplingは`fetch`前に行われるためNetwork entry出現を遅らせる場合がありますが、POST開始後の`write ECONNRESET`をそれ自体で説明できません。

APIのPython `analysis_failed`および`invalid_analysis_output` 502経路はrequest body受信後に発生し、Vite upstream write resetとは別です。現在の証拠ではbrowser requestがPythonやSCNetに到達したことを示していません。以前の2秒end-to-end成功は、期限切れentitlementや60秒upload経路の検証ではありません。

### 最小限の次回検証（未実施）

次のbrowser試行前に、運用者はローカルtest user 1名のentitlementがtest期間中有効かつ期限内であり、global controlが有効であることを確保し、読み取り専用で状態を検証します。その後、明示的に承認されたtest requestを1件だけ実施し、DevTools request Content-Lengthとupload/全体時間（HARやheaderをexportしない）、Vite error timestamp、APIの安全なclassification/stage/status/content_length/elapsed、ledger件数の前後のみ記録します。JWT、email、DSN、passwordは記録しません。時刻の一致する403 `analysis_not_entitled`は早期拒否経路を確認します。約30秒での`receive_audio`失敗はGo read-timeout経路を支持し、受信成功後のPython-stage logなら推論経路を示します。いずれかの経路を測定するまでrequest limitやtimeoutを変更しないでください。

この追跡調査ではcode、database、credential、quota、migration、service状態を変更していません。`write ECONNRESET`の根本原因は有力ですが、特定requestとの相関は確定していません。

## 14. 上限付き早期拒否body処理とproxy再現

### 原因の証拠

Vite/API request eventが保持されていないため、過去の該当browser requestは依然相関確認されていません。疑われた機序を、5173/8080に触れずDBデータも使わない隔離loopback設定で再現しました。

- 変更前は使い捨てAPIが10 MiB multipart bodyを読み込まずに即時403を返しました。Vite経由では10,485,968 bytes中1,966,080 bytesのupload後にclientは502を受信し、Viteは`write ECONNRESET`を記録しました。
- 変更後はfake `ErrNotEntitled` admission storeとtest専用auth middlewareで実`audioanalysis.Handler`を実行しました。同じrequestはViteを最後まで通過し、HTTP 403 `analysis_not_entitled`を返しました。Vite processにproxy errorは出ませんでした。

これは早期403/未読body機序を確認し、この再現ケースでは主仮説を支持します。ただし過去の特定browser試行でentitlementが期限切れだった証明ではありません。実際に遅いuploadでは30秒`ReadTimeout`も独立した原因候補として残りますが、今回の高速なローカルloopback再現には関与していません。

### 最小変更

`api/internal/audioanalysis/handler.go`はJWT middlewareがrequestを認証し、`Reserve`が`ErrNotEntitled`を返した場合に限りrequest bodyをdrainするようになりました。申告bodyが16 MiB超ならdrainせず、それ以外は`http.MaxBytesReader`で読み込みを16 MiBに制限します。認証は引き続きこの処理より前、reservationはbody処理より前で、entitlement拒否は403のままです。拒否時にusageをreserve/start/settleしません。entitlement、quota、credential、migration、timeout、proxy設定、API response形式、依存関係は変更していません。

回帰テストでは認証済み10 MiB拒否時に403前にbodyをdrainすること、申告サイズ超過bodyをdrainしないことを確認します。既存のreservation前未認証拒否、413、cancel、fail-closed、quota lifecycleテストも全suiteに残っています。

### 検証

- 実合成ステレオPCM16 WAVをGo handler → Python Island → ローカルSCNet standardに通し、Timeline v1、duration 2,000ms、200点を含むHTTP 200を返しました。この実行では既存統合testのfake auth/admissionを使用しており、以前のStep 7k-47実JWT/DB HTTP結果の代わりにはなりません。
- Vite変更前後の再現: 10 MiBの早期403は変更前に502/`ECONNRESET`となりました。変更後のproduction handlerは全upload後に403を返し、proxy errorは発生しませんでした。
- loopback test bindを有効にした`GOCACHE=/tmp/step7k47-gocache go test ./... -count=1`はGo 9 packageすべて成功しました。権限なしの実行はサンドボックスsocket制限による既存`httptest.NewServer` IPv6 bind失敗であり、code failureは示していません。
- 保護DSNによるDB再確認はこの実行環境で接続できませんでした。query結果、entitlement変更、quota消費はありません。5173/8080は停止/変更せず、一時再現process/fileは削除しました。

**状態: 部分完了。** 原因機序を再現し、Vite経由で上限付き修正を検証しました。Go回帰テストと実SCNet/Timeline出力も成功しました。現在の実DB entitlement状態、期限切れにより403を返す実JWT request、browser EditorでのTimeline反映は今回再確認できませんでした。対象外変更はありません。

## 15. 最終runtime/DB再確認と承認済みcleanup（2026-11-04）

### Section 14のソースと回帰確認

上限付き`ErrNotEntitled` body drainと2件の回帰testは作業中sourceに残っています。`GOCACHE=/tmp/step7k47-final-gocache go test ./... -count=1`は9 packageすべて成功しました。実ローカルPython Island → SCNet standard統合testも再度成功し、合成2秒ステレオPCM16 WAVに対してTimeline v1、200点を含むHTTP 200を返しました。この統合fixtureはfake auth/admissionを使いquotaを消費しません。

### APIと専用roleの接続

2026-11-04 10:49 UTC時点で8081 `/healthz`および5174 `/`への接続は失敗しました。この実行環境ではどちらのtest processも稼働していませんでした。現在のsourceにはSection 14変更が含まれ、成功したGo testでcompile済みです。5173と8080は停止/変更していません。

既存ローカルSupabase containerではPostgreSQL 17.11が稼働中でした。秘匿化`pgx`診断は保護test DSNを`127.0.0.1:54322`と解析しPostgreSQLへ到達しましたが、SQLSTATE `28P01`が返りました。DSN/passwordは表示していません。読み取り専用role flagでは`arvc_audio_analysis`がLOGIN、非superuser、CREATEDB/CREATEROLE/BYPASSRLSなし、期限切れ`rolvaliduntil`なしでした。したがって現在提供されたDSN passwordは拒否されていますが、role自体は存在し制限状態です。password、role、privilege、schemaは変更していません。このため利用可能なsecretではDB接続する8081 APIを起動できません。

### ローカルtest fixtureの復元

cleanup前の読み取り専用queryで、状態が既存Section 9 guardに一致することを確認しました。ローカルAuth user 1件、期限切れentitlement 1件、control有効（service daily/monthly 2、concurrency 1、60秒あたりburst 2）、usage 0行でした。既存の`/tmp/step7k47-browser-cleanup.sql`を変更せずローカルDB container経由で実行し、commitしました。2回目の読み取り専用queryではcontrol無効、全limit 0、lease 900秒、entitlement 0件、usage 0件、Auth userは残存を確認しました。保護DSN、cleanup SQL、launcher、本turnの診断/cache fileを削除しました。このcleanupやSCNet統合testでquotaは消費していません。

### 残る必要情報

要求された実JWT + 専用DB + SCNet HTTP検証は、利用可能な専用role DSNが`28P01`で拒否され、この実行環境で有効なローカルAuth session/JWTも得られなかったため実施できませんでした。要求どおりDBはdefault-denyへ戻しています。実403/200ケースには、既存の有効role DSNと、確立済みSection 9手順に沿った別途認可済みローカルtest entitlement期間が必要です。不足secretを補うためにDB role passwordをresetしたりquotaを有効化したりしないでください。承認済みローカルsecret/auth経路から情報が提供されるまでは、期限切れによる403、port 5174経由entitlement付き200/Timeline、browser Editor反映は**部分完了**です。本番、Hosted、GCP、5173、8080への操作はありません。

## 16. 承認済みcredential再発行と実Vite/API/DB/SCNet受け入れ確認

### preflightと対象範囲

読み取り専用preflightで承認済み既存targetが一致しました。container `supabase_db_audio-reactive-visual-compiler`、image `public.ecr.aws/supabase/postgres:17.11.0.006` / image ID `sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`、named volume `supabase_db_audio-reactive-visual-compiler`、network `arvc-supabase-loopback`、公開loopback port 54322のdatabase `postgres`です。PostgreSQL 17.11、最新Migration 019（`20261104000100`）、想定専用roleが存在し、controlはdefault-deny、entitlement/usage件数0でした。既存Auth user 1件は維持しました。既存Step 7k-47 dump/globals fileはmode 600のままで、SHA-256はSection 6と一致しました。backupのrestore、変更、削除はありません。

preflight時点で以前の8081 Go processはSection 14 source変更前に起動していたため、修正の証拠として認めませんでした。以前の5174 Vite processは`0.0.0.0`にbindしていました。両方ともrepo working directory、command、PID/parent、所有portで識別し、該当2つのtest process groupのみ中断しました。8080と5173にはsignal/停止/変更をしていません（preflight時にlistener応答なし）。

### 専用role passwordと隔離service

ユーザーはローカル`arvc_audio_analysis`に限るpassword再発行を明示的に許可しました。暗号学的に安全な48-byte secretをmode 700 directory内のmode 600 fileに書き込みました。`psql \password arvc_audio_analysis`はstdinから読み取り、secret、verifier、DSN、JWTは表示せずcommand-line argumentにも渡しませんでした。URL-encoded DSNは保護一時fileとAPI process環境経由のみで渡し、`api/.env`は編集していません。

Section 14を含む現行API sourceを`127.0.0.1:8081`で起動し、`AUDIO_ANALYSIS_ENABLED=true`、`AI_GENERATION_ENABLED=false`、`PROJECTS_ENABLED=false`を設定しました。実TCP DB Pingを行う`audiobudget.NewPostgres`が完了した後にのみstartupが`API server starting`まで進み、`/healthz`は200でした。Viteはloopback `127.0.0.1:5174`で起動し8081へproxyしました。専用roleはLOGIN、non-superuser、CREATEDB/CREATEROLE/BYPASSRLSなし、NOINHERIT、membershipなし、期限切れなしを維持しました。password rotation後も既存の読み取り専用ACL/RLS/fixed-search-path/default-deny 7項目検証は7/7成功し、role変更がpasswordのみであることを確認しました。

以前のAuth accountのlogin sessionは利用できませんでした。ユーザー指示に従い、既存userのpasswordは変えず、local Auth signupで一意tag付きローカルAuth userを1件作成しました。生成passwordと実JWTはmode 700一時directory内のmode 600 fileにのみ保持しました。

### 実proxyケース

| リクエスト | 結果 |
|---|---|
| Missing JWT through Vite | HTTP 401 `unauthorized` |
| Expired enabled entitlement + 60-second stereo PCM16 WAV (10,584,044 bytes) through Vite | HTTP 403 `analysis_not_entitled`; multipart Content-Length 10,584,228; API elapsed 34 ms |
| Active test entitlement + 2-second WAV through Vite → Go → PostgreSQL → Python Island → SCNet standard | HTTP 200; Timeline v1, 2,000 ms, 200 points; WAV 352,844 bytes |
| Same active entitlement + 60-second WAV through the full stack | HTTP 200; Timeline v1, 60,000 ms, 6,000 points; WAV 10,584,044 bytes; API analysis 36.5 seconds |

期限切れ403、2秒成功、60秒成功のいずれでもViteは`http proxy error`や`write ECONNRESET`を出しませんでした。期限切れ拒否試行ではusage行は作成されませんでした。2つの成功後の読み取り専用ledger調査では新規test userの`succeeded`行が正確に2件、active leaseなし、既存userのusageなしでした。

### 回帰テスト

- `GOCACHE=/tmp/step7k47-accept-cache go test ./... -count=1` — all 9 Go packages PASS, including handler 401/413, cancellation, quota lifecycle and Section 14 bounded-drain tests.
- `npm test -- src/audio-analysis.test.ts src/visual-editor.test.tsx` — 49 tests PASS.
- Database privilege/RLS/default-deny invariants — 7/7 PASS.
- `git diff --check` — PASS.

### cleanupと最終状態

明示的cleanup transactionでは元Auth user件数、一意tag付きtest user、一時control/entitlementの正確なlimit、成功usageちょうど2件、他user usageなし、active leaseなしをguardしました。この実行で作成したusage 2行、entitlement、新Auth userのみ削除し、controlを`enabled=false`、quota/concurrency/burst limitすべて0、lease 900に戻し、元Auth user 1件が残ることをassertしました。最終読み取り専用確認では最新migration 019、専用role属性/membership不変、Auth user 1件、tag付きtest user 0件、entitlement 0件、usage/active lease 0件、default-deny controlを確認しました。既存backupとhashは変更されていません。

検証後に8081 APIと5174 Vite sessionを停止しました。password、DSN、Auth password/JWT、user ID、guarded SQLを含むmode 700一時directoryとGo cacheを削除しました。8080/5173には触れていません。schema、migration、role privilege、認証方式、依存関係、API契約、Hosted/GCP、本番状態に変更はありません。

**状態: browser UIのみ部分完了。** Chromium/Chrome/Firefox、Playwright、Puppeteer、browser-control toolを利用できず、Editor上のTimeline視覚反映は試していません。60秒WAVを含む、必要な実JWT/DB/Vite/SCNetの期限切れ403と通常200受け入れ確認はproxy resetなしで完了しました。過去のbrowser障害そのものは元request logが保持されていませんが、疑われた機序を再現し、修正経路を実handlerとproxyで検証しました。

## 17. 5173のrefusalと5174のresetは別障害（2026-11-04）

### 新たな観察結果

- 通常browserの`127.0.0.1:5173`でAudio Analyzeを試した際、Viteは`connect ECONNREFUSED 127.0.0.1:8080`を記録しました（ユーザー提供の観察）。このrequestでViteは8080へのupstream TCP接続を確立できなかったという意味です。
- 独立browser試行ではVite `5174`経由でGo API `8081`へ接続し`ECONNRESET`となりました。秘匿化filter logには`2026-11-04T12:39:55.519295Z` / `12:39:55.520224Z`時点の`/api/v1/audio/analyze` `proxy_error`と安全分類`ECONNRESET`が記録されています。対応するAPI logには`12:29:27.825144Z`のstartup entryしかなく、この試行の`request received`/`request finished` eventはありません。API filter counterはstartupの1 event、Viteは安全なerror eventを2件記録しました。したがって、このrequestは現行APIのAudio Analyze route loggerに到達していません。そのloggerはJWT検証前なので、JWT検証、quota予約、Python、SCNetを原因とする証拠ではありません。Vite filter項目だけではresetがupstream connect/write/readのどこで発生したか、中間network/process eventの有無は確定できません。
- これらの結果を一緒に扱わないでください。`5173 → 8080 ECONNREFUSED`と`5174 → 8081 ECONNRESET`はupstream endpointもfailure modeも異なります。

### Step 46/47の設定・起動比較

- Step 46報告書は通常Editorのport 5173とAPI port 8080からのHTTP応答を記録していますが、API logと相関したAudio Analyze browser requestや正確なAPI起動commandは記録していません。Step 46でbrowser解析が動作したというユーザーの説明は履歴情報として残し、同報告書のHTTP checkから推測したものではありません。
- Step 46当時のcommit/default Vite proxy targetは`http://127.0.0.1:8080`でした。現在の`frontend/vite.config.ts`も既定8080です。Step 7k-38では任意のloopback限定`ARVC_API_PROXY_TARGET`を追加し、Section 16では独立5174 test serverを8081へ向けるために使いました。通常5173の既定値が8081に変わった証拠はありません。
- 文書化された通常API起動方法は`cd api && ./run-local.sh`で、`go run ./cmd/server`を実行します。`API_ADDR`または`PORT`で別addressを選ばない限り、APIは`127.0.0.1:8080`が既定です。Step 7k-47 Section 11では、`.env`読み込み後に空でないprocess単位`API_ADDR`と専用DSN overrideを維持するよう`run-local.sh`を変更しました。これは隔離port 8081起動に必要な動作ですが、それ自体でAPI listenerを起動するわけではありません。Section 16はtest APIを明示的に8081で起動し、受け入れ確認後に停止しました。8080には触れていません。Section 16 preflight時に8080はlistener応答がありませんでした。現在ローカル`.env`を読み取ると`API_ADDR=127.0.0.1:8081`でした（DSNは表示せず）。通常APIが8080で起動されていなければ、これは観測された5173→8080拒否と整合します。これはローカル起動/port不一致であり、JWTやquotaの失敗ではありません。
- 現時点の証拠では、5173試行の正確な時点にユーザー報告の通常APIがなぜ不在だったか、Step 46の正確な起動commandは分かりません。この追跡調査でprocessを起動/停止していません。8080/5173は保護対象のままです。

### 診断と対応

`5173 → 8080 ECONNREFUSED`の原因は接続層で特定されました。8080でViteのupstream接続を受け付けるAPIがありませんでした。Step 47隔離APIが8081で稼働していても、Vite instanceのtargetを8081に設定しない限り、変更されていない通常Vite proxyの要求には応答できません。運用者が次回通常ローカルstackを起動するときにAPI listen addressとVite proxy targetを一致させてください。この読み取り専用調査の一環として稼働processを変更しないでください。

5174 resetはAPI Audio Analyze routeより下流で未特定です。Go route logに記録がないため、相関したfilter-log事象の原因としてhandler-level JWT、entitlement/quota、request-body parsing、SCNetは除外できますが、transportが正確にどこで閉じたかは不明です。Section 14の早期拒否再現は制御されたtestに対して有効ですが、Go route eventまたはより詳しい安全なproxy-stage証拠がなければ、この実5174事象の原因とは特定できません。したがってこの観察に基づいてtimeout、proxy、認証、quota、handlerをさらに変更する根拠はありません。

code、DB、credential、quota、依存関係、process、portは変更していません。code変更の根拠がなく、Section 16の認証済みHTTP/SCNet受け入れ結果が既存回帰証拠として利用できるため、testを再実行していません。5173 upstream拒否の診断は完了しましたが、5174の正確なreset箇所とStep 46当時の起動commandは未解決です。Browser Editor/Timelineの視覚的受け入れは部分完了です。

## 18. 相関確認されたbrowser request: Audio Analyze前のCORS早期拒否（2026-11-04）

### 復元した観察結果と原因

異常終了前、browser 2秒request 1件を安全なVite/Go stage log間で相関確認しました。`2026-11-04T13:41:53Z`のrequest `152ec3e5-c398-4a2b-8cc3-970bb9ddb0b3`のmultipart Content-Lengthは336,571 bytesでした。Viteはheader受信、upstream request生成、7msでのTCP接続を記録しました。Goは接続とHTTP headerを受け付けた後、body未読のまま74-byte responseで403を返しました。Go handlerは`body_bytes=0`、`body_terminal=not_read`を記録し、connectionは閉じました。Audio Analyze route/auth/quota eventはありません。Viteは403 responseを記録しましたが、browser request body完了やupstream request write完了を記録していません。対応するbrowser症状は`net::ERR_CONNECTION_RESET`でした。

具体的な拒否条件はbrowserの`Origin`です。ページは`http://172.25.179.49:5174`から配信されていましたが、APIのglobal CORS middlewareはlocal originとして`http://127.0.0.1:5173`と`http://localhost:5173`のみ許可します。Vite HTTP proxyはbrowser OriginをGoへ転送しました。そのためmiddlewareはAudio Analyze route登録/実行前に`cors_origin_denied`を返しました。これにより最初の拒否層が特定され、この相関requestの403原因からJWT、entitlement/quota、multipart解析、ReadTimeout、SCNetを除外できます。336,571-byte bodyはGo HTTP/1の256 KiB post-handler drain許容量を超えており、Goはupload未読のままconnectionを閉じました。これがproxy uploadの中断とreset症状を説明します。このrequestはhandlerに入っていないため、Section 14の上限付きhandler drainは適用されません。

Section 16のcurl成功requestにはbrowser Originがなく、このCORS条件を検証していません。別件の`5173 → 8080 ECONNREFUSED`は引き続き異なる起動/target障害であり、この調査結果によって変わりません。

### 最小修正と回帰確認

`frontend/vite.config.ts`ではローカルVite-to-loopback API proxy requestに限ってbrowser `Origin` headerのみ除去します。browser requestはViteと引き続きsame-originで、Authorizationおよびmultipart headerは保持します。Go/API動作、CORS allowlist、認証、quota、公開契約、依存関係、DB state意味論は変更していません。`ARVC_API_PROXY_TARGET`はHTTP loopback originに制限し、ローカルtargetが意図せずremote hostにならないようにします。

`frontend/src/vite-proxy.test.ts`を追加し、proxyがAuthorizationとmultipart Content-Typeを保持しつつOriginを除去することをassertします。terminal異常終了前に、proxy callback test setupを修正後、対象Frontend回帰testは3 file、50件成功し、`npm run typecheck`も成功しました。サンドボックスのIPv6 bind制限後、承認済みsandbox外local-test実行でGo全9 packageが成功しました。この修正ではGo sourceを変更していません。対象Frontend fileの`git diff --check`も成功しました。

### 現在の受け入れ確認とcleanup状態

terminal異常終了によりVite診断log directoryと保護された変更前fixture snapshotは削除されましたが、上記request証拠はsession記録に残っています。異常終了後の読み取り専用調査では8081/5174/8080/5173 listenerなし、ローカルAuth user 1件、有効かつ期限内test entitlement 1件、usage 0行、control有効（日次/月次limit 10、concurrency 1、request window 3/60秒、lease 900）でした。Auth healthは200、Migration 019が引き続き最新でした。このDB値は既承認fixtureと一致したため重複更新していません。既存ローカルSupabase containerは稼働中です。

ユーザーがローカル専用role passwordの再発行を明示的に許可した後、ローカルDB container経由で既存`arvc_audio_analysis` role passwordのみ変更しました。LOGIN/non-superuser/no-createdb/no-createrole/no-bypassrls/NOINHERIT属性とmembership 0件は不変と確認しました。生成credentialとDSNはmode 0700の`/tmp` directory内mode 0600 fileのみに保存し、log、報告書、Gitには含めていません。その後、現行Go sourceを`127.0.0.1:8081`で起動し、実Postgres Pingに成功、`/healthz`は200でした。Viteは`0.0.0.0:5174`で稼働し、`127.0.0.1:8081`のみへproxyします。Vite index、WSL2-IP index、最適化React moduleはいずれも200を返しました。`Origin: http://172.25.179.49:5174`を含む空の未認証multipart POST 1件は401でした。相関する安全logではViteのbody完了、TCP接続、request write、response完了を示し、Go Audio Analyze handlerは401を記録しました。usageは作成されませんでした。この結果はpatch済みproxyがOriginを除去してrequestをJWT middlewareに届けることを確認します。

認証済みbrowser request、目に見えるTimeline/Effect同期、browser 60秒request、cancel flow、guard付き復元/cleanupは未完了です。以前のSection 16 API/SCNet確認、今回の未認証proxy確認、proxy単体testをbrowser受け入れ確認と見なさないでください。人によるEditor受け入れ報告まで承認済みfixtureを変更せず、その後guard付きcleanupを実施し、test processと一時secret/log fileのみ削除します。

**状態: 部分完了。** 相関確認された拒否原因と最小proxy修正を確定し、自動テストと修正後のVite-to-Go routing確認に成功しました。人によるbrowser受け入れ確認とfixture cleanupは未完了です。

## 19. 修正後60秒browser reset: Vite proxy header変更によるクラッシュ（2026-11-04）

### 相関確認された障害

ユーザー報告の118.05秒sourceと0〜60秒選択範囲について、private Vite stage logは`2026-11-04T14:16:29.866Z`に`Content-Length=10,584,359`のbrowser multipart POSTを記録しました。Section 18とは別requestです。Viteには到達しましたが、唯一のstage eventは`vite_incoming_headers`で、proxy request event、TCP接続event、body完了、response eventはありませんでした。対応Go logにrequest received/finished entryはなく、読み取り専用DB調査ではusage 0行（entitlement付きuser 1名、global control有効）でした。したがってrequestはGo、JWT、quota admission、body処理、SCNetには到達していません。

同時刻のVite process logにはNode.js exception `ERR_HTTP_HEADERS_SENT: Cannot remove headers after they are sent to the client`があります。stackは診断proxyの`proxyReq` listener内にある`proxyReq.removeHeader('origin')`を示しています。Vite同梱HTTP proxyはoutgoing ClientRequestの`socket` eventから`proxyReq`を発火しますが、その時点でNodeがrequest headerを既にflushしている場合があります。そのeventでOriginを削除するのは遅すぎ、Vite processを終了させます。以前のOrigin付き空body POSTは偶然401を返しましたが、このstreaming/header送信済みのタイミングを通っていません。その成功は遅延変更が安全である証拠ではありません。

この修正後browser障害は、試みたCORS修正がViteをcrashさせたことが原因であり、元のCORS拒否、JWT、quota、Go ReadTimeout、SCNetが原因ではありません。Section 18は修正前requestの原因として引き続き該当します。

### 最小修正と回帰確認

Origin削除を、Viteが`/api` proxy middlewareをinstallする前に動作するVite `configureServer` Connect middlewareへ移しました。upstream ClientRequest作成前に`/api` pathの`req.headers.origin`のみを削除し、socket作成後にoutgoing headerを変更しません。一時診断configはプロジェクト実際の`vite.config.ts`と合成し、独自の遅延Origin変更はしません。これによりbrowser受け入れ確認で本番dev-proxy経路を使います。

`frontend/src/vite-proxy.test.ts`を拡張し、API requestではAuthorizationとmultipart Content-Typeを保持してOriginを除去し、非API requestではOriginを維持することをassertします。対象2 testと`npm run typecheck`は成功しました。Vite再起動後、Origin付き空multipart POSTは401を返し、安全logでVite upstream request write完了、Go handler到達、response完了を確認しました。`/app`は200を返し、Viteは`0.0.0.0:5174`で稼働を継続しました。この統合確認はmiddleware順序/routingを立証しますが、ユーザーの失敗した60秒bodyの代替ではありません。

### 状態と残る受け入れ確認

crashで停止したのはVite 5174のみで、隔離Go API 8081は稼働を継続しました。ViteをプロジェクトVite configと安全stage log付きで再起動しました。API 8081は正常で、Vite `/app`とReact最適化moduleは200を返します。8080/5173は変更していません。現在のentitlement/control設定は不変でusageは0です。旧/新mode 0600 filter logはすべて保護一時directoryに保持し、cleanupはまだしていません。

**状態: 部分完了。** 60秒処理失敗をViteの遅すぎるheader変更に特定し、転送前に修正しました。自動テストと空bodyのproxy統合は成功しました。guard付きcleanup前に修正後の認証付き60秒browser解析とTimeline/Effect受け入れ確認が必要です。

## 20. 最終browser受け入れ確認とguard付きcleanup（2026-11-04）

### Browser受け入れ確認

ユーザーはWindows browserで同じ118.05秒sourceの0〜60秒範囲を`http://172.25.179.49:5174/app`経由で完了したと確認しました。HTTP 200、Timeline結果のEditor反映、Effect適用、再生/シーク同期を確認しました。相関Vite logも一致し、browserから10,584,359-byte multipart bodyが完了し、upstream requestが全送信され、ViteがHTTP 200を受信してbrowser responseを完了しました。Goは一致する10,584,359-byte requestとstatus 200（handler時間47,956ms）を記録しました。読み取り専用DB調査では唯一の既存Auth userに対する`succeeded` usageがちょうど1件、他usage状態なし、active leaseなしでした。**Browserキャンセルは未検証**で、受け入れ合格に含めません。

### snapshot guardとcleanup

cleanup直前の読み取り専用調査でAuth user 1件、一時limit/grant/expiryが完全一致するentitlement 1件、上記request timestampと一致するsucceeded usage 1行、active lease 0件、想定どおり有効な一時control値を確認しました。guard付きtransactionはすべての値とusage/entitlementが唯一の既存Auth userに属することをassertしました。そのusage行とentitlementのみ削除し、Auth userを保持し、`audio_analysis_control`をfail-closed既定値（無効、request-windowを含む全limit 0、lease 900秒）に戻しました。最初のtransaction案は非対応`min(uuid)` aggregateでerrorとなり、データ変更前にrollbackしました。修正版guard付きtransactionは正常commitしました。

cleanup後の読み取り専用確認ではMigration 019が最新、Auth user 1件、entitlement/usage/active lease件数0、control無効・全limit 0・lease 900、専用roleはLOGINのままnon-superuser、CREATEDB/CREATEROLE/BYPASSRLSなし、NOINHERIT、membershipなしでした。privilege/RLS/default-deny invariant 7項目すべて成功しました。既存backupには触れていません。

process所有関係を確認した後、隔離Go API `127.0.0.1:8081`とVite `0.0.0.0:5174`のみ停止しました。両test processは停止し、8080/5173には触れていません。再発行role password/DSNとprivate API/Vite診断logを含むmode 0700一時directoryを結果記録後に削除しました。role password自体はユーザーの明示承認後に限り再発行し、制限role属性は不変です。secretのcopyはworkspaceにも一時fileにも残っていません。

### 最終状態

**状態: 完了。** 修正後の60秒browser解析と要求されたTimeline/Effect受け入れ確認に成功し、guard付きDB cleanup、process/secret cleanupを完了し、`git diff --check`も成功しました。Browser解析キャンセルは未検証です。
