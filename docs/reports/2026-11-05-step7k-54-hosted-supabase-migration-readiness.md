# Step 7k-54 — Hosted Supabase移行準備・適用計画

**状態：調査・計画は一部完了。Hosted適用はNO-GO。** mainは`42627b771108dbc40f33dc561388c943955c9ffa`。作業ツリーは開始時点でclean。Hosted Supabase/GCP/GitHubへの接続・更新、migration適用は行っていない。

## 結論と適用停止条件

Hostedを新規空プロジェクトとして構築し、ローカルのユーザー・データ・旧`bytea`音源は移さず、migrationだけを時系列で適用する方針が既存実装と整合する。Storage bucketはprivateのまま使い、`audio_analysis_jobs.audio_wav`とdual-readは後方互換のため保持する。

現状のままHostedを有効にしてはいけない。次の2点を実装・実接続で解消する必要がある。

1. `api/internal/audiojobs/storage.go`は同じキーを`apikey`と`Authorization: Bearer`の両方へ設定する。現行推奨のSupabase `sb_secret_...`キーは不透明キーであり、公式仕様では`apikey`ヘッダーにだけ送る。Hostedでsecret keyを採用する前に、Bearerヘッダーを付けずにStorage APIを呼ぶ実装へ修正し、private bucketのPUT/GET/DELETEをHosted相当環境で検証する。修正までは従来のJWT形式`service_role`キーが互換候補だが、2026年末の非推奨化に依存しない。秘密キーはRLSを迂回する全権限なので、APIとWorker用に別鍵を発行し、各Cloud Run service accountだけにSecret Manager読取を許す。[Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
2. FreeプランのIPv4接続にはShared Poolerのsession modeが候補だが、Supabaseはcustom DB roleのユーザー名を`<ROLE>.<PROJECT-REF>`形式としている。一方、Goの`audiobudget`と`audiojobs`はユーザー名が厳密に`arvc_audio_analysis`であることを要求する。したがって現状のままpooler DSNを渡すと初期化で拒否される。Cloud RunからのDirect IPv6接続可否を実測するか、`arvc_audio_analysis.<project-ref>`だけをproject refとともに厳密照合する変更を先に行い、接続・権限テストを行う。ロール検証を一般化・緩和しない。[Supabase connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)

Hostedの実Postgres role権限、migration実行資格、正確なPoolerユーザー名・接続経路、JWT署名鍵、Storageキー互換性を確認するまで、production workflowでmigrationを適用したりCloud Runへトラフィックを向けたりしない。

加えてmigration対象の選定に仕様矛盾がある。`20261101001800_openai_gpt6_luna_budget_pricing.sql`は本文で「Hosted Supabaseに適用しない」と明記し、`20261101001700_local_fixture_budget_exemption.sql`はlocal fixture quota exemption関数を追加する。一方、production workflowの`supabase db push --linked --yes`はHosted側にない全migrationを順に適用する。空projectに対してこの2件を含めるか、適用せずmigration履歴をどう整合させるかの承認済み方針がない。履歴だけを`migration repair`で適用済みに偽装せず、両migrationのHosted扱い・AI budgetの本番model/pricing設定・対象migrationの明示方法を決めるまで、最終的な適用migration一覧は確定不可。

## Hosted構成と権限契約

| 領域 | 適用計画・確認事項 |
|---|---|
| Project / Region | まだHosted projectはなく、ref・regionは未確定。ユーザーが主に日本ならSupabase Tokyo `ap-northeast-1`とCloud Runの同一/近接リージョンを候補にし、利用者遅延・データ所在地・実GCPリージョンを承認前に確定する。リージョン選択はデータ所在地を決めるが、法令適合そのものを保証しない。[Regions](https://supabase.com/docs/guides/platform/regions) |
| Postgres / extensions | `supabase/config.toml`はmajor version 17。Hostedの実versionは未確認。新規projectを17に揃えるか、適用前にmigrationの互換性を再確認する。migrationはAuth/Storage提供schemaに依存し、`extensions.digest`を呼ぶため`pgcrypto`が`extensions` schemaで有効か確認する。migration群に`CREATE EXTENSION`は見当たらない。その他の独自extension作成はない。[Extensions](https://supabase.com/docs/guides/database/extensions) |
| Migration role | Migrationにはcustom role作成、role membership変更、`ALTER FUNCTION ... OWNER TO postgres`、GRANT/REVOKE、`auth.users` FK、`storage.buckets/objects`参照がある。通常の隔離Postgres成功はHosted管理roleの権限を証明しない。project作成後、非公開の使い捨てHosted projectでmigration全件を事前検証し、実行主体がCREATE ROLE/role grant/function ownershipを実行できることを確かめる。権限不足時はそこで停止し、権限不変条件を弱めず最小forward-only修正案をレビューする。 |
| Runtime DB role | `arvc_audio_analysis`はmigrationで`NOLOGIN`として作られる。Hostedで別個の強い認証情報を設定し、必要な時点でloginを有効化してSecret Managerへ保存する。Cloud Runは専用roleのみを使い`postgres`や`service_role`で接続しない。アプリのRPC allowlist、RLS FORCE、security definerの`search_path=''`、関数所有者と最小GRANTを維持する。role passwordはログ・レポートへ出さない。 |
| DB network / pool | Cloud RunのIPv4-only経路ならShared Pooler session mode (5432)を候補とする。session modeはpgxのprepared statementsを使え、transaction modeはprepared statements非対応なので使わない。FreeのDirect connectionはIPv6、Shared PoolerはIPv4。TLSは`sslmode=verify-full`とSupabase CAでhostname検証し、DBのSSL強制を有効にする。実project Dashboardのpool/connection limitsと接続数を測定する。アプリは複数pgx poolを持ち、各pool `MaxConns=4`; API/Workerのmax 2台構成ではアプリ側だけで最大約32接続となり得るため、内部Supabase接続分も含め余裕を確認する。[Connect](https://supabase.com/docs/guides/database/connecting-to-postgres) [Pooling and limits](https://supabase.com/docs/guides/database/connecting-to-postgres/pooling-and-limits) |
| Auth / JWT | Hosted issuerは`https://<project-ref>.supabase.co/auth/v1`、JWKSは`.../.well-known/jwks.json`。Go validatorはES256、audience=`authenticated`、role、UUID subject、expを検証しfail-closed。Hosted AuthでES256非対称鍵を有効・確認し、プロジェクトref、redirect URL、email provider/SMTP、signup policy、鍵ローテーションを確定する。HS256/RS256を許可するようvalidatorを広げない。[JWT](https://supabase.com/docs/guides/auth/jwts) [Signing keys](https://supabase.com/docs/guides/auth/signing-keys) |
| Storage | private bucketは`arvc-project-assets`および`arvc-audio-analysis`。Storage migrationはbucket ID競合で例外になるので、適用前にHosted bucket一覧をread-only確認する。音源は最大16 MiB/object、user/job UUID key、owner-only read policy。Auth付きユーザーは自身のpathだけread可、client upload/deleteは禁止、サーバーだけが管理する。service secretはRLS bypassの全権限であり、Storage policyはそれを制限しない。API側でJWT・所有者・job参照を検証し、秘密鍵をFrontendへ出さず、分離したCloud Run identity/Secret Managerで守る。 |
| Cloud Run / Tasks / IAM | 既存templateはAPI 1 vCPU/1 GiB・concurrency 20、Worker 2 vCPU/4 GiB・concurrency 1、max 2/min 0。解析上限600秒、Cloud Tasks deadline 720秒、Cloud Run timeout 780秒、DB lease 900秒で現在の時間関係は整合する。TasksのOIDC audience、専用invoker、Scheduler identity、queue retry/rate、Scheduler間隔、service account間の`actAs`/`run.invoker`、Artifact Registry・Secretの読取を実環境値で設定・検証する。API/WorkerはCloud Tasks disabledのまま起動し、スモーク承認後だけ段階有効化する。Cloud Runは初期状態で非公開のままにし、外部HTTPS gateway、CORS origin、認証、quota、kill switchを別々に検証する。 |

## Migration・データ適用順序

依存順は`supabase/migrations/`のtimestamp順である。ただし、これは現時点でのHosted適用承認リストではない。現行workflowの`supabase db push --linked --yes`はremoteに履歴のないmigrationを全て実行するため、新規Hosted projectでは以下の一覧を全件適用しようとする。017/018の明示的な適用方針が未決定であり、承認済みのHosted migration集合はまだ確定していない。Hostedは新規projectのため既存ローカルmigrationを適用済みとして履歴だけ登録したり、開発DB dumpを投入したりしない。

1. `20261101000100`〜`20261101000800`：project metadata、role/ACL/RLS hardening
2. `20261101000900`〜`20261101001500`：project assets、Storage policies、verifier role/ACL
3. `20261101001600`：AI entitlement/budget foundation
4. `20261101001700`：local fixture quota exemption — Hostedへ入れるべきか未確定
5. `20261101001800`：AI model/pricing update — migration自身がHostedへ適用しないよう指示。適用対象に含めない方針と本番AI budgetの初期値は未確定
6. `20261104000100`：Audio Analysis quota/control/runtime role
7. `20261105000100`：durable jobs・旧bytea
8. `20261105000200`：quota idempotency/attempt fencing
9. `20261105000300`：Cloud Tasks outbox
10. `20261105000400`：private Storage、upload intents・cleanup、dual-read

適用前に新規Hosted project/ref、migration履歴が空、project major version、`pgcrypto`、Storage bucket ID、実行role権限、CLI認証/接続経路を確認する。上記017/018を含む実行対象の方針を確定し、dry-run/listと明示承認済みmigration集合が一致することを記録できるまで適用を保留する。現workflowはdry-runを挟まず直接`db push`するため、承認前にworkflowをallowlist/dry-run可能な形へ更新する必要がある。migration履歴とschemaを対に確認し、失敗時は再実行・`migration repair`・bucket削除をしない。部分適用状態とDDLを照合して停止し、バックアップからの復元またはレビュー済みforward correctionを選ぶ。適用済みmigrationは編集しない。

既存migrationは新規の空Hosted project前提であり、Auth/Storage schemaおよびSupabase管理roleと直接連携する。`20261101000700`等のrole membership操作、Storage policies/bucket SQL、全`OWNER TO postgres`はHostedでのローカル同等性未証明項目。失敗時のtransaction/partial DDL挙動をローカル結果から推定しない。

## データ、容量、無料枠、費用

- 移行するものはschema・role/policy・設定だけ。local Auth users、entitlement/usage/job/result、test credential、試験音源、legacy `bytea`データはHostedへコピーしない。新Hostedではlegacy dual-readを維持するが新規job音声はprivate Storageへ保存する。
- 公式Free plan表示（2026-11-05確認）：DB quota 500 MB/project、Storage 1 GB、uncached egress 5 GB + cached egress 5 GB、Auth 50,000 MAU、Free projectは一週間低活動でpauseされる可能性があり、inactive project上限あり。Freeは自動DB backupなし。Freeは試験/closed canary向けとし、連続稼働・復旧保証付き公開の基盤としては採用しない。[Pricing](https://supabase.com/pricing) [Free pause](https://supabase.com/docs/guides/platform/free-project-pausing) [Backups](https://supabase.com/docs/guides/platform/backups)
- Free全bucket共通のglobal file capは50 MB。今回のbucket cap 16 MiBは範囲内。DB migration上の音声accounted capは320 MiB、user cap 48 MiB、同時active/queue上限20、user queue上限2、upload intentは24時間で期限切れ、Storage cleanupはdelete成功まで容量計上する。320 MiBはStorage全projectの実使用量制限ではないため、別bucketと孤児objectを含むDashboard総使用量に余裕を持たせる。孤児探索はDB intent/cleanup補償だけで完全なStorage bucket inventory scanではないため、定期的にStorage usage/logを照合する。[Upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
- DBには最大10 MiB JSON result、job rowは通常24時間より古いterminal jobを次回submit/claim時に削除、quota usageは90日で削除する。DB 500 MBはprojectの他schema/metadata込みなので20件×10 MiBの理論上限等を実使用と誤認せず、database size・disk/WAL・job result bytes・cleanup ageをmonitorし、容量閾値でadmissionを止める運用を用意する。[Database size](https://supabase.com/docs/guides/platform/database-size)
- Audio StorageからのWorker GETはuncached egressを消費する。1回16 MiBだけで計算しても5 GB枠は約320 full-size downloads相当で、retryや他Supabase API trafficを含まない。実測するmetricは月間storage download bytes、retry回数、bucket total bytes/orphan数、DB size/WAL、connection peak、Auth MAU、Free project pause/復旧時間。実使用予測がないので月額¥1,000以内は証明できない。
- Supabase Proは公式表示$25/月からでFreeよりバックアップ/稼働面は改善するが、現行¥1,000/月目標と両立しない可能性が高い。正確な為替・GCP・超過費用は未確定で、Spend capは利用上限/強制停止の保証として扱わない。[Pricing](https://supabase.com/pricing)

## Backup・復旧・smoke計画

1. project作成・初回migration前にref/region/plan/PG version、migration履歴、Auth key mode、bucket一覧、DB connection methodをread-onlyで記録する。localのDB backupやvolumeはHosted復元元として使わない。
2. Freeでは自動backup/PITRを前提にできない。適用前後と定期的に`supabase db dump`/`pg_dump`でDB logical backupを別の暗号化保管先へ保存し、checksum/sizeを記録する。Storage binary objectはDB backupに含まれないため、private bucket objectを別途exportしmanifest・object hashと照合する。復元可能性は本番projectに触れない別の隔離projectへDB restoreとStorage object restoreを行い、schema・role ACL・RLS/storage owner/other/anonymous拒否・Auth JWKS・sample job/resultを検証する。[Database backups](https://supabase.com/docs/guides/platform/backups)
3. 初回は未稼働・空projectのためdata-loss impactを限定できる。migration失敗時に書込みを止め、job admission / Cloud Tasks kill switchをOFF、Scheduler pause、worker dispatch停止。実DB状態とmigration historyを採取後、削除や履歴repairをせずにstopして判断する。Schema-only/forward fixか、承認を得て空の代替projectを新規作成する。Hosted project削除・rollbackを自動実行しない。
4. 適用後は権限不変条件SQL、migration list/schema object照合、ES256 JWT positive/expired/wrong-issuer/wrong-audience、CORS、anonymous/other-user Storage拒否、server credentialだけのPUT/GET/DELETE、API upload→outbox→OIDC task→Worker fake/limited SCNet→quota once→status/result GET→terminal cleanup、duplicate/retry/cancelの順にsmoke test。機能flag/DB controlはdefault-offのまま段階公開し、監視・停止担当者とrecovery期限を承認する。

## 適用承認前に必要な設定

- Supabase project ref/region/plan、Postgres 17 versionと`pgcrypto`、Auth ES256/JWKS/redirect/SMTP/signup settings、Storage bucket一覧/global upload limit/usage
- `arvc_audio_analysis` passwordとlogin provisioning方法、`verify-full` TLS DSN、IPv4 pooler/direct network compatibility、API/WorkerごとのSecret Manager accessor
- Hosted migration runner用Supabase CLI 2.121.0非対話接続確認。現workflowはPATとproject refを受け取るが、pinned CLIで`link`/`db push`に必要な実DB login/passwordまたはtemporary role経路を隔離環境で実証する。SupabaseのCLIにはManagement API tokenとDB接続認証の別権限境界があるため同一とみなさない。[CI migration guidance](https://supabase.com/docs/guides/deployment/managing-environments)
- GCP project/region、Cloud Run runtime identities・service URL・ingress/gateway・CORS origin、Tasks queue/rate/retry/deadline/OIDC audience、Scheduler cadence/OIDC、Invoker/actAs/task-creator/secret access最小IAM、Artifact Registry immutable digest、kill switch/runbook owner
- Storage API secret-header修正、IPv4 pooler DSN validationまたは実証済みIPv6 path、Hosted相当のmigration全件適用/権限SQL、backup restore、end-to-end smokeの再検証
- production Environment reviewer、migration実行者と停止/復旧承認者。workflow_dispatchの明示確認後も、traffic routing/Cloud Tasks機能有効化は別承認で行う

## 検証・変更範囲

Read-onlyでmain、状態資料、migration、Go DB/Auth/Storage実装、Cloud Run templates、release workflowを確認。Supabase公式資料で料金/制限、regions、connection modes、API key header、JWT/JWKS、backup、CLI migrationを確認した。Hosted固有のDB/Storage実行試験は権限・スコープ外なので未実施。静的確認は`git diff --check`とmigration/workflow定義の読み合わせを実施。migration集合の矛盾と前述2実装接続不整合が残り、Hosted用の確定migration一覧と接続可能性はBLOCKED扱い。

変更はこの報告書、`CURRENT_TASK.md`、`docs/CURRENT_STATE.md`のみ。既存migration・アプリコード・Cloud/GitHub設定は変更していない。Hosted project未作成のため、実環境適用はまだ不可。
