# Step 7b：Supabase Auth・所有者別Project CRUD実装報告

実施日：2026年11月1日  
状態：**completed（ローカルSupabase限定）**

## 実装範囲

ローカルSupabase Authのuser JWTをGo/Echoで検証し、利用者JWTをSupabase Data APIへ引き継ぐProject CRUDを追加した。Hosted Supabase、素材保存、Frontend cloud UI、認証画面は対象外。既存`.arvproj v1`、Renderer/WebM、Python Island、Gemini経路には変更なし。

資料全体のAPI状態は引き続きPROPOSEDだが、`docs/API_CONTRACTS.md`のStep 7b local sectionに限り本実装のrequest/responseをDECIDEDとして記録した。

## API・データ契約

| Method / path | 成功 | 主な拒否 |
|---|---:|---|
| `POST /api/v1/projects` | 201 | 400/401/409/413/422 |
| `GET /api/v1/projects?limit=&cursor=` | 200 | 400/401 |
| `GET /api/v1/projects/{id}` | 200 | 400/401/404 |
| `PUT /api/v1/projects/{id}` | 200 | 400/401/404/409/413/422 |
| `DELETE /api/v1/projects/{id}` | 204 | 400/401/404 |

Create documentは`documentVersion`, `metadata`, `blueprint`, `featureTimeline`からなるProjectDocument v1。Blueprint v1とFeature Timeline v1の内部JSONを保持し、既存Blueprint validatorと独立Timeline validatorへ通す。DBに保持するのは編集データだけ。画像背景、assets、音源バイナリを必要とするProjectは拒否し、削除して保存する動作はない。

タイトルは1–120 rune、documentは最大1 MiB、userあたり最大20 Projects。cursorは`updated_at,id`のkeyset。Updateはrevision比較をDB RPC内の`SELECT FOR UPDATE`と合わせ、古いrevision/同時更新を409にする。所有者と不存在を同じ404へ写像する。Deleteはhard deleteでAuth user削除時はFK cascade。

## JWT・DB境界

ローカルAuthのJWKS metadataで`ES256`/EC鍵を実測した。Go JWT validatorはES256だけを許可し、固定loopback HTTP issuer（`/auth/v1`）、audience=`authenticated`、role=`authenticated`、必須exp、UUID subjectを検証する。JWKS取得はtimeoutを設定し失敗時にfail closed。token/key/JWKS本文をログしない。ownerは検証済みJWTのsubから決める。

Go APIからData APIへはuser JWTとanon/publishable keyのみ送る。service_roleは通常CRUDに使わない。local integration testの一時Auth user cleanupに限りservice_roleを使い、Go APIへ渡さない。

Migrationは以下を追加した。

- `20261101000100_step7b_projects.sql`：projects、FK、基本制約、RLS/GRANT、更新RPC、user件数・document byte trigger
- `20261101000200_step7b_project_privilege_hardening.sql`–`00500_step7b_project_role_grant_cleanup.sql`：update RPC実行権の絞り込みと補助role membership cleanup
- `20261101000600_step7b_project_writer_auth_schema.sql`：初期のauth schema permission試行。effective USAGEは確認されず、後続migrationでauth schema参照を除去
- `20261101000700_step7b_project_rpc_claim_scope.sql`：PostgRESTの検証済みJWT claim settingを使うowner-scoped RPC/RLS predicate
- `20261101000800_step7b_revoke_service_role_projects.sql`：Supabase default ACL由来のservice_role table accessをrevoke

projectsにRLSとFORCE RLSを有効化。anon/service_roleはCRUD不可、authenticatedはowner-scoped select/insert/delete、更新は限定RPC経由。owner_idはinsert policy・triggerでJWT claimと一致することを検証。20件上限はowner単位transaction advisory lock付きtrigger、1 MiBはAPIとDBで検証する。補助roleはNOLOGIN/NOBYPASSRLS、最終確認でauth schema USAGE/public CREATEなし。RPC権限はauthenticatedのみでanon/service_roleにはなし。

**Migration適用上の注意：** 既存local DBでは001–004、006、008を通常runnerで適用。005は`supabase_admin` grantorのmembership revoke、007はhelper role grant/SET ROLE権限が不足するため、各SQLをlocalhost専用containerへ`psql -U supabase_admin`で適用し、`supabase migration repair`でlocal historyへ記録した。007に必要なtemporary public CREATEは適用後にrevoke済み。fresh DBでの失敗位置と全手順の再現結果は[Step 7b-1 Migration再現性報告](2026-11-01-step7b-1-migration-reproducibility.md)。Hosted Supabaseには接続していない。

## 実統合試験

ローカルAuthで一時user A/Bを作成し、Auth access tokenを使用した。終了時cleanup後にAuthテストuser数0、projects row数0を確認した。

- Auth user A：create/list/get/update/delete成功、レスポンスからowner_idを除外
- Aのdocument roundtrip一致、stale revisionは409、同じrevisionの同時PUTは一方200・一方409
- user BのA project get/update/deleteは404
- JWTなし・anon Data API拒否、owner_id偽装拒否
- Data API直接RESTでRLS owner filter、通常table update禁止、anon/service_role table access拒否、21件目のinsert拒否、1 MiB超過拒否
- Go API cursor pagingで20件を10件ずつ重複なし取得、limit=21拒否
- JWT単体テスト：正常ES256、期限切れ、issuer/audience/role/subject不一致、署名不一致、HS系/不許可alg、exp欠落、tamper、token過大を拒否

統合fixtureの管理用key値、user access token、Auth応答本文、DB接続情報は表示・保存・ログ出力していない。

## 依存・検査

- `github.com/MicahParks/keyfunc/v3 v3.8.2`：JWKS取得/更新、JWT v5との接続。Apache-2.0。既存SDKへの変更なし
- `github.com/golang-jwt/jwt/v5 v5.3.1`：厳密な許可algorithmとclaims validation。MIT
- `github.com/MicahParks/jwkset v0.11.3`, `golang.org/x/time v0.15.0`：JWKS依存として追加
- Go 1.27.3: `gofmt`, `go test ./...`, `go vet ./...`成功。local Supabase統合試験成功
- Frontend: 5 test files / 32 tests、typecheck、lint、build成功。Frontendコード変更なし
- `git diff --check`成功

## 未確認・後続

- migration 007の新規clone/新規local Supabaseでの管理ロール適用手順を再現確認する
- Hosted SupabaseのJWKS issuer・key rotation・PostgREST設定は対象外
- Step 7c素材Storage、Step 7d Frontend cloud save UI未実装
- API認証handlerはlocal loopback用issuer固定。Cloud公開設定として使えない
- DB 1 MiB制約はPostgreSQL JSONBの`document::text` UTF-8 byte長。Go APIの受信JSON byte制限も合わせて適用する

