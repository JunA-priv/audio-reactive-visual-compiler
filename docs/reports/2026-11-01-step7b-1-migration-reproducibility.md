# Step 7b-1：Migration 001–008再現性検証

実施日：2026年11月1日  
状態：**completed（管理者handoffを含む手順で再現）**

## 結論

新規Supabase local環境ではmigration 001–004が通常runnerで適用され、005は`supabase_admin` grantorのrole membershipを通常runnerがrevokeできず失敗する。005を管理者接続で適用し履歴を修復した後、通常runnerは006を適用するが007は`arvc_project_writer` role grantに必要なADMIN optionがなく失敗する。007はSupabase schema-owner/admin接続で一時的なpublic CREATE privilegeを与えて適用し、直後に取り消す必要がある。以降008は通常runnerで適用できた。

従ってmigration 001–008は**単一の通常migration-runner実行ではfresh setupできない**。管理者handoffを伴うrunbookで全件適用を再現した。現状migrationの破壊的書換えはせず、次回の標準化候補としてadmin bootstrapと通常migrationの分離を提案する。

## 隔離方法・保全

- Docker Desktop 4.97.0 / Engine 29.9.2。Supabase CLI v2.122.0。
- `/tmp/arvc-step7b-repro-20261101`にconfigとmigrationコピーを作成。project IDを一意化し、DB/API/Shadow DB/Inbucket等を55420番台へ分離。Realtime、Studio、analytics等は除外。
- 新規container prefix、専用DB/Storage volume、専用Docker networkを使用。公開portは55421/API、55422/Postgres、55424/Inbucketで、`127.0.0.1`と`::1`のみ。
- 初回自動migrationで失敗後、stack停止によりCLIがcontainerを除去。再起動時は使い捨てconfigの`db.migrations.enabled=false`でstackを起動し、migrationを手動順次適用した。
- 検証完了後、使い捨てstackを停止し、作成した2 volumeだけを削除。既存Supabase/TuneScout container、volume、networkの前後一覧は同一。既存Supabaseはhealthyのまま稼働し、Tunescoutは停止状態を維持。
- Hosted環境への接続なし。既存DBにはmigration適用・resetなし。

## 001–008の依存と通常runnerの失敗

| Migration | 役割 | fresh-runnerでの結果 |
|---|---|---|
| 001 projects | helper role、projects table、FK/constraints、RLS、limit trigger、SECURITY DEFINER update RPCを作成 | 成功 |
| 002 ACL hardening | RPC executeをauthenticatedへ限定 | 成功 |
| 003 ACL finalize | helper roleへ一時SET ROLEしfunction ACLを確定 | 成功 |
| 004 membership minimize | postgres側のmembership capabilityを無効化 | 成功 |
| 005 membership cleanup | `GRANTED BY postgres`と`GRANTED BY supabase_admin`をrevoke | **失敗** |
| 006 auth schema privilege試行 | helperへauth schema USAGEをgrant | 成功。ただしcatalogで実効USAGEなし。007でauth schema参照を使わない形にする |
| 007 claim-scoped RPC | ownerをJWT claim settingから導出するRLS/RPCへ更新 | **失敗** |
| 008 service role revoke | Supabase default ACL由来のprojects table権限を取り消す | 成功 |

005通常runnerエラーはSQLSTATE `42501`: `supabase_admin`をgrantorとするrole membershipをrevokeする権限がない。カタログでは`arvc_project_writer -> postgres` membershipがgrantor `postgres`と`supabase_admin`の二行で確認され、後者は`admin_option=true`だった。

005をadmin接続で適用・migration repairした後、007通常runnerエラーもSQLSTATE `42501`: `GRANT arvc_project_writer TO postgres WITH SET TRUE`に必要なrole ADMIN optionを持たない。005 cleanup後にpostgres membershipがなくなるので、007は通常runnerでhelper roleへ`SET ROLE`できない。さらに007内でhelper roleが`CREATE OR REPLACE FUNCTION`するため、001で取り消した`public` schema CREATEを一時grantする必要がある。

## 再現手順

この手順は**新規local project専用**。本番/Hosted DBへ流用しない。container名は対象configのproject IDから確認する。初期起動時にmigrationを自動実行すると005でCLIがstackを停止するため、新規環境のconfigでmigration自動適用を一時停止しstackを起動してから実施する。

1. 001–004を通常`supabase migration up --local`で適用。通常runnerは005で止まる。
2. 対象local DB containerに限定して005をschema-owner接続で適用し、migration historyを記録する。

   ```bash
   docker exec -i supabase_db_<local-project-id> psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20261101000500_step7b_project_role_grant_cleanup.sql
   supabase migration repair 20261101000500 --status applied --local
   ```

3. 通常`supabase migration up --local`で006を適用。007で通常runnerが止まる。
4. 007だけschema-owner接続で最小限の一時CREATE権限を与えて適用し、即revokeする。その後migration historyを記録する。

   ```bash
   docker exec supabase_db_<local-project-id> psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c 'GRANT CREATE ON SCHEMA public TO arvc_project_writer'
   docker exec -i supabase_db_<local-project-id> psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 < supabase/migrations/20261101000700_step7b_project_rpc_claim_scope.sql
   docker exec supabase_db_<local-project-id> psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -c 'REVOKE CREATE ON SCHEMA public FROM arvc_project_writer'
   supabase migration repair 20261101000700 --status applied --local
   ```

5. 通常`supabase migration up --local`を再実行し008を適用する。

`<local-project-id>`はDocker inspectで対象project prefixとportを照合して置換する。supabase migration repairはSQLを実行せずlocal履歴だけを修正する。`db reset`、`--all`、既存volume操作は不要。

## 007管理者bootstrapを分ける案

現行runbookでも新規環境への再現は可能だが、管理者手順をmigrations内の通常適用と混在させるとfresh setupが一度で成功しない。将来整理する場合は、通常runnerで安全に適用可能なtable/policy migrationsと、supabase_adminが実行する専用bootstrap（role membership、短時間のschema CREATE、cleanup、version記録）を分離する案を推奨する。005 cleanupもadmin bootstrap側へ移す必要がある。権限モデルを変更するため、この報告ではmigrationを書き換えず提案に留めた。

## 再現後の検証

全001–008適用後に`TestLocalSupabaseProjectAuthorizationAndLimits`を実Auth/Data API付きで実行し成功。User A/BのCRUD、交差owner 404、anon/service_role直接拒否、owner偽装拒否、stale・同時revision競合、20件上限、1 MiB上限、cursorページングを検証。終了後Projects rows 0、test users 0。

CatalogでRLS enabled/force=true、projects owner=`postgres`、helper role NOLOGIN/NOBYPASSRLS、helper public CREATEなし、postgresへのhelper membershipなしを確認。anon/service_roleはprojectsのSELECT/INSERT/UPDATE/DELETE全てfalse。authenticatedはowner-filtered SELECT/DELETEと限定INSERT列を持つ。Migration listは001–008一致。

既存Go `go test ./...`、`go vet ./...`、`gofmt`確認、`git diff --check`成功。Go API、DB schema、migration 001–008は今回変更していない。

## 未解決

- 001–008は新規DBの自動migration一括実行では失敗する。fresh environment用の管理者bootstrapを別途正式化する必要がある。
- Supabase CLI 2.122.0 / 現ローカルrole/grant構成での結果。Hosted Supabaseで同じgrantorやrole ownershipになるかは未検証、接続もしていない。
- 使い捨てStackは停止・cleanup済みのため、再現手順の再実行時は新しい隔離projectを作る。

