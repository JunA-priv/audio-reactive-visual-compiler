# Step 7k-46 — Supabase手順書・隔離DB復元 / Migration 019検証

実施日：2026-11-04（Asia/Tokyo）  
Status：**completed（隔離local DB restore、Migration 019、role/RPC/ACL/quota実DB検証）**  
既存Supabase DB/volume/network：**変更なし**  
Hosted migration：**未実施（対象外）**

## 1. 既存環境・backupのread-only再確認

`docker ps`で既存Supabase stackはhealthy/running。DB container `supabase_db_audio-reactive-visual-compiler`はimage `public.ecr.aws/supabase/postgres:17.11.0.006`、Image ID `sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`、PostgreSQL 17.11、database `postgres`、12 MB。DB portは`127.0.0.1:54322`。Entrypoint `sh`、Supabase SQL生成後`docker-entrypoint.sh postgres -D /etc/postgresql`、mount `/var/lib/postgresql/data`、volume `supabase_db_audio-reactive-visual-compiler`、network `arvc-supabase-loopback`。

既存DBのread-only queryで最新migration `20261101001800_openai_gpt6_luna_budget_pricing`、`arvc_ai_budget`/`arvc_asset_verifier` LOGIN、`arvc_project_writer` NOLOGINを確認。Migration 019用roleは存在しない。検証後にも既存DBは同じmigration 018、`arvc_audio_analysis`なし、12 MBのまま。

backup folder `/home/raric/arvc-db-backups` mode 700、files mode 600。dump 484,791 bytes / 474 KB、SHA-256 `419b29dda2dd504fa8fe90f766c0a73290d6d0133b7ebb15f0f99c95859e2f62`。globals 8,274 bytes / 8.1 KB、SHA-256 `f603275fdafb4af16c9e5a19d989f0c0ec91bbe70e7c5027c5474b1730772706`。両hashは過去報告値と一致。`pg_restore --list`はCustom/gzip archive、TOC 747 entries、source/dumperとも17.11。ACL、DEFAULT ACL、event triggerのentryを確認。`globals.sql`は無条件実行していない。

## 2. 隔離環境・restore

新規internal network `arvc-step7k46-isolated`、専用volume `arvc-step7k46-dbdata`、container `arvc-step7k46-restore`を作成。Image IDは既存imageと同じdigest。container ID `3ae0c6f0740b5f7e2c61fdf0f517e6860bfb28b3ba475a66113191be7268ba7d`。healthcheck healthy。5432/tcpはhostへpublishせず、既存network/volumeを共有しない。ランダムな初期passwordはmode 600の一時env fileで渡し、値は表示・記録していない。

Supabase PG imageが初期roles/schemaを作ることを確認し、`globals.sql`全体は実行せず、欠けているrole namesとpassword/VALID UNTILを除いた属性だけを隔離clusterに用意。password hashesはcloneへコピーしなかった。初期`postgres` DBのbootstrap objectと衝突させないよう、`template0`からscratch DBを作りarchive restoreを先に確認。その後Migrationのdatabase名条件に合わせ、隔離container内で初期`postgres` databaseを作り直して同じbackupをrestore。

初回restoreはdatabase user `postgres`ではarchive owner `supabase_admin`へSET ROLEできず、`must be able to SET ROLE "supabase_admin"`で失敗。部分restoreを成功扱いせず、隔離先DBを作り直しsuperuser `supabase_admin`で再実行した。最終`postgres` DBへの`pg_restore --username=supabase_admin --exit-on-error`は終了code 0、stderr 0 bytes。PG17.11、58 user tables、history最新018、6 event triggers、extensions 5種を確認。

テスト途中の非成功は以下のとおりで、いずれも隔離DB外への変更なし：Supabase imageが既に作成していたroleへの重複`CREATE ROLE`は停止後、存在確認して不足分だけ用意。core SQLの初回quota/concurrency assertionはテスト用daily capが早く先に到達して`concurrency`ではなく`quota_exceeded`を返したため、test-only limitを調整してrollback suiteを再実行。次の実行では一時fixture tableに専用roleのSELECT grantがなく失敗したため、temp tableだけへ権限を足して再実行し全assertions PASS。直接ACL確認の最初のDO試験はshell dollar-quote typoでSQL syntax errorとなり、修正後にpermission denied assertion PASS。

## 3. Migration 019・role / RPC / ACL

適用対象：`supabase/migrations/20261104000100_step7k42_audio_analysis_quota.sql`。SHA-256 `21b524f9ffd4677070f047c47447ca7a0fb36d048f6fdaf301d8050c13a33024`。適用直前のrestore historyは018まで。新規隔離containerのdatabase `postgres`だけへpsql `ON_ERROR_STOP=1`で適用、終了code 0。

Migration内`REVOKE arvc_audio_analysis FROM postgres`はmembershipがなかったためWARNINGを出したが、適用に失敗していない。適用後、version/name `20261104000100 / step7k42_audio_analysis_quota`をhistoryへ登録。直接psql applyのため`schema_migrations.statements`はNULL（CLI statement capture未取得）。

`arvc_audio_analysis`を隔離DB内でLOGIN化し、ランダムpasswordをprivate一時fileから設定。TCP login成功。値を画面・repo・報告へ出さず、検証後に一時secret fileと隔離container/volume/networkを削除。

`supabase/verification/step7k42-audio-analysis-privilege-invariants.sql`はLOGIN前後に実行し7/7 `true`：

- role制限属性・role membershipなし
- 専用roleの4 RPC EXECUTEのみ、direct table privilegeなし
- anon/authenticated/service_role/arvc_ai_budget/arvc_asset_verifierはRPC EXECUTE不可
- 4 RPCがSECURITY DEFINER、owner postgres、`search_path=''`
- 3表RLS + FORCE RLS、application roleのtable ACLなし
- global controlのdefault disabled、各service quota/rate/concurrency limit 0

専用LOGINでprivate RPCを呼んで`disabled`応答、直接`audio_analysis_usage` SELECT拒否を実測。実repositoryの一時Go probeで`audiobudget.NewPostgres` DB pingとdefault-deny Reserve (`ErrDisabled`)も成功。probe sourceは作業後に削除し、app code/migrationには変更なし。

## 4. 実DBシナリオ・結果

すべて新規隔離DB内のテストuserに限定。通常系SQL suiteはtransaction rollback。quota値は境界を検証する一時値であり運用推奨値ではない。

| 検証 | 結果 |
|---|---|
| control disabled / 0 quota default-deny | `disabled`、static defaults pass |
| entitlement欠落・disabled・期限切れ | `not_entitled` |
| user/global daily/monthly caps | exact boundaryで`quota_exceeded` |
| user/global concurrency | 既存reservation中に次の同user/別userが`concurrency_exceeded` |
| 独立2 TCP connectionの同時Reserve | `reserved` 1件、`concurrency_exceeded` 1件 |
| request-window burst | 2回目`rate_limited` |
| kill switch | Reserve/Start双方でdisabled。Start拒否時reservationはreservedのまま |
| reservation lifecycle | reserve/start/release、pre-start releaseと同一state retry成功、runningのrelease拒否 |
| settlement | succeeded/failed、同state retry成功、別state retry拒否、不正state SQLSTATE 22023 |
| lease recovery | backdateしたreserved leaseはreleased、running leaseは`expired_charged` |
| retention | 91日経過finalized rowがReserve時lazy delete |
| Go DB store | `NewPostgres` ping、RPC Reserve default-deny成功 |

lease recoveryはDB test fixtureの`lease_until`を過去に設定して決定論的に検証。実時間の60秒待機や本番負荷試験は行っていない。

検証後、fixture user 0件、Audio usage row 0件、control disabled/0 limits/lease 900秒に復帰を確認。隔離container/volume/networkを削除し、最終`docker ps`では既存Supabase stackのみhealthy/running、既存volume/network一覧も元の名前のまま。

## 5. 変更・停止対象・未解決事項

既存Supabase DB、既存volume `supabase_db_audio-reactive-visual-compiler`、existing network `arvc-supabase-loopback`、Hosted環境はread-only確認のみ。migration 019は既存DB/Hostedへ適用していない。backup/global dumpは変更なし。

今回のみの変更：

- 新規：`docs/SUPABASE_SETUP_AND_MIGRATION.md`
- 更新：`docs/reports/2026-11-04-step7k-46-supabase-setup-migration.md`、`docs/CURRENT_STATE.md`、`CURRENT_TASK.md`
- application code、既存migration、verification SQLは変更なし。

未解決/対象外：direct SQL適用のmigration history rowはversion/nameのみで`statements` NULL。Hosted Supabase、実JWTを用いたHTTP Audio Analyze全経路、Cloud、実時間lease expiry、実運用quota値は未確認。

## 6. validation

- Backup SHA-256一致、archive TOC読取成功、隔離DB restore終了code 0 / stderr 0 bytes
- Migration 019 apply成功、version/name登録
- Privilege invariant SQL：7/7 `true`
- Go DB probe：PASS
- SQL rollback suite：全assertion PASS
- Parallel reservation test：上限1を超えない
- `git diff --check`: 成功
- Existing DB latest migration 018、audio roleなし、DB size 12 MBを作業後再確認
