# Step 7c-1：Asset ready確定の認可境界修正

日付：2026-11-01  
状態：**completed（ローカル実装・統合検証）**

## 結論

利用者JWTからのready RPC実行を禁止し、Go APIがStorageから実objectを読み直してサイズ・SHA-256を検証した後だけ、専用PostgreSQL role経由で`pending_upload`を`ready`へ遷移できるようにした。通常Project CRUDは引き続き利用者JWT/Data API、Storage upload/download/deleteは利用者JWT/Storage RLSを使う。`service_role`はGo API設定へ追加していない。

ローカルSupabaseでauthenticated/anon/service_role直RPC、非公開schemaへのPostgREST到達、偽hash、ready object overwrite、他owner、二重complete、既存RLS/Project/Asset削除を含む統合試験が成功。Hosted環境には接続していない。

## 権限方式

### runtime verifier role

`arvc_asset_verifier`は専用DB login role。実効属性はLOGIN、NOSUPERUSER、NOBYPASSRLS、NOINHERIT、NOCREATEDB、NOCREATEROLE。role membershipは0件。`public.projects`と`public.project_assets`にSELECT/INSERT/UPDATE/DELETE権限なし。アプリschema間の実効EXECUTEは`arvc_internal.project_asset_mark_ready(uuid,uuid)`のみ。

Go APIは`SUPABASE_ASSET_VERIFIER_DSN`でPostgreSQLへ接続し、この固定関数だけ呼ぶ。DSNはrole名、database、TLS modeを検査し、loopbackは`sslmode=disable`または`verify-full`、remote hostは`sslmode=verify-full`を要求する。エラーにDSN/credentialを含めない。poolは最大2 connection。

専用関数はPostgRESTに公開されない`arvc_internal` schemaに置き、`search_path=''`、完全修飾名を使用する。渡されたowner ID、Asset ID、`pending_upload`状態、Project/owner FK、generated object key、Storage object ownerを照合し、状態遷移は条件付きUPDATEで行う。関数は`postgres` ownerのSECURITY DEFINERであり、関数内だけでowner/state/object検査後の更新権限を持つ。通常Go API処理主体のverifier login自体はNOBYPASSRLS・表権限なしである。このSECURITY DEFINER function bodyは高権限境界として引き続きコードレビュー対象とする。

### Direct RPCの遮断

- Migration 012はNOLOGIN/NOBYPASSRLS runtime roleとprivate function/schemaを作り、新RPC EXECUTEをruntime roleに限定する。
- 012で残っていたlegacy `public.project_asset_mark_ready(uuid)`のEXECUTEをMigration 012で全API roleからrevokeした。
- Migration 013の通常runner実行後も、Catalogではrole creator grantorによる`postgres` membershipが残ることを検出した。
- Migration 014はmembershipを再vokeし、0件でないと失敗するfail-closed assertion。通常migration runnerでは必要なgrantor権限がなく失敗するため、対象local DBの`supabase_admin`でSQL適用後にのみmigration historyをrepairした。手順は[環境構築資料](../ENVIRONMENT_SETUP.md)に追加。
- Migration 015は`PUBLIC`既定EXECUTEが残っていた二つのtrigger-only関数から直接EXECUTEを撤去した。既存trigger動作はGo統合試験で確認。

Migration 001–011は変更していない。012–015は全て既存のlocalhost-only Supabaseに適用済み。DB reset、volume削除、Hosted操作はない。

## Go API実装

`api/internal/assets/verifier.go`はpgx `database/sql` driverでPostgreSQLへ接続し、固定SQLでprivate functionを実行する。`markReady`は結果のAsset ID、owner、状態、generated object keyを再検証する。

upload endpointは受信streamを一時ファイルにbounded spoolし、SHA-256・size・signatureを確認してからStorageへ送る。complete endpointもStorage objectをGo APIからGETし、実byteをhash照合してから専用関数を呼ぶ。DB関数自体は二度目のready遷移やowner/status不一致を拒否する。同時completeでは勝者がready化し、敗者はowner scopeでready rowを再取得して、同じhash/sizeならAPI上の冪等な成功にする。

Go PostgreSQL driverは`github.com/jackc/pgx/v5 v5.12.0`。pgx公式v5.12.0 release noteはv5.12.0以前の狭い条件下でのbatch SQL injection修正を記載する。今回のコードはbatch APIを使用しない。Go 1.27.3と互換。追加transitive modulesはpgpassfile、pgservicefile、puddle、x/sync、および必要なx/text更新。

Supabase公式はpersistent backendにPostgreSQL direct connectionを案内し、IPv4-only networkではsession poolerを代替として示す。またcustom PostgreSQL rolesを外部接続用として案内している。したがって専用DB login方式はSupabaseの公開されたDB接続・role機能に沿う。ただしHosted環境の権限適用・pooler/ネットワーク・credential provisioningは今回接続しておらず、未検証。[Database connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres)、[Postgres roles](https://supabase.com/docs/guides/database/postgres/roles)、[pgx v5.12.0 release](https://github.com/jackc/pgx/releases/tag/v5.12.0)。

## credential管理

local verifier passwordをランダム生成し、psqlのpassword prompt経由で設定した。DSNは既存`api/.env`へ追加し、mode 0600を設定。`api/.env`はGit ignore対象と確認し、値は表示・ログ・報告していない。`api/.env.example`には変数名のみを記載。service_role keyはテスト専用Auth user setup/cleanupにのみ使用し、API verifierや通常Data API操作へ渡していない。

API起動時に`PROJECTS_ENABLED=true`なら専用DSNを必須にしてfail closed。Fixture modeのloopback APIをport 18080で起動し、`/healthz` 200、未認証Projects GET 401を確認した。DSNやAPI keyの値は出力されていない。

## 必須負例・正例

ローカルAuth実JWT/Data API/Storageで以下を確認。

- authenticatedからlegacy ready RPC：拒否。
- anonからlegacy ready RPC：拒否。
- service_roleからlegacy ready RPC：拒否（BYPASSRLSでもEXECUTE grantなし）。
- `Content-Profile: arvc_internal`を付けたPostgREST呼出し：非公開schemaとして拒否。
- User AがRLS許可されたreserved Storage pathへhash不一致byteを直接upload後、API complete：422、readyにならない。
- 同じassetへの直接legacy RPC：拒否。
- Go API経由で実object bytesと予約hashが一致：専用DB role経由でready成功。
- 他owner、ready状態へのDB再遷移：専用関数で拒否。
- ready後のStorage upsert/overwrite：拒否。
- 同一Assetの同時complete：双方がHTTP 200、DB状態はready一件。
- 既存owner-only API/Storage access、Cloud Envelope参照、参照中delete 409、Asset delete、Project deleteの回帰：成功。

`supabase/verification/step7c-1-privilege-invariants.sql`の15項目全pass。既存`step7b-privilege-invariants.sql`も9項目全pass。

## ローカル実行・検証

- local migration ledger：009–015適用済み。014はadmin handoff SQL成功後にCLI history repair。
- 専用role: `rolsuper=false`, `rolbypassrls=false`, `rolinherit=false`, `rolcreaterole=false`, `rolcreatedb=false`, `rolcanlogin=true`; memberships 0。
- verifier role: `projects`/`project_assets` table SELECT/INSERT/UPDATE/DELETE false。
- Authenticated/anon/service_role: legacy/public ready関数とprivate functionのEXECUTE false。
- verifier: `arvc_internal.project_asset_mark_ready` EXECUTE true、他の`public`/`arvc_internal` app functionsはfalse。
- Go `go test -p 1 ./...`：成功（local Auth/Storage/verifier integration込み）。
- Go `go vet ./...`、gofmt確認：成功。
- Frontend 35 tests、typecheck、lint、build：成功。
- Step7b privilege checks 9/9、Step7c-1 checks 15/15 pass。
- 合成テスト後のStep7c test users/Projects/Assets/Storage objects：0件。
- `git diff --check`：成功。
- Gemini、Hosted Supabase、GitHub、Python Island、Demucs、FFmpegへの操作なし。

## 未確認・制約

- Hosted Supabase DBに接続していない。`arvc_asset_verifier`のproduction role bootstrap、custom role password/rotation、Supavisor session pooler username/connection limits、Cloud Run等からのnetwork/TLS設定は実地未検証。Hosted deploy時にはTLS `verify-full`、secret manager、connection limitを設定し、別工程でintegration reviewが必要。
- APIは現時点でloopback bind固定。外部へ公開しない。
- `postgres` ownerのSECURITY DEFINER関数は意図的な一点の権限昇格。owner/state/key/Object検査とprivate schema、EXECUTE ACLで範囲を狭めたが、その関数SQLのレビューが認可の要。
- Step 7d Frontend login/cloud save/load UIと実ブラウザ往復は未実施。
