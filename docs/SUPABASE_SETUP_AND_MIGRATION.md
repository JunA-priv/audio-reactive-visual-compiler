# Supabase環境構築・DB移行・バックアップ・復元手順

この文書は本リポジトリのSupabase環境を調査・再構築するときの標準手順です。**環境固有値・実測例・設計案・未確認事項を区別**し、現在の設定と異なる環境では必ず対象を再特定してください。API・migration・検証SQLと食い違う場合はコードを正本とし、無断でmigrationや公開APIを変更しません。

関連資料：[PROJECT_CONTEXT](PROJECT_CONTEXT.md)、[DEVELOPMENT_RULES](DEVELOPMENT_RULES.md)、[CURRENT_STATE](CURRENT_STATE.md)、[ENVIRONMENT_SETUP](ENVIRONMENT_SETUP.md)、[SECURITY](SECURITY.md)。Step 7k-46の当日記録は[報告書](reports/2026-11-04-step7k-46-supabase-setup-migration.md)。

## 状態ラベル

- **標準手順**：再利用可能な安全手順。
- **実測例**：2026-11-04に本作業環境で確認した値。別環境への一般化はしない。
- **FACT / source-confirmed**：設定・SQL・コードから確認できる事実。DB実行済みを意味しない。
- **設計案 / 未検証**：この実行環境で実行できていない手順。
- **未確認**：対象環境で実DB検証が必要な事項。

## 1. 環境の境界

| 環境 | 用途・責務 | DB / Auth / Storage | 接続・issuer | role / migration | 許可範囲・禁止操作・復旧 |
|---|---|---|---|---|---|
| ローカル開発 | WSL2上でアプリの統合開発。Supabase CLIのlocal stackを使う構成を想定。 | DBはローカルPG、AuthはローカルGo JWT検証対象、Storageはlocal stack。設定上のAPI/DB/Studio portは54321/54322/54323。Realtime無効。 | `SUPABASE_URL=http://127.0.0.1:54321`、issuer `http://127.0.0.1:54321/auth/v1`。DB DSNはloopbackのみ、`sslmode=disable`。 | migrationは`supabase/migrations/`のversion順。Project/Asset/AI budget/Audio Analyzeはそれぞれ専用role/DSN。 | 対象project id・container・volumeを先に特定。ローカル検証DBに限って変更。既存の開発DBへの破壊操作・未確認migration適用は禁止。復旧は事前dumpを別DBでrestore検証してから行う。 |
| 隔離検証 | バックアップ復元、migration、権限・quotaの使い捨て統合検証。 | 専用Postgres container・volume・networkを新規作成。DBのみ。Auth/Storageは必要性とSupabase固有依存を評価し、不要なら公開・接続しない。 | container内 loopback/network alias。host port publishなし。接続は隔離ネットワーク内の検証clientのみ。JWT issuerはlocal sourceに従うが、実Auth確認をしない限りfixture JWTとは区別。 | DB内検証用role/dataのみ。restore後migration historyを確認し、対象migrationだけ適用。 | 既存container/volume/networkと共有しない。検証資産だけ削除可。失敗時はログ採取後に隔離環境だけ破棄し、既存DBには戻さない。Step 7k-46でこの構成を一度実測。 |
| Hosted Supabase | 将来の限定公開・運用DB候補。ローカル値を流用しない。 | Hosted DB/Auth/Storageはproject/plan/settingsごとに確認。今のHosted実設定は未確認。 | HTTPS canonical issuer/JWKS、remote PostgreSQLは`sslmode=verify-full`。project ref、audience、signing key方式は実projectで確認が必要。 | migration適用前にHosted migration履歴とSupabase plan/接続方式/専用LOGIN role利用可否をread-only確認。 | 今回の許可範囲外。Hosted変更、データ変更、本番migrationは禁止。障害復旧・PITR/backup保持/restore手順は契約・設定確認後に個別定義する。 |

`supabase/config.toml`はCLI local stackの設定ファイルであり、稼働中DBのidentityやHosted設定の証明ではありません。config上はproject id `audio-reactive-visual-compiler`、DB major 17、DB port 54322、shadow port 54320、API 54321、Studio 54323、Auth signup有効、refresh token rotation有効、Realtime無効、Storage有効です。これらも実稼働値と決めつけず確認します。

### 1.1 2026-11-04 local実測例

以下はStep 7k-46再開時に読み取り専用で再確認した値です。隔離DB値は当検証containerで実測しました。別環境では転記せず再測定します。

| 項目 | 2026-11-04実測例 |
|---|---|
| OS | Windows 11 / WSL2 Ubuntu 24.04 |
| DB container | `supabase_db_audio-reactive-visual-compiler` |
| PostgreSQL / image | 17.11 / `public.ecr.aws/supabase/postgres:17.11.0.006` |
| Image ID | `sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2` |
| database / size | `postgres` / 12 MB |
| Auth / DB / Studio | `127.0.0.1:54321` / `127.0.0.1:54322` / `127.0.0.1:54323` |
| Auth health | HTTP 200 |
| DB volume / network | `supabase_db_audio-reactive-visual-compiler` / `arvc-supabase-loopback` |
| Host tools | Docker available、Supabase CLI / `psql` not detected |
| Container tools | `psql`、`pg_dump`、`pg_restore` available |
| Entrypoint / data mount | Entrypoint `sh`; Supabase SQL generation then `docker-entrypoint.sh postgres -D /etc/postgresql`; actual mount `/var/lib/postgresql/data` |

再確認した既存DBはhealthy、`arvc-supabase-loopback` networkと既存volumeを使用。`supabase_migrations.schema_migrations`の最新は`20261101001800_openai_gpt6_luna_budget_pricing`、databaseは12 MB、`arvc_audio_analysis`なし。既存`arvc_ai_budget` / `arvc_asset_verifier`はLOGIN、`arvc_project_writer`はNOLOGIN。既存DBへは以後もread-only照会のみ。

## 2. 対象確認コマンド

### 2.1 Tool availability

```bash
command -v supabase || true
command -v psql || true
command -v docker || true
```

目的：ホスト側CLIの有無を確認。`docker`が見つかってもdaemon/socketの利用可否を保証しません。認証情報を含むコマンド出力を記録しないでください。

### 2.2 container・Auth

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' \
  http://127.0.0.1:54321/auth/v1/health
```

成功条件：意図するcontainer名・状態・portを確認でき、Auth healthがHTTP 200。containerが見つからない、portが想定外、HTTP 200以外、daemon拒否の場合はidentity不明として停止。設定値だけで稼働中と判断しません。

### 2.3 DB identity・schema・roles

`DB_CONTAINER`は読み取り専用で確認した正確な名前を設定します。例の文字列を別環境にそのまま使わないこと。

```bash
DB_CONTAINER=supabase_db_audio-reactive-visual-compiler
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -P pager=off -c \
  "SELECT current_database(), current_user, version();"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -P pager=off -c \
  "SELECT current_database(), pg_size_pretty(pg_database_size(current_database()));"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -P pager=off -c \
  "SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 10;"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -P pager=off -c \
  "SELECT rolname, rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname LIKE 'arvc_%' ORDER BY rolname;"
docker exec "$DB_CONTAINER" psql -U postgres -d postgres -X -P pager=off -c \
  "SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='arvc_internal' ORDER BY p.proname;"
```

成功条件：server/database/userが意図したlocal DBと合致し、migration履歴・role・RPC結果を保存できる。version・履歴・roleが想定と異なる、`schema_migrations`がない、または接続先が判別不能ならmigrationを止める。`current_user=postgres`はsuperuser管理接続の証拠であり、アプリDSNに使う根拠ではありません。

### 2.4 Docker image・entrypoint・mount・隔離資産名

```bash
docker inspect --format 'Image={{.Config.Image}} ImageID={{.Image}}' "$DB_CONTAINER"
docker inspect "$DB_CONTAINER" --format 'Entrypoint={{json .Config.Entrypoint}}
Cmd={{json .Config.Cmd}}
User={{json .Config.User}}
WorkingDir={{json .Config.WorkingDir}}'
docker inspect "$DB_CONTAINER" --format '{{range .Mounts}}{{.Type}} {{.Destination}} {{.Name}}{{println}}{{end}}'
docker volume ls --format '{{.Name}}' | grep -E 'supabase|arvc' || true
docker network ls --format '{{.Name}}' | grep -E 'supabase|arvc' || true
```

成功条件：実image digest、entrypoint/cmd、data mount、既存volume/networkの正確な一覧を記録できる。既存名と隔離名が衝突したら作成せず、新規一意suffixへ変更。コンテナ名・data dir・mountを推測して使わない。

## 3. Migration管理とMigration 019

正式キーはファイルversionと名前です。「Migration 019」は工程上の呼称です。

| 項目 | 値 |
|---|---|
| migration before Step 7k-47 | `20261101001800_openai_gpt6_luna_budget_pricing` |
| target SQL | `supabase/migrations/20261104000100_step7k42_audio_analysis_quota.sql` |
| SHA-256 | `21b524f9ffd4677070f047c47447ca7a0fb36d048f6fdaf301d8050c13a33024` |
| 2026-11-04 local state after Step 7k-47 | Applied to existing local DB `postgres`; latest is `20261104000100`. `arvc_audio_analysis` is LOGIN, least privilege, no membership. Immediately after HTTP tests control was restored to disabled/zero; the Browser E2E preparation in Section 10 temporarily enabled it for one existing local user. |

Source SQL review（適用内容）：

- 既存`arvc_internal`、`arvc_asset_verifier`、`arvc_ai_budget`、Supabaseの`auth.users`/`anon`/`authenticated`/`service_role`に依存。既存migration 001–018の後に適用するadditive migration。旧migrationを書き換えない。
- `arvc_audio_analysis`を`NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`、role membershipなしで作成。3表は`audio_analysis_entitlements`、`audio_analysis_control`、`audio_analysis_usage`。全てRLS + FORCE RLS。API等の直接table ACLはrevoke。control singleton初期値はdisabled、全quota/rate/concurrency limit 0、lease 900秒（60–1800秒制約）。entitlement初期値はenabled false・limits 0。
- private RPCは`arvc_internal.audio_analysis_reserve(p_user_id uuid) RETURNS TABLE(result text,reservation_id uuid)`、`audio_analysis_start(p_reservation_id uuid) RETURNS text`、`audio_analysis_release(p_reservation_id uuid) RETURNS boolean`、`audio_analysis_settle(p_reservation_id uuid,p_state text,p_safe_error_code text) RETURNS boolean`。全て`SECURITY DEFINER`, owner `postgres`, `search_path=''`。EXECUTEは専用roleのみ。
- reserveはsingleton `FOR UPDATE` lockの下、UTC日/月 user/service quota、entitlement・expiry、request window burst、global/user concurrencyを確認しreservationを作る。disabled/未entitled/quota/rate/concurrency拒否結果を返す。開始済attempt数は`started_at`で数える。未開始expired reservationはreleased、expired runningはcharged `expired_charged`へ回収。finalized ledgerを90日超でlazy delete。
- startはkill switch/limitsを再確認しreservation・entitlement・quota・concurrencyを再評価してrunningへ移す。lease expiryはrelease。releaseはreservedのみ、同一released再試行は成功。settleは`running`からsucceeded/failed/canceledへ変更し、同じstateのretryは成功、別state/不正入力は拒否。分析開始後は成功・失敗・cancelいずれも1 attemptとして課金対象。
- RLS/ACLとprivate RPCによりdefault deny。control row/kill switch無効、0 quota、entitlement欠落/無効/期限切れでは実行不可。DB障害はGo側unavailableとしてfail-closed。

### 3.1 適用前後チェック

1. 接続先 identity・直近migration履歴・backupとrestore可否を確認。checksumを再計算しレビュー。
2. 対象が使い捨て隔離DBであること、外部公開portなし、既存volume/network不共有を確認。
3. migration historyが`...001800`までの期待順序と一致すること。欠落・分岐・既適用なら停止して差分調査。
4. 承認済みDBに限り、CLIなら`supabase migration list --local`で差分確認後`supabase migration up --local`を使う。CLIが対象DBと一致すると確認できない場合は実行しない。CLIがなく、forward-onlyの明示承認がある場合の実測fallbackは、read-only preflight→migration SQL→正確なversion/nameの履歴登録を`psql --single-transaction -v ON_ERROR_STOP=1`の同一transactionで実行すること。Supabase [CLI reference](https://supabase.com/docs/reference/cli/introduction)では`migration list`はtimestampのみ比較するため、`statements=NULL`でも通常のforward list/upは履歴versionで判定できる。ただしCLIが記録するSQL statement配列と同一ではない。CLI `fetch/down`での扱いは未確認なので使用しない。rollbackは事前backupのreviewed restoreで行い、history rowを手作業で消さない。
5. `supabase/verification/step7k42-audio-analysis-privilege-invariants.sql`を**管理者接続の検証専用DBだけ**で実行し、各`ok=true`を確認。実行前にroleの未作成/既存状態を比較。
6. migration後の`arvc_audio_analysis`はNOLOGINである。API実装はDSN usernameが同名であることを要求し、passwordも必要。role属性を確認後、隔離DBのみで運用責任者承認のLOGIN設定を実施（例：`ALTER ROLE arvc_audio_analysis LOGIN;`後、psql interactive `\password arvc_audio_analysis`でpassword設定）。passwordをSQL引数・shell history・ログへ書かない。migration後のLOGIN化は別の運用変更として監査し、role membershipを付与しない。
7. table ACL/RLS, RPC EXECUTE, owner/search_path, disabled/zero defaultsを確認し、専用DSNでGo store接続だけ確認する。control/entitlement quotaを設定するまではrouteまたはDB側でdefault deny維持。

実測時、7 privilege invariant中1件が初回失敗した場合はmembershipのgrantorを調査する。Supabase bootstrapが`arvc_audio_analysis`を`postgres`へ`supabase_admin` grantorで付与していると、non-superuser `postgres`が実行したmigration内REVOKE後もmembershipが残ることがある。Step 7k-47では`supabase_admin`で当該専用roleから`postgres`だけをREVOKEし、7/7再PASSを確認した。他roleのmembershipを一括変更しない。

Rollbackは`DROP`で逆操作しません。隔離DBなら失敗内容とログを保存後、その**隔離専用**volume/container/networkを破棄して検証前 snapshotから作り直します。共有・Hosted DBではsnapshot/point-in-time restore可否とforward repairを別途レビューします。Migration history行を手で削除しません。

## 4. Backup・archive検証

Logical backupはDB objects/dataを対象にし、`--no-owner`によりarchive restore時のowner復元要求を抑制します。globals dumpはrole/tablespace等を含み得るため秘密/権限情報として扱い、確認なしに実行しません。Supabase managed schemas/extensions, ACL/default ACL, event triggers, publications/large objects, ownership, external Storage objects/Auth secrets, JWT signing keys, network/edge settingsはDB dumpだけで完全復元できるとは限りません。backup scopeを明記し、Storage/media/object backupとDB backupを別計画にします。

```bash
mkdir -p /home/raric/arvc-db-backups
chmod 700 /home/raric/arvc-db-backups

docker exec "$DB_CONTAINER" pg_dump -U postgres -d postgres -Fc --no-owner \
  > /home/raric/arvc-db-backups/before-change.dump
docker exec "$DB_CONTAINER" pg_dumpall -U postgres --globals-only \
  > /home/raric/arvc-db-backups/globals.sql
chmod 600 /home/raric/arvc-db-backups/before-change.dump /home/raric/arvc-db-backups/globals.sql
sha256sum /home/raric/arvc-db-backups/before-change.dump /home/raric/arvc-db-backups/globals.sql
```

出力先をGit管理外のアクセス制御された領域に置き、空き容量確認、終了code、non-empty、サイズ、sha256を記録。source/restore clientのPG major compatibilityも記録。`pg_dump`成功はrestore成功ではありません。

2026-11-04の報告値：`step7k46-before-migration.dump` 474 KB、`step7k46-globals.sql` 8.1 KB、SHA-256はdump `419b29dda2dd504fa8fe90f766c0a73290d6d0133b7ebb15f0f99c95859e2f62`、globals `f603275fdafb4af16c9e5a19d989f0c0ec91bbe70e7c5027c5474b1730772706`。pg_dump/pg_restoreは17.11との報告。

```bash
set -o pipefail
docker exec -i "$DB_CONTAINER" pg_restore --list \
  < /home/raric/arvc-db-backups/before-change.dump | tail -5
docker exec -i "$DB_CONTAINER" pg_restore --list \
  < /home/raric/arvc-db-backups/before-change.dump \
  | grep -E 'SCHEMA|EXTENSION|EVENT TRIGGER|ACL' | tail -40
```

`set -o pipefail`でproducer/consumer双方の失敗を検知する。より厳密にはlistを一時ファイルへ保存し、`pg_restore --list`終了codeを直接確認する。archive listは読み取り可能性/TOC確認にすぎず、restore成功の証明ではない。報告時点のarchiveにはSupabase固有ACL、DEFAULT ACL、event triggerが含まれていた。

## 5. 隔離DB restore（Step 7k-46で実測）

以下は2026-11-04に実行し、PG17.11 image上で成功したrestore構成です。resource名は例なので、他環境では既存container/volume/network一覧と衝突しない名前を選びます。image tagだけでなくdigestも一致させます。初期管理passwordはランダム生成しmode 600の一時env fileから渡し、fileはcontainer作成後に除去します。host portは一切publishせず、`--internal` networkを使います。

```bash
docker network create --internal arvc-step7k46-isolated
docker volume create arvc-step7k46-dbdata
docker run -d --name arvc-step7k46-restore \
  --network arvc-step7k46-isolated --network-alias db \
  --mount type=volume,src=arvc-step7k46-dbdata,dst=/var/lib/postgresql/data \
  --env-file /tmp/arvc-step7k46-db.env \
  --health-cmd 'pg_isready -U postgres -d postgres' \
  --health-interval 2s --health-timeout 2s --health-retries 30 \
  public.ecr.aws/supabase/postgres:17.11.0.006
```

実測container ID `3ae0c6f0740b5f7e2c61fdf0f517e6860bfb28b3ba475a66113191be7268ba7d`、image ID `sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`、healthy。`5432/tcp`はhostにpublishされず、専用volume/networkだけをmount/attach。image default `docker-entrypoint.sh postgres -D /etc/postgresql`でPG17.11起動を確認。

Backupを再検証し、archive headerはCustom/gzip、TOC 747 entries、dump source/by 17.11。ArchiveにはSupabase ACL/DEFAULT ACL、6 event triggers、5 extensionsが含まれた。`globals.sql`は**実行していない**。image初期化で既にあるroleを確認し、restoreに必要なrole名と属性だけをglobalsから抽出、password/VALID UNTILを除いて新規隔離clusterに反映した。role membershipは新Supabase image既定値を維持し、`arvc_*`にmembershipがないことを照合。既存roleがある状態でrole作成を再実行するとduplicate/reserved role errorになるため、role状態確認後に不足分だけ用意します。

このbackupに適用済みのlogical restore手順：

1. backup SHA-256を`419b29dda2dd504fa8fe90f766c0a73290d6d0133b7ebb15f0f99c95859e2f62`と照合し、`pg_restore --list`の成功とTOCを確認する。
2. Supabase imageの初期`postgres` databaseにはbootstrap schemaがある。新container内に`arvc_restore`を`template0`から作り、archiveをそこへrestoreして先に確認する。
3. archive内ownerへSET ROLEできるsuperuser `supabase_admin`を使う。`postgres` userでの初回試行は`must be able to SET ROLE "supabase_admin"`で失敗した。部分復元DBは隔離container内だけで作り直した。
4. 本migrationはDB名`postgres`へのCONNECT grantを行うため、template0から作り直した隔離containerの`postgres` DBへ同じarchiveをrestoreする。実際は保守接続先として、既に成功済みの`arvc_restore` DBから隔離container内の`postgres` DBをdrop/recreateし、再restoreした。

```bash
docker exec -i --user postgres arvc-step7k46-restore \
  pg_restore --username=supabase_admin --exit-on-error --dbname=arvc_restore \
  < /home/raric/arvc-db-backups/step7k46-before-migration.dump
```

上記は一度終了code 0、stderr 0 bytes。最終検証対象`postgres` DBも同じコマンドの`--dbname=postgres`でrestoreし、終了code 0、stderr 0 bytes。`--exit-on-error`を維持し、stderrはprivate fileに記録して評価。実測後DBはPostgreSQL 17.11、58 user tables、最新history 018、6 event triggers、extensions `pg_stat_statements` 1.11 / `pgcrypto` 1.3 / `plpgsql` 1.0 / `supabase_vault` 0.3.1 / `uuid-ossp` 1.1。restore successはarchive読み込みの代替ではなく、DBへrestoreを完了してこれらを照合した結果です。

最初の`pg_restore`試行は実エラーで終了し、成功扱いしません。DB接続user `postgres`がarchiveのowner `supabase_admin`へSET ROLEできなかったことが原因。隔離DBを新しく作り直し、`supabase_admin`で再実行して成功しました。既存DBは関与していません。

MigrationはCLIがなく直接SQLでapplyしました。SQLはexit 0、warningは既存membershipなしの`REVOKE arvc_audio_analysis FROM postgres`に対するもの。ACL invariantに合致し、全検証checkはtrueでした。Supabase migration履歴にはversion/nameを隔離DBへ登録しましたが、CLI statement captureはできず`statements`列はNULLです。Hosted/local既存DBにはこの手順を使わず、可能ならSupabase CLI migration workflowを使います。

実際の隔離資産名：container `arvc-step7k46-restore`、volume `arvc-step7k46-dbdata`、internal network `arvc-step7k46-isolated`。検証後にこの3つだけを削除し、最終`docker ps`/volume/network一覧に隔離名が残らず、既存Supabase stackは引き続きhealthy、既存volume/network名はそのままと確認。既存Supabaseリソースへの`down`, `rm`, `prune`, `reset`, `volume rm`は禁止です。

## 6. Audio Analyze設定・JWT・fail-closed

`api/.env.example`と`api/cmd/server/main.go`を正本とし、`.env.example`のdefaultはAudio Analyze disabledです。起動時に`AUDIO_ANALYSIS_ENABLED=true`なら`SUPABASE_AUDIO_ANALYSIS_DSN`必須、DB pingを含む専用store初期化と検証済みJWT validatorが成功しなければAPIは起動しません。`.env.example`中の他設定は現ファイルを参照し、secret値はコピーしません。

```dotenv
BLUEPRINT_MODE=fixture
API_ADDR=127.0.0.1:8080
AUTH_ENV=local
CORS_ALLOWED_ORIGINS=
OPENAI_MODEL=gpt-6-luna
OPENAI_API_KEY=
AI_GENERATION_ENABLED=false
AUDIO_ANALYSIS_ENABLED=false
SUPABASE_AUDIO_ANALYSIS_DSN=
PYTHON_ISLAND_EXECUTABLE=../python-island/.venv/bin/python-island
PYTHON_ISLAND_DIRECTORY=../python-island
FFPROBE_EXECUTABLE=ffprobe
AI_FIXTURE_UNLIMITED_LOCAL=false
AI_FIXTURE_UNLIMITED_USER_ID=
PROJECTS_ENABLED=false
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ISSUER=http://127.0.0.1:54321/auth/v1
SUPABASE_ANON_KEY=
SUPABASE_ASSET_VERIFIER_DSN=
SUPABASE_AI_BUDGET_DSN=
```

上記はtarget/safe-default例であり、`AUDIO_ANALYSIS_ENABLED=true`でもDSN空のまま起動できる意味ではありません。DSNはPostgreSQL接続先で、Supabase URL/anon keyではありません。local例は資格情報を安全に作成した後だけ、ignored `api/.env`に設定します：

```text
postgresql://arvc_audio_analysis:<URL-encoded-password>@127.0.0.1:54322/postgres?sslmode=disable
```

DSN userはコード上`arvc_audio_analysis`固定です。migrationで作るroleはNOLOGINなので、隔離DB/承認済みlocal DBでのみrole LOGIN/password provisionを別工程で行います。管理者DSNや他専用roleのDSNで代用しません。Hosted remoteでは`sslmode=verify-full`とhostname証明書検証を必須にし、本番情報をlocalへ持ち込みません。

`AUTH_ENV=local`はlocal issuer/JWKS経路（default issuer `SUPABASE_URL/auth/v1`）です。`AUTH_ENV=hosted`はHosted canonical HTTPS issuer/JWKSを使い、local issuerへfallbackしません。Hosted issuer/project ref、JWKS ES256、audience/claimsは実環境で確認し、local JWT secretをHostedへ流用しません。Hosted CORSはexact HTTPS originsのcomma-separated allowlist、wildcard禁止。HTTPS frontend/API、Auth redirect allowlistも同じorigin方針で設定します。

JWT検証またはDB quota store障害時はfail-closed。global `audio_analysis_control` switch、service quotas/burst/concurrency、各user entitlement/quotaは全て明示設定が必要。欠落・disabled・0 quotaはdefault-deny。service_role key、JWT secret、password、DSN、real tokenをdotenv例・Markdown・Git・logsへ書きません。

## 7. 実DB検証計画と完了条件

隔離DB restore完了後に限ってMigration 019をapply。確認表：

| 領域 | 受入確認 |
|---|---|
| restore | checksum一致、`pg_restore`終了0、migration history/schema/table/role/ACL/RLS/functions/extensions/event trigger確認 |
| apply | exact migration filename/version/checksum、apply成功、履歴登録、既存DB無変更 |
| role/RPC | role属性・LOGIN運用設定・membershipなし、正確な4 RPC signature、専用role EXECUTEのみ、owner postgres/fixed search_path |
| RLS/ACL/default deny | 3表RLS + FORCE RLS、全API role tableアクセス不可、RPC以外アクセス不可、disabled/0 quota/entitlementなし拒否 |
| quota | user/service daily/monthly boundary、UTC day/month、concurrency/burst/kill switch、独立pool同期競合で上限超過なし |
| lifecycle | pre-start failure release/unbilled、start時再検査、success/failure/cancel charged、settlement same-state retry idempotent、other-state reject、expired reserved release、running lease `expired_charged`、90-day finalized retention |
| Go integration | dedicated DSN ping、Reserve/Start/Release/Settle、DB断時fail-closed、DSN user/TLS policy。Media/JWTをDB ledgerへ保存しない |

### 7.1 Step 7k-46実DB結果

2026-11-04、新規隔離containerの`postgres` DBで実施。Migration 019適用後に`arvc_audio_analysis`をLOGINにし、ランダムpasswordをprivate mode-600一時fileから設定。値は出力せず、検証完了後に一時file/containerを削除。専用roleのTCP loginとDB名`postgres`を確認。Go `audiobudget.NewPostgres` probeで実DB pingとReserve default-deny (`ErrDisabled`) が成功。

`supabase/verification/step7k42-audio-analysis-privilege-invariants.sql`をLOGIN設定前後で実行し、7 check全て`true`：role制限/membershipなし、4 RPCのみEXECUTE、application roles不可、SECURITY DEFINER owner/fixed search_path、3表RLS+FORCE RLS、API roles table accessなし、control default disabled/limits 0。実LOGINでRPCを呼び、直接`audio_analysis_usage` SELECTがpermission deniedになることも確認。

隔離fixtureはrollback型SQLで実行し、制限値はテスト専用。確認済み：missing/disabled/expired entitlement拒否、per-user/global daily・monthly上限、window burst、user/global concurrency、kill switchのReserve/Start、pre-start release、Start、success/failure settlement、同一state retry冪等、異state retry拒否、不正state SQLSTATE 22023、expired reserved→released、expired running→`expired_charged`、91日経過finalized rowのlazy delete。leaseはDB内で期限をbackdateして回復を決定論的に実行した（実時間60秒待ちは未実施）。独立2 TCP接続を同時起動したraceでは`reserved` 1件、`concurrency_exceeded` 1件。テスト後、auth fixture user 0件、audio usage row 0件、controlはdisabled/0 limits/lease 900秒へ復帰。

direct SQL applyではmigration history version/nameを登録し、`statements`列はNULL（CLI statement captureなし）。適用SQLは成功したが、CLIが記録する`statements` metadataと同一ではないため、CLIへ切り替える環境ではhistory行の扱いを先に照合します。Migration実行時のwarningは`postgres`→`arvc_audio_analysis` membershipが元々存在せず、`REVOKE`が出したもの。exit 0、role membershipなし、全privilege invariant pass。

未検証：Hosted環境、HTTP Audio Analyze全経路/実JWT、実time passageによるlease expiry、Cloud環境。これらは今回の隔離DB統合検証結果に含めません。

実施ログには正常系・異常系・境界値、SQL result、終了code、原因、未確認を記録。DBで走らせたverification SQLの各checkが`true`であること。テスト後、隔離DB内のfixtureを除去するか隔離volumeを破棄します。Hosted実接続・移行は別承認・別検証です。

## 8. 安全停止条件

対象identity/既存資産一覧不明、backup checksum不一致、restore未実証、migration履歴不一致、専用role/credentialが作れない、supabase init behavior不明、既存volume/network共有リスク、Docker/API権限拒否、外部公開portが必要になる場合は停止し、成功扱いしません。手動で既存資産を消したり、権限昇格・本番接続へ迂回しません。

## 9. Step 7k-47 local実DB実測（2026-11-04）

既存local container `supabase_db_audio-reactive-visual-compiler` のDB `postgres`にMigration 019を適用。直前dumpは484,791 bytes、SHA-256 `4ed781ab40e6a75a499e27271822eaba2899783543706e59435527c3dc3bef84`、globalsは8,274 bytes、SHA-256 `28c58710d67b45532da3fc7d1ac764d94f6ed9af6ae2c2335ae6ed50b041b81b`、archive TOCは755行。適用後の7 privilege invariantは全PASS。`arvc_audio_analysis` TCP login、実JWT/default deny/entitlement/quota/rate/kill switch、same-user/global concurrency、SCNet standard HTTP 200・Timeline v1・settlement、client cancel/SIGTERMを検証。検証後、temporary Auth users/entitlement/usageを削除しcontrolをdisabled/zeroに戻した。RoleはLOGINのまま、passwordは検証後に破棄したため再利用できない。Hosted/Browser E2Eは未実施。詳細・実コマンド・失敗と原因：[Step 7k-47 report](reports/2026-11-04-step7k-47-local-supabase-audio-analysis-integration.md)。

## 10. Browser Editor E2E準備状態（2026-11-04）

Browser E2E準備として、既存ローカルAuthユーザー1名だけに2時間期限のentitlement（daily/monthly 2、concurrency 1）を設定し、controlはservice daily/monthly 2、global concurrency 1、60秒windowあたり2要求で一時有効化した。既存使用量は0件。Authは1ユーザー、AI budgetは10行、Projects/Assets/Storage objectsは0件のまま。ユーザーアカウント・パスワードは変更していない。状態変更はE2Eの一時準備であり、検証後のcleanupが必要。

Dedicated role用のfresh passwordはmode-600 `/tmp/step7k47-browser-dsn` にだけ置き、APIプロセスに読み込ませた。資格情報自体は記録しない。独立Go APIは`127.0.0.1:8081`でhealth 200、独立Viteは`127.0.0.1:5174`で200、Audio Analyze proxyは未認証401を返す。Vite起動例（`frontend/`で実行）：

```bash
ARVC_API_PROXY_TARGET=http://127.0.0.1:8081 npm run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

APIは`/tmp/step7k47-run-api.sh`で起動し、`api/.env`を読み込んだ後に`API_ADDR=127.0.0.1:8081`、`AUTH_ENV=local`、`AUDIO_ANALYSIS_ENABLED=true`、`AI_GENERATION_ENABLED=false`、`PROJECTS_ENABLED=false`、fixture unlimited false、専用DSNをプロセス限定で上書きする。既存8080/5173 listenerは変更していない。ブラウザ操作は未実施で、既存ユーザーのログイン資格情報を用意できることが前提。

E2E後、Step 7k-47報告書のSection 9に記載したguarded cleanup SQLを実行し、controlをdisabled/zeroへ戻して対象ユーザーのusage/entitlementだけ削除する。その他のAuth/AI budget/Projects/Assets/Storageは変更しない。cleanup後にcontrol defaults・entitlement 0・active usage 0を確認し、8081/5174だけを停止して一時DSN/launcher/cleanup fileを消す。2時間のentitlement expiryはあるが、expiryだけではglobal controlはdefault-denyに戻らないため、cleanupを必ず実行する。
