# Step 7b-2：Migration権限管理と初期構築手順の標準化

実施日：2026年11月1日  
状態：**completed（設計・read-only検証）**

## 結論

001–008は既存履歴をそのまま維持する。短期運用では005と007をschema-owner/admin handoffに分けるfresh-local runbookを使う。後続で自動化する場合は、既存migrationをsquash/rewriteせず、local-only bootstrap orchestratorがこのhandoffを明示的に実行し、SQL成功後だけmigration historyをrepairする方式を推奨する。

005は`supabase_admin` grantorのrole membership cleanup、007はhelper role membershipと一時schema CREATEを必要とする。管理者bootstrapはDBの現状態を事前照合し、対象migrationが未適用かつ正確な前提状態の場合だけ処理する。既存適用済み環境に修正SQLを流さない。

## 参照・変更範囲

PROJECT_CONTEXT、DEVELOPMENT_RULES、CURRENT_STATE、Step 7b/7b-1報告、CURRENT_TASK、migrations 001–008を確認した。Go API、Frontend、Migration SQL、認証/RLS/CRUD仕様、Docker Stackには変更を加えていない。Hosted環境への接続、DB write、repair、reset、volume操作も行っていない。

新規の[`step7b-privilege-invariants.sql`](../../supabase/verification/step7b-privilege-invariants.sql)はカタログ照会のみのSQL。既存稼働local DBへread-onlyで実行し、全9項目passを確認した。

## 005/007の権限操作

### Migration 005

004までに作られたhelper role membershipにはgrantor `postgres`と`supabase_admin`が含まれる。通常runnerは前者のgrantsをrevokeできても、後者のgrantを取り消せずSQLSTATE `42501`となる。005は両grantorから`postgres`へのmembershipを撤去するcleanupであり、table/schema ACLやProject dataを変更しない。

管理者実行前提：001–004がledgerにあり、005が未記録。`arvc_project_writer`と`projects`は存在し、member=postgresのgrantor集合が期待する`postgres`/`supabase_admin`だけであることを確認する。予期しないgrantorや別membershipがあれば停止する。

### Migration 007

005がhelper membershipを撤去した後、通常runnerは`GRANT arvc_project_writer TO postgres WITH SET TRUE`に必要なADMIN optionを持たずSQLSTATE `42501`となる。007内の`SET ROLE arvc_project_writer`後に`CREATE OR REPLACE FUNCTION`するには、helper roleに`public` schema CREATEが必要。001はこの権限をrevokeしている。

管理者handoffでは、005/006成功・007未記録、helper roleにmembershipなし、`public` CREATEなし、Projects update policy/RPCが007以前の期待状態であることを確認する。一時CREATE、007内のmembership/SET ROLE/RPC更新、CREATE撤去を**ひとつのtransaction**に包む。成功commit後はhelper membershipとschema CREATEの両方がないことを検証する。

007のowner判定は`request.jwt.claim.sub`または`request.jwt.claims`から取得する。helperに`auth` schema USAGEを与えない。006のgrant試行は実効USAGEを与えていないため、最終権限条件として依存しない。

## 最終権限不変条件

既存local DBに対するread-only catalog確認とverification SQLの結果：

| 対象 | 合格状態 |
|---|---|
| `public.projects` | owner `postgres`、RLS enabled、FORCE RLS |
| `arvc_project_writer` role | NOLOGIN、NOSUPERUSER、NOCREATEDB、NOCREATEROLE、NOBYPASSRLS |
| helper membership | `pg_auth_members`でhelperのroleid/memberいずれのmembershipも0件 |
| helper schema権限 | `public CREATE=false`、`auth USAGE=false` |
| helper table/column | projects SELECTあり、table-level UPDATEなし。UPDATE columnはtitle/document/revision/updated_atのみ。id/owner_id/created_atは更新不可 |
| application table ACL | anon/service_roleのSELECT/INSERT/UPDATE/DELETEすべてなし。authenticatedはRLS対象SELECT/DELETEとtitle/documentのみINSERT。直接UPDATEなし |
| update RPC | owner helper、SECURITY DEFINER、`search_path=""`、authenticated executeのみ。anon/service_role executeなし |
| `projects_enforce_limits` | enabled trigger、SECURITY DEFINER、owner postgres、`search_path=""` |
| migration ledger | 001–008をすべて記録 |

PostgreSQLのsuperuser/BYPASSRLS主体はRLSを迂回できるため、このモデルは`service_role`の直接table/RPC権限revokeも必須不変条件とする。`supabase_admin`は管理者bootstrap用であり、Go API/通常CRUDには渡さない。

実行済み検証ファイルはread-only SELECTのみで、9項目すべてpass。JWT、Project row、secret値は取得しない。

## Fresh local setup runbook

この手順は新規local projectだけを対象とし、Hosted/既存環境には使わない。既存手順のport分離、Local only bind、Realtime除外、使い捨てvolume、project ID照合を先に行う。初回CLI起動が005でstackを停止しないよう、fresh local configでは`db.migrations.enabled=false`で起動し、起動後にmigrationを明示実行する。

1. **Preflight（read-only）**：`--workdir`/project ID、container名、DB port、volume/networkが専用のlocal値であること、HostIpがloopbackであることを確認。fresh DBのmigration ledgerに001–008がなく、`public.projects`/`arvc_project_writer`がまだ存在しないことを確認する。どれか不一致ならこの手順を中止する。
2. **通常runner**：`supabase migration up --local`。001–004が適用され、005で停止するのが既知結果。
3. **Admin handoff 005**：期待するgrantor/memberを照合後、対象containerへ以下のSQLを単一transactionで適用する。

   ```bash
   docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres --single-transaction -v ON_ERROR_STOP=1 < supabase/migrations/20261101000500_step7b_project_role_grant_cleanup.sql
   ```

   SQL成功後、カタログでhelper→postgres membershipなしを確認してから`supabase migration repair 20261101000500 --status applied --local`を実行する。repair成功後、ledger versionが1件増えたことを確認する。

4. **通常runner**：`supabase migration up --local`。006成功後、007で停止するのが既知結果。
5. **Admin handoff 007**：005/006 recorded、007 unrecorded、helper membershipなし、helper public CREATEなしを照合する。temporary grant、migration SQL、revokeを1 transactionにまとめる。

   ```bash
   {
     printf '%s\n' 'GRANT CREATE ON SCHEMA public TO arvc_project_writer;'
     cat supabase/migrations/20261101000700_step7b_project_rpc_claim_scope.sql
     printf '%s\n' 'REVOKE CREATE ON SCHEMA public FROM arvc_project_writer;'
   } | docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres --single-transaction -v ON_ERROR_STOP=1
   ```

   psql exit code 0とtransaction commitを確認し、helper membershipなし・public CREATEなし・RPC owner/ACL/policyが最終条件どおりになった後だけ`supabase migration repair 20261101000700 --status applied --local`を行う。

6. **通常runner**：`supabase migration up --local`で008を適用。`step7b-privilege-invariants.sql`を実行して全checkがpassすること、ledgerに001–008があること、DB integration testでowner/RLS/revision/limitsを確認する。

SQL transaction成功後にrepairが失敗した場合、migration SQLを再実行しない。ledgerとカタログを照合し、SQLが成功済み・version未記録ならrepairだけを行う。SQL transaction失敗時はrollbackとledger不変を照合する。カタログが中間状態、migration repairの成功可否不明、role owner/grantorが想定外ならそこで停止し、手動の推測修復をしない。

`$DB_CONTAINER`は確認済みの`supabase_db_<unique-local-project-id>`に設定する。Shell commandへAPI key/JWT/DB URLを入れない。`migration repair`はSQLを実行しないので、SQL成功証跡なしのrepairは禁止する。

## 方式比較と推奨

| 方式 | 長所 | 注意点 |
|---|---|---|
| 001–008を維持し、005/007を手動handoff | 既存ledger/稼働DB/SQLを保ち、今回再現した実績をそのまま使える | 2回停止/repairが必要。作業者が順番とtransactionを守る必要がある |
| fresh-only bootstrap orchestrationを将来追加 | local fresh setupでpreflight→通常runner→admin transaction→repairを順序固定でき、運用漏れを減らせる | CLIのmigration discovery、repair、CI/環境構築、途中失敗状態管理を実装・テストする必要。既存DBをfresh扱いしない強いguardが必要 |
| Migration squash/rewrite | fresh setupを簡潔にできる可能性 | applied DBのmigration historyと分岐し、既存環境/将来deployで大きなdrift・誤適用リスク |

**推奨：** 現在は1番目のrunbookを使い、将来自動化が必要になったとき2番目のfresh-only orchestratorを別L3変更として設計・承認する。3番目は既存DB維持と相容れず推奨しない。bootstrap scriptやmigration改変は今回実施していない。

## 未解決・次の実装条件

- Hosted Supabaseのrole ownership/grantorは未検証。本runbookをHostedへ流用しない。
- migration 006の存在理由と将来整理は別途判断。現段階では履歴を保ち、auth schema privilegeの証明には使わない。
- 自動bootstrap導入時はfresh project ID/URL/container/volumeのallowlist、ledger/table/role preflight、single-transaction rollback、repair後ledger照合、ログsecret scrub、二重実行テストが必須。
- Existing local DBはカタログをread-only照会しただけで、migrationや権限変更なし。

