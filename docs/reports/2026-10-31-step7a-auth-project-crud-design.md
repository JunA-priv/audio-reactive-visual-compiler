# Step 7a — 認証・Project CRUD 詳細設計案

日付：2026-10-31
状態：**設計案（未承認・未実装）**

## 1. 目的と結論

Step 7「認証・保存」を実装可能な単位にするため、既存資料・コードとSupabase公式資料を照合した。推奨する基本線は、Supabase Authでログインし、Go APIがSupabase access tokenを検証したうえで、利用者JWTを保ったデータ経路とRLSの両方で所有者境界を守ること、Project JSONと大容量素材を分離すること、Storage操作をAPI経由または利用者JWT付きStorage APIに限定すること。

これは設計提案であり、API契約、DBスキーマ、署名方式、保存制限、保持期間は未決定である。現行の正式仕様を書き換えたり、Supabase projectやクラウドを変更したりしていない。

月額1,000円以内はプロジェクトの目標であって請求上限の保証ではない。Supabase公式価格ページの現行表示ではFreeは$0でDB 500 MB、Storage 1 GB等を含む一方、Free projectは1週間非アクティブだとpauseされる。Proは月額$25からと表示されており、為替・税等を考慮すると目標を超える可能性が高い。無料枠だけで継続運用できる保証はなく、料金・上限は実装・公開前に再確認が必要。[Supabase料金](https://supabase.com/pricing) [Billing limits](https://supabase.com/docs/guides/platform/billing-on-supabase)

## 2. 既存資料・コードから確認した事項

### 既存の決定・方針

- `docs/HANDOVER.md`のStep 7はSupabase Auth、JWT検証、所有者単位の認可、Project CRUD、データ保持・削除を挙げる。Step 8がCloudflare Pages、Cloud Run、Supabase、R2等の本番公開を扱う。
- `docs/API_CONTRACTS.md`では、GoがSupabase JWTを検証し、Project・解析ジョブ・素材を所有者単位で認可する方針はDECIDED。ただしAPIの正式パス、JSON、status、OpenAPI、サイズ等の制限はPROPOSED。
- `docs/REQUIREMENTS.md`のM15〜M17は、Supabase認証、不正JWT拒否、所有者だけのProject取得・更新・削除、未認証固定デモを要件としている。
- ローカル編集・`.arvproj`保存復元は認証なしで引き続き利用する前提。`.arvproj` v1はBlueprint、Feature Timeline、背景data URL、任意音源を含む平文JSON、上限64 MiB（音源32 MiB）。`.arvb`暗号化は鍵管理未確定でBLOCKED、今回対象外。
- BlueprintのEditor v1とFeature Timeline v1は現時点でProject/API全体の正式schemaではない。既存契約の破壊的変更は避ける必要がある。

### 現実装

- Go/Echo APIはloopback限定で、`GET /healthz`と`POST /api/v1/blueprints/generate`を提供。Auth、DB、Project CRUD、Storage連携はない。
- FrontendはReact/TypeScript/Vite。Projectの保存・復元はローカルファイル処理で、サーバー同期や認証状態はない。Vite `/api` proxyはローカルGo API向け。
- Python Islandは解析処理を担当し、Auth・DB・Project永続化の実装はない。

## 3. 推奨アーキテクチャと責務境界

```text
React/Vite
  ├─ Supabase Auth: ログイン、token refresh、logout
  ├─ ローカルEditor / .arvproj: 認証なしで利用可能
  └─ Authorization: Bearer <user access token>
       ↓
Go/Echo API
  ├─ JWT signature / issuer / audience / time / subject検証
  ├─ Project入力検証、サイズ・頻度制限、所有者認可
  └─ 同じ利用者JWTを保持したDB/Storage操作
       ↓
Supabase Data API (PostgREST) + PostgreSQL RLS
Supabase Storage + Storage RLS
```

**推奨する初期接続案：** GoがAuthorization headerの利用者JWTを検証後、Supabase Data APIへ同じ利用者JWTとpublishable keyを使ってアクセスする。RLSが`auth.uid()`をJWTの`sub`から得てDB行を絞るので、Goの所有者フィルタとDBポリシーを独立した二重チェックにできる。Goはuser JWTを別ユーザーの値に差し替えたり、クライアント指定owner IDを認可根拠として使わない。publishable keyは公開識別子であり秘密情報ではないが、RLSがデータ境界を担う。

Supabase公式資料は、RLSはtable privilegeとpolicy双方が必要であること、`service_role`はRLSをbypassするためサーバーだけに置くことを明記している。[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) このため通常CRUDでservice-role/secret keyを使う案は推奨しない。管理操作が将来必要になっても、通常リクエスト経路から隔離し、対象操作を最小化した別権限・監査経路を設ける。

**代替案：** Goから直接PostgreSQLへ接続し、所有者条件をすべてのSQLへ付ける。DB側RLSも使うなら、接続roleはtable owner/superuser/BYPASSRLSでないこと、`FORCE ROW LEVEL SECURITY`を含むrole/table構成、利用者IDをtransaction内で安全に設定する仕組みを確認する必要がある。通常のPostgres接続ではSupabase Data APIのようにHTTP JWTから自動で`auth.uid()`が設定されるわけではない。独自GUCを設定するだけの設計では、同一DB roleから任意値を設定できる条件やSQL injection時の影響を評価しなければならない。したがって現段階ではData API経由案を優先し、直接DB接続は接続role/RLS伝播をローカルで実証できてから再検討する。

素材はPostgreSQLのbyteaへ無条件に格納せず、Storage objectに分離する。Project metadata rowとAsset metadata rowにはowner/project/object key、MIME、byte size、SHA-256等だけを持たせる。音源/画像の内容はStorage APIを通す。直接Storage APIを使う場合もJWTとRLS policyが必要で、Storageの`owner_id`はアクセス制御そのものではなく、policyで照合して初めて意味を持つ。[Storage ownership](https://supabase.com/docs/guides/storage/security/ownership) Storage object削除はSQLで`storage.objects`行を消すだけではファイルが消えないため、必ずStorage APIから削除する。[Delete objects](https://supabase.com/docs/guides/storage/management/delete-objects)

## 4. Auth、Frontend session、JWT検証案

### ログイン方式の推奨案

React SPAなので、Supabase JavaScript clientでAuthセッションを持ち、起動時のsession復帰、token refresh、logoutを担当させる。Go APIへ送るのはaccess token。Frontendが表示するuser objectやリクエストbodyの`ownerId`を認可根拠にしない。

小規模な個人MVPでは、メールOTPまたはMagic Linkが候補。Supabaseの標準SMTPは本番向けではなく、現行公式資料では事前許可アドレスのみ、送信数は現在2通/時などの制約がある。一般利用者向けにはcustom SMTPの構成と費用確認が要る。[Email passwordless](https://supabase.com/docs/guides/auth/auth-email-passwordless) [SMTP](https://supabase.com/docs/guides/auth/auth-smtp) OAuthを選ぶ場合はprovider登録・redirect URL・秘密情報管理が追加になる。どの方法を正式採用するかは未決定。

ブラウザー内永続sessionは実装が簡単だが、XSSが成立するとtokenを読み取られるリスクがある。React SPAのlocal storageを許容するか、HttpOnly cookieを扱うBFF構成にするかは、脅威モデルと実装コストを踏まえて判断する。BFFはCSRF対策・cookie設定・session refresh proxyも要し、現行Go APIを大きく変える。認証導入時はCSP、入力のHTML扱い、依存更新、tokenをログへ出さないことも確認する。

### Go APIのtoken検証

推奨検証項目：

1. `Authorization: Bearer`が1個だけあり、token長が上限内である。
2. JWT署名を、固定したSupabase project issuerに属する鍵で検証する。アルゴリズムは許可リストと鍵型に束縛し、`alg=none`やalgorithm confusionを許さない。
3. `iss`は設定済みproject URLのAuth issuerと完全一致、`aud`は`authenticated`、`exp`は未失効であることを必須とする。必要なら`nbf`も検証する。
4. `sub`は非空のSupabase user UUIDとして妥当であり、全owner FK・filterの唯一の根拠にする。
5. `role`は利用者requestでは`authenticated`のみを許可する。`service_role`、`anon`やクライアント指定roleで権限を昇格させない。追加claimは明示して使うもの以外を認可に使わない。

Supabaseは非対称署名鍵を使う場合、`<project>/auth/v1/.well-known/jwks.json`を公開し、JWT `kid`に対応する公開鍵で検証する方法を案内している。issuer、audience、signature、expiryの検証例も提供する。[JWT/JWKS](https://supabase.com/docs/guides/auth/jwts) JWKS endpointはSupabase edge側で10分cacheされると説明され、失効・rotation時はcache期間を考慮する必要がある。[Signing keys](https://supabase.com/docs/guides/auth/signing-keys)

実装前に対象Supabase projectのsigning algorithmを確認する。JWKSに公開鍵がない対称署名構成ではJWKS方式だけで検証できない。推奨は非対称 signing keyを用いることだが、project設定変更は今回行っておらず、切替可否・既存tokenとの移行を確認して決める。代替としてAuth user endpoint照会を使うならrequestごとにAuthへの依存・可用性・rate limitが増えるため、offline local検証を含めて評価する。JWT検証ライブラリは自作せず、実装時に保守状況・Go互換性を調査して選定・固定する。

JWKS cacheは短く上限を設け、未知`kid`時に一度だけ再取得するなどrotationに備える。JWKS取得失敗時に未検証tokenを受け入れない。token、Authorization header、JWKS秘密相当設定、メール等の個人情報をログ出力しない。利用者削除後も発行済みJWTはexpiryまで有効な場合がある。即時失効が必須ならsession照合等が必要で、追加のDB依存とのトレードオフを判断する。[User deletion/session behavior](https://supabase.com/docs/guides/auth/managing-user-data)

## 5. Project CRUD API契約案（PROPOSED）

API prefixは既存`/api/v1`と整合する案。これは既存Blueprint APIの正式契約を意味せず、認証Project APIの新規提案。

| Method / path | 用途 | 成功案 |
|---|---|---|
| `POST /api/v1/projects` | Project作成 | `201`, Project表現、`ETag` |
| `GET /api/v1/projects?cursor=...&limit=...` | 自分の一覧 | `200`, items/nextCursor |
| `GET /api/v1/projects/{projectId}` | 自分のProject取得 | `200`, Project表現、`ETag` |
| `PUT /api/v1/projects/{projectId}` | 全体置換更新 | `200`, Project表現、更新後`ETag` |
| `DELETE /api/v1/projects/{projectId}` | Project削除要求 | 同期完了なら`204`; 非同期削除採用時は別途202契約 |

共通：Bearer token必須。UUID path ID。ownerIdはrequest bodyに受け付けず、serverが検証済み`sub`から設定する。Project payloadはunknown fieldを拒否し、version、item count、JSON byte sizeを検査する。listは最大50件などの小さい上限を置き、`updated_at DESC, id DESC`のkeyset cursorとする。cursorはowner scopeをまたげず、opaqueにする。

作成の二重送信は`Idempotency-Key`を所有者scopeで保存し、同じkey・同じbody digestなら元の結果を返し、異なるbodyなら`409`とする案。DBにunique `(owner_id, idempotency_key)`を置く。更新は`ETag`/`If-Match`必須とし、古いversionとの競合を`409 Conflict`で返す。これはlost update防止と二重更新時の誤上書き防止を簡潔にできる。プロジェクトが単一利用者・単一編集端末だけなら、Idempotency-Keyやversion要件を軽くする代替もあるが、まず競合制御を持つ案を推奨。

### Status案

| Status | 適用条件案 |
|---|---|
| `400` | JSON構文不正、path/query/cursor不正 |
| `401` | token欠落・不正・署名不一致・期限切れ |
| `403` | 認証済みだが機能/デモ用途等の明示的権限不足。owner不一致を外部へ区別しない案を推奨 |
| `404` | ID不存在または他ユーザー所有。存在有無を隠すため同一応答 |
| `409` | version競合、Idempotency-Key再利用body不一致、削除中などの状態競合 |
| `413` | request全体、Project JSON、asset bytesの上限超過 |
| `415` | unsupported Content-Type / asset MIME |
| `422` | schema/version/参照/素材hash等の意味検証エラー |
| `429` | user/IP単位のrequest、upload、生成回数制限超過。`Retry-After`を返す |
| `5xx` | storage/DB/queue failure。内部情報、SQL、provider bodyは返さない |

Error bodyは既存APIのsanitize方針を踏襲し、安定した`code`, `message`, `requestId`のみ。owner不一致を403と404で分けるとresource enumerationを助けるため、project CRUDでは`404`に統一することを推奨。`401`には認証challenge headerを必要に応じて付ける。CORSの許可originは開発・本番の明示allowlistとし、wildcard＋credentialsを避ける。

### Project JSON / version案

DB rowと編集documentを分離する案：

```json
{
  "id": "<uuid>",
  "title": "<bounded string>",
  "documentVersion": 1,
  "blueprintSchemaVersion": 1,
  "featureTimelineSchemaVersion": 1,
  "rendererVersion": "editor-renderer/1",
  "analysisVersion": "<version>",
  "seed": 0,
  "blueprint": { "...": "existing EditorBlueprint v1" },
  "featureTimeline": { "...": "existing FeatureTimeline v1" },
  "assets": [{ "id": "<uuid>", "kind": "audio|background", "mimeType": "...", "byteSize": 0, "sha256": "..." }],
  "createdAt": "<server timestamp>",
  "updatedAt": "<server timestamp>"
}
```

`ownerId`, object storage key、server timestamps、quota accountingはserver/DB管理で、clientから受け取る値を信用しない。Blueprint/Timelineは現v1 shapeのままJSONBに保存し、schema versionを明記してread時にGo側validationを行う。未知versionは拒否または明示migration対象にし、silent coercionしない。将来migrationは旧版をfixtureに往復検証し、migration前バックアップとrollback planを用意する。

DB row案：`projects(id UUID PK, owner_id UUID FK auth.users, title, document_version, blueprint_schema_version, feature_timeline_schema_version, renderer_version, analysis_version, seed, blueprint JSONB, feature_timeline JSONB, created_at, updated_at, deleted_at?)`。`project_assets(id UUID, owner_id, project_id, kind, object_key unique, mime_type, byte_size, sha256, created_at)`。Owner scope composite unique/FK（`(owner_id, project_id)`）を用い、素材行が別owner projectを指せないようにする。JSONB全体上限・配列長・nested JSON depthもGo validationで固定する。soft deleteは復元/猶予が必要と決まった場合のみ採用する。通常はhard delete＋明示猶予なしの方が容量・削除の説明が単純。

## 6. 素材保管、容量、保持・削除

### 素材設計案

- PostgreSQLはProject metadata、Blueprint、Feature Timeline、Asset metadataのみ。音源・画像byte列をDBへ保存しない。
- Supabase Storageを候補とする（HANDOVERの採用方針候補）。private bucketを使い、object keyを`<owner UUID>/<project UUID>/<asset UUID>`とする。ファイル名は表示用metadataで、pathには使わない。
- 音源は現在のlocal `.arvproj`上限32 MiBを後方互換の初期上限候補とする。画像上限は現Editor validationとdata URL上限に整合するbyte limitを別途決める。Storage free plan global file limitは公式資料上最大50 MBで、bucket単位でそれ以下に絞れる。1ファイル上限と合計storage quotaは別物。[Storage upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
- Upload前にowner/projectの利用枠を予約し、完了時に実byte size/hashを検証して確定。失敗/中断時は予約を解放し、temporary objectを掃除する。content-typeだけを信用せず、拡張子/MIME/sniffed signature・音源形式を確認する。既存Python Island/FFmpegへ任意第三者音源を送る安全性課題は解消済み扱いにしない。
- `assets`はProject documentにobject keyだけを含めず、Asset IDを参照する。signed URLを使う場合は短時間、有効期限最小、owner check後に発行する。JWT/RLSで直接取得する方式との比較が必要。
- `.arvproj` v1はローカルportable fileとして維持。クラウドProjectへのimport/export時にAsset upload/downloadを別処理し、既存ファイル内のdata URL/音源をそのままPostgres request JSONへ載せない。背景image data URLを既存Blueprint schema内で維持するには、サーバー保存時のasset extraction/reference mappingか、現schemaを変えずdata URLをそのままproject JSONに置くかを決める必要がある。契約を変えない前提では、API境界でasset referenceを解決してEditor v1へ戻す変換層を設ける案を推奨。ただしこの変換は再現性、hash、API上限、format migrationを要するため設計確定事項。

### 容量・費用制御案

候補初期制限（要承認）：Project 20件/user、Project document 2 MiB、音源1個最大32 MiB、画像1個最大8 MiB、合計asset 100 MiB/user、作成/更新/upload回数をuser/IPごとにrate-limit。これらは現行UIや利用想定を測っていない案であり、確定値ではない。公式のSupabase Free Storage総枠は1 GB、DB枠500 MBで、サービス全体のquota。app側user quotaは別途DBで強制しなければならない。[Pricing](https://supabase.com/pricing) 大きなFeature TimelineのJSONもDB quotaを消費するので、圧縮保管やFeature TimelineをObject Storageへ分ける閾値も、実サンプル容量を測ってから決める。

月額目標を守る案として、Free tierに留め、storage/database/egressのアプリ側上限をSupabase free quotaより十分低く設定し、利用状況を監視する。利用枠到達で自動的に有料tierへ切り替えず、upload/createを拒否して管理者へ通知する。Free tierのpause、backup/retention制限、カスタムSMTP費用を受容できるかは判断が必要。上限は請求額そのものを保証しない。Pro planへ移ると公式現行表示は$25/月からで、1,000円目標を超えうるため、事前の明示承認なしに変更しない。

### 削除・再試行整合性案

Object StorageとPostgresは一つのtransactionでatomicに削除できない。project deleteはstate machineを採用する：

1. transactionでowner-scoped projectを`deleting`に変更し、通常更新/uploadを止める。
2. DB asset listからobject keyを取得し、Storage APIのremoveを小batchで実行。成功したobjectだけ削除済み記録にする。delete requestは同一projectに対して冪等。
3. すべて成功した後にasset rowsとproject rowをhard-delete。
4. Storage delete失敗は再試行可能な`deletion_pending`状態として記録し、APIは内部request idを返す。無制限retryはしない。期限・運用者介入・失敗通知を別途決める。
5. orphan objectの定期検出・掃除はStorage listing＋DB参照照合を行うが、retentionと費用負担を決定してから導入する。

最小MVPでは非同期queueを追加せず、1 projectあたりasset件数に小さい上限を置いてAPI同期削除を試みる案もある。ただし部分失敗時のpending markerは必要。Supabase Auth user削除はStorage owner objectが残ると失敗する場合があるため、account deletion順序は「ProjectとStorage objectを消す→Auth user削除」を基本とし、削除完了確認を行う。[Managing users](https://supabase.com/docs/guides/auth/managing-user-data)

保持案：利用者が削除しない限り無期限保管は推奨しない。MVPではProjectをユーザー操作で明示削除、アカウント削除時は全Project/assetsを削除し、非アクティブ期限による自動削除は初期導入しない案を推奨する。Free project停止と個人データ保持を混同しない。soft-delete/復旧猶予を選ぶ場合、その期間、物理削除SLA、Storage orphan掃除を明示する。バックアップに残る削除済みデータの期間はプラン確認後に公開する。

## 7. 未認証デモとローカル利用

- EditorのローカルFixture、ローカル`.arvproj` import/exportはAPI authに依存させず、従来どおり認証なしで使えるようにする。
- 固定デモはread-onlyのサーバーfixtureだけを公開する。user projectのlist/get APIへ匿名アクセスさせない。Gemini生成やPython audio analysis、uploadなど課金/高負荷処理は未認証demoで起動しない。
- デモとProject CRUDのrouter/middleware、Storage namespace、fixture IDを分け、project idを推測してもuser resourceにアクセスできないことをテストする。
- Vite開発はloopback Go API proxyを維持し、local Supabaseへだけ接続する。公開FrontendはVITE変数にpublishable keyとURLのみ置ける。service/secret key、DB password、JWT signing secretをVITE環境・browser bundleへ置かない。

## 8. ローカル・非本番の検証案

Supabase CLIはlocal Postgres/Auth/StorageをDocker-compatible runtimeで起動し、version control可能なmigration/seed/test workflowを提供する。ローカルstackはTLSなし、rate limitなし、default credentialsのdevelopment用なので外部公開しない。[Local development](https://supabase.com/docs/guides/local-development) [CLI workflow](https://supabase.com/docs/guides/local-development/cli-workflows)

**推奨検証段階：**

1. `supabase start`のloopback local stackでAuth/DB/Storageを起動。実メール送信なしでlocal mail catcherを使う。DB schema、grants、RLSをmigration化し、CIで`supabase test db`/pgTAP allow-deny checks。
2. Go integration testsでlocal asymmetric signing key/JWKS、issuer/audience/expiry/sub/role、JWKS rotation/cache、RLS PostgRESTの実動作、Storage policyを検証。token fixtureはテスト用だけ。
3. User A/User Bを作成し、AのCRUD成功、BからAのGET/PUT/DELETE拒否、存在しないIDと他owner IDが同じ404になることを確認。
4. Local Supabaseの別test project/userでReact session復帰/refresh/logoutとAPI bearer token連携をブラウザ統合テスト。
5. hosted non-production projectを使う実認証検証は、別Project、非本番データ、Free tier/料金とメール送信制限を確認し、Project作成・設定変更の許可を得てから行う。今回の範囲では作成しない。

Supabase公式CLIはローカルスタック利用にcontainer runtimeを要求する。現環境でDocker/Podmanが使えるかは今回調査していない。使えない場合はCI runnerまたは公式の実験的native stackを評価できるが、native modeはexperimentalと記載されている。[Docker/native runtime](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)

## 9. エラー・制限・観測

- Auth:欠落/invalid/expiredは401。JWKS取得不能をtoken不正扱いに固定するか503にするかはavailability方針を決める。推奨は検証失敗と依存障害を区別し、失効確認なしに許可しない。token文字列はログしない。
- Owner boundary:他ユーザーのProject IDは404。全SQL/API操作でowner scopeを固定し、DB RLSでもdeny-by-default。
- Validation:unsupported document/Blueprint/Timeline schemaは422。payload/asset byte上限は413。MIME/asset signature不一致は422または415。
- Concurrency:stale If-Matchは409。request idempotency key reuse mismatchは409。
- Quota/rate:per user and IP throttle 429 with Retry-After。無料枠逼迫時は429/507系の固定API error codeを返し、paid tierへの自動変更は禁止。
- Logs/metrics:request id、route、status、latency、opaque project UUID hash、bytes/count/quota resultだけ。JWT/email/asset content/Blueprint body/Storage URL signing tokenは出さない。監視保持期限も要決定。

## 10. テスト計画・受入条件案

| 分類 | 受入テスト案 |
|---|---|
| JWT | missing/malformed/wrong signature/wrong issuer/aud/expired/not-yet-valid/wrong role/missing or malformed subを拒否。unknown kidでkey refresh。JWKS outageでfail closed。secret/tokenはlogsに出ない |
| RLS / Owner | Aは自分の各CRUD成功。BとanonはAのidへアクセス不可。A/Bのinsert/updateでowner spoof不可。DB direct policy testでSELECT/INSERT/UPDATE/DELETEをrole別にallow/deny |
| API | request/response schema、unknown fields、2MiB等の上限、413、404 masking、stable error envelope、CORS allowlist、pagination cursor owner isolation |
| CRUD | create/read/update/delete roundtrip。ETag stale update 409。idempotency same-key replay、different-body conflict。list stable cursor ordering |
| Assets | audio/image MIME、size、hash、path traversal、owner/project mismatch、upload途中失敗、orphan cleanup、signed URL expiry。byte内容のupload/download SHA256一致 |
| Delete | object deletion succeeds then row delete; partial failure stays pending; retry is idempotent; user deletion blocked until owned object removal; no DB-only Storage deletion |
| Quota | per file/project/user limit exact boundary, concurrent uploads reserve atomically, quota release after failed upload/delete, rate 429 |
| Version | `.arvproj` v1 import/export regression; Editor Blueprint v1/Timeline v1 exact roundtrip; unknown versions rejected; version migration fixtures |
| Demo / local | unauth fixed demo works; cannot list/retrieve user resources or invoke paid operations; local auth flow and browser token refresh work |
| Regression | current Renderer determinism, local editor/export, Go and Frontend tests/typecheck/lint/build; integration tests never call Gemini or use production project |

**Step 7を完了と判断するための候補条件：** API/schemaとquota/retention decisionsが承認済み、local SupabaseでAuth→Go JWT verification→RLS-scoped Project CRUDがend-to-end成功、cross-owner拒否、Storage upload/download/deleteの失敗再試行が検証済み、未認証固定demoとlocal-only editorが維持、秘密情報/個人データloggingなし、回帰suite成功、docs/report更新。Hosted production公開・クラウド構築はStep 8として別受け入れにする。

## 11. 実装着手前に必要な判断

| 判断事項 | 推奨案 | 代替/影響 |
|---|---|---|
| Login provider | Supabase Auth email OTP/Magic Link | OAuthはprovider設定が必要。一般利用にはcustom SMTP費用・運用が必要 |
| Session storage | SPA Supabase client管理、access tokenをGo APIへ | HttpOnly-cookie BFFはXSS耐性向上余地があるがCSRF・proxy実装を追加 |
| JWT signing | 対象projectがasymmetric keyならJWKS verification | HS signingではJWKS公開鍵がなく、project移行かAuth online verifyの判断が必要 |
| DB access | Data API/PostgRESTへ利用者JWTをforwardしRLS適用 | Direct PGはroleとRLS context伝播の証明が必要 |
| RLS coverage | 全project/asset tableへRLS、必要grantのみ、deny by default | `service_role` CRUDは通常経路で禁止。使用するなら隔離・監査設計が必要 |
| Project payload | Existing Editor Blueprint v1/Timeline v1をJSONBで維持、version列を追加 | 正式な共通schemaへ広げるのは別migration/compatibility work |
| Background image | API境界でasset extraction/reference mappingを設計 | data URLのまま保存は簡単だがDB/response容量を膨らませる |
| Storage provider | Private Supabase Storage, JWT/RLS, separate metadata | R2はHANDOVER Step8候補。先行導入するとStep boundary/cost/privacyを変える |
| Limits | 上記初期案をlocal負荷試験で調整 | 32MiB音源×複数でFree 1GBを急速に消費し得る |
| Retention | 明示削除まで保持、account deletion cascades app data; no auto-expiry initially | soft-delete grace period/非活動削除は明示期間と費用が必要 |
| Delete behavior | state marker + idempotent Storage API delete + DB finalize | synchronous onlyは部分失敗の再開を保証しにくい |
| Guest demo | read-only fixed fixture only, no auth bypass on user route | anonymous auth userは認証済みroleとなるためpublic static fixtureとは区別 |
| Local integration | Supabase CLI local stack + Auth/Storage/Postgres + pgTAP | 現環境Docker可用性、導入依存/ディスク/メモリ負荷が未確認 |
| Budget policy | Free tierを上限としusage limitで拒否、paidへの自動移行なし | 料金上限の保証にはならない。無料枠のpauseやSMTP制約を受容する必要 |

## 12. 未確認事項

- 対象Supabase projectのJWT signing algorithm、issuer/audience実値、Free/paid plan、現在の使用量は未確認。
- Supabase CLIおよびDocker/PodmanのWSL利用可否、local stack resource usageは未確認。
- 具体的なproject quota、rate、retention期間、素材最大数、background image byte上限、Project JSON上限は未決定。
- Auth方式、メール送信方式、session保存先、アカウント削除・既発行token有効期間の扱いは未決定。
- Data API/PostgRESTと直接PostgreSQL接続の最終選択、RLS policy/grants、Storage auth経路は未実証。
- Project/Asset schema、ETag/idempotency、soft/hard delete、signed URLの採否は提案段階。
- 本番公開・運用費・backup retention・custom SMTP費用の見積は対象外。

## 13. 参照資料

- 既存資料：`docs/PROJECT_CONTEXT.md`、`docs/DEVELOPMENT_RULES.md`、`docs/CURRENT_STATE.md`、`docs/HANDOVER.md`、`docs/API_CONTRACTS.md`、`docs/REQUIREMENTS.md`、`docs/BLUEPRINT_SPEC.md`、`docs/SECURITY.md`、`docs/OPEN_ISSUES.md`。
- Supabase公式資料：
  - [JWT and JWKS](https://supabase.com/docs/guides/auth/jwts)
  - [JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
  - [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
  - [Storage ownership](https://supabase.com/docs/guides/storage/security/ownership)
  - [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
  - [Storage upload limits](https://supabase.com/docs/guides/storage/uploads/file-limits)
  - [Delete Storage objects](https://supabase.com/docs/guides/storage/management/delete-objects)
  - [Auth email passwordless](https://supabase.com/docs/guides/auth/auth-email-passwordless)
  - [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
  - [Local development](https://supabase.com/docs/guides/local-development)
  - [Local CLI workflow](https://supabase.com/docs/guides/local-development/cli-workflows)
  - [Pricing](https://supabase.com/pricing) / [Billing](https://supabase.com/docs/guides/platform/billing-on-supabase)

## 14. この作業で行っていないこと

コード、依存関係、正式仕様書、DB/schema/migration、Supabase project、cloud resources、billing、Gemini、GitHub remoteを変更していない。実装・hosted環境での認証やRLSは未検証。
