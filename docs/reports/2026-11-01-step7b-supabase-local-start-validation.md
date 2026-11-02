# Step 7b：Supabaseローカル環境の起動検証

日付：2026-11-01  
状態：**completed**（指定されたローカル起動・health・bind条件を確認）

## 結果

Supabase CLI v2.122.0で`[realtime].enabled = false`と`--exclude realtime`を併用し、専用network `arvc-supabase-loopback`上でlocal Stackを起動した。published portはすべて`127.0.0.1`および`::1`に限定され、Auth、PostgreSQL、Data API、Storageが応答した。Realtime containerは作成・稼働していない。ユーザー許可に従いStackは起動状態で維持している。

## 実施内容と確認結果

- 作業前にDocker Desktop 4.97.0（依頼者提示）、Docker Client/Engine 29.9.2、memory assignment 7,925,329,920 bytes（約7.38 GiB）、16 CPUsを確認した。
- Supabase CLIは固定導入済みのv2.122.0を使用した。Hosted login/link/db pushは使用していない。
- `supabase/config.toml`の変更は`[realtime].enabled = true`から`false`へのみ。Python `tomllib`でTOML妥当性を確認した。migration directoryとseed fileは存在せず、新規作成していない。`db push`、`db reset`、明示的なmigration実行は行っていない。
- 起動コマンドは`supabase start --network-id arvc-supabase-loopback --exclude realtime`。CLIの出力は保存・報告せず、秘密情報を採取していない。
- 起動中は11個のSupabase project containerを確認。全published portは次の通りで、HostIpにwildcardはなかった。

| サービス | Host port | 実効HostIp |
|---|---:|---|
| PostgreSQL | 54322 | `127.0.0.1`, `::1` |
| Kong API | 54321 | `127.0.0.1`, `::1` |
| Studio | 54323 | `127.0.0.1`, `::1` |
| Mailpit / Inbucket | 54324 | `127.0.0.1`, `::1` |
| Analytics / Logflare | 54327 | `127.0.0.1`, `::1` |

残るservice portsはDocker network内のみでHost bindingなし。全containerのRealtime image ancestor検索にも該当がなく、`docker ps -a`上にもRealtime containerはなかった。起動中Realtime serviceはない。過去の「Realtime containerが起動した」という観測の原因は、当時の詳細なcontainer証跡がないため引き続き未確定。

### Health

- Auth `/auth/v1/health`：HTTP 200
- Data API `/rest/v1/`：HTTP 200
- Storage `/storage/v1/status`：HTTP 200
- PostgreSQL：`pg_isready`がaccepting connectionsを報告
- Supabase containerのhealthcheck対象はhealthy。Docker healthcheckを持たないREST/Edge Runtime serviceは上記HTTP probeまたは起動状態で確認。

応答本文、API key、DB接続情報は出力・保存していない。

### Resourceと既存資源

起動約4分後の`docker stats --no-stream`で11 containerのmemory合計は約1,654 MiB（約1.62 GiB）。memory値はその時点のcontainer使用量であり、WSL全体のfree memory値ではない。各対象containerで`OOMKilled=false`、restart count 0。CPU使用率は各containerで低値（最大約2.67%）だった。

作業前後でtunescout containerは同一IDのまま停止状態であり、tunescout DB/Redis volumeと既存Supabase DB/Storage volumeは保持された。専用networkのoptionも維持され、Supabase containerが接続された。Supabase Edge Runtime用named volumeが起動時に新規作成された。これは追加データであり、既存volumeの置換・削除ではない。

起動ではRealtime以外の設定有効serviceも起動した（Studio、Edge Runtime、analytics等）。本検証は指定されたStack全体の起動確認として実施した。CLI起動に伴う内部初期化動作のSQL文単位の内容は採取していないため、明示的なユーザーmigrationが実行されていないことと区別する。

## 変更ファイル

- `supabase/config.toml`：Realtimeを無効化。
- `CURRENT_TASK.md`：本作業契約と完了状態。
- `docs/ENVIRONMENT_SETUP.md`：安全条件、起動・検査結果、現行環境の注意事項。
- `docs/CURRENT_STATE.md`：確認済み状態。
- `docs/OPEN_ISSUES.md`：loopback bindと現在のRealtime除外結果を反映。過去原因は未確定として保持。
- 本報告書。

## 制約遵守と未確認事項

Hosted Supabase接続、Supabase login/link/db push、DB reset、volume削除、prune、tunescout変更、アプリケーションコード変更、Gemini呼び出し、GitHub pushは行っていない。認証情報・接続文字列は報告書に含めない。テストスイートは変更コードを伴わないローカル環境検証のため追加実行していない。

過去Realtime観測の詳細な発生原因、実環境での認証ユーザー作成・RLS policy動作、アプリケーションからのCRUD接続は今回の対象外または未検証であり、Step 7bのアプリ実装開始前に別途検証が必要。現時点でStackは稼働中。
