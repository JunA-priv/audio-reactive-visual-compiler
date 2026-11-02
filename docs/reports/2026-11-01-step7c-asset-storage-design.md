# Step 7c：素材保存・削除の実装設計案

実施日：2026年11月1日  
状態：**completed（read-only調査・提案。実装承認待ち）**

## 結論

推奨案は、音源・背景画像のバイナリを既存Project JSON/PostgreSQLへ入れず、Supabase Storageのprivate bucketに置き、Project所有者とAsset参照を新しいDB表で結び付ける方式である。ブラウザは認証済みユーザーJWTでStorage APIへ直接送受信し、Go APIはAssetの予約・確定・削除・project/owner整合性を管理する。Go APIによるservice_role利用、公開bucket、期限付きsigned URLを通常のアクセス経路にしない。

ただし、現在のProjectDocument v1は画像背景とassetsを明示的に拒否する。この意味制約を維持したまま画像背景を保存するには、ProjectDocument v1へdata URLや独自URIを埋め込む設計は不適切である。Step 7c実装時には、v1を不変のまま扱える**クラウド専用のversion付きEnvelope/DTO**と、Frontendの明示的なhydrate/dehydrate変換を追加する必要がある。具体的なEnvelope形状、Asset上限、アップロード方式は実装前の承認事項である。

## 確認した現状

- Goの`api/internal/projects/document.go`はProjectDocument v1を定義し、`Document`に`documentVersion`, `metadata`, `blueprint`, `featureTimeline`のみを許可する。Unknown fieldを拒否し、最大1 MiB。
- `api/internal/projects/document.go`のコメントと`api/internal/projects/handler.go`はassetsを含むProjectを意図的に拒否する。
- `api/internal/projects/handler.go`のStep 7b APIは5 CRUD endpoint。Project削除はhard delete。
- `supabase/migrations/20261101000100_step7b_projects.sql`は画像backgroundを拒否し、`document ? 'assets'`も拒否。現行`projects`表にAsset関係はない。
- `frontend/src/editor-model.ts`のEditor Blueprint v1はimage backgroundの`src`にPNG/JPEG base64 data URLを要求し、通常のURLやasset keyを拒否する。
- `frontend/src/project-file.ts`の`.arvproj` v1はBlueprint、Feature Timeline、画像data URL、任意音源をself-containedで保存する。音源は32 MiBまで、全ファイル64 MiBまで。これはローカル形式であり、クラウド送信形式ではない。
- `frontend/src/VisualEditor.tsx`は背景画像をRenderer用`RenderAssets`へmapし、背景選択中の画像オブジェクトURL等をEditor状態として管理する。
- `supabase/config.toml`にはStorage serviceの設定があるが、専用bucket/RLS migrationはない。既定コメントのbucket例は無効。
- Step 7b実装/報告はHosted環境・Storage素材保存を対象外としており、既存Migration 001–008は維持する必要がある。

## 推奨アーキテクチャ

### 責務境界

- **Frontend**：ローカルFile選択、許可形式/サイズの事前確認、SHA-256計算、Go APIのAsset制御API呼出し、Supabase StorageへのJWT付きbinary upload/download、進捗表示。公開anon/publishable keyと利用者access tokenのみ使用。
- **Go/Echo**：既存Bearer JWT検証を再利用。`sub`からownerを取得し、Project所有権、Asset metadata、quota、状態遷移を検証。Storageへ中継せず、service_roleも保持しない。Storage RLSとDB RLSを迂回しない。
- **PostgreSQL**：Project-Asset関係、所有者、用途、期待content type/size/hash、状態、quota用集計を保持。Composite FK/unique constraintとRLSでowner整合性をDBでも保証。
- **Supabase Storage**：private bucket内に実データを置く。`storage.objects` RLSでbucket、owner、project、asset ID/pathを検証する。`service_role`やStorage管理keyをブラウザ・通常Go APIへ渡さない。

### データフロー

1. FrontendがFileのサイズ/typeを検査し、SHA-256を計算する。音源・画像data自体をGemini、Python Island、Project JSONへは送らない。
2. 認証済みGo APIへAsset予約を要求。GoはProject ownerを検証し、種類/容量/個数の枠を予約する`pending_upload` Assetを作成する。server-generated UUIDを返し、object pathは`{owner_uuid}/{project_uuid}/{asset_uuid}`のようにサーバー生成し、利用者入力のpathを受け付けない。
3. FrontendがStorage APIへ利用者JWTで直接uploadする。private bucketのRLSが予約済みassetと認証sub/project/pathを突き合わせる。上書き/upsertは禁止し、既存keyへ別データを差し替えない。
4. 完了APIでGoがStorage object metadataを照合し、size/content typeを確認する。SHA-256はStorage metadataだけで保証できるとは限らないため、実装前にhashを計算する責任主体（Frontendによる再照合か、API経由stream/hash）が確定するまで`ready`にしない。検証後`ready`へ遷移する。
5. 読込はGo APIでProject/Asset metadataを認可し、FrontendがユーザーJWT付きのprivate object GETで取得する。Rendererへ渡す前にPNG/JPEGをdecodeし、`RenderAssets`へID mapする。音源は復元File相当としてWebM exportへ渡す。
6. 削除はDBで`delete_pending`を永続化してからStorage API removeを実行する。object削除後にAsset rowを削除する。どの段階でも失敗を成功扱いせず、状態を残して同じDELETEを安全に再試行できるようにする。

## Asset・DB契約案

### Asset表（新規、additive migration）

候補カラム：

- `id uuid primary key`
- `project_id uuid not null`, `owner_id uuid not null`
- `kind text`: `source_audio` / `background_image`
- `bucket_id`はサーバー定数とし保存省略可。`object_key`はuniqueかつサーバー生成
- `status`: `pending_upload`, `ready`, `delete_pending`
- `original_name`（basenameに正規化、任意）、`content_type`, `byte_size`, `sha256`
- `created_at`, `updated_at`

`projects`に`UNIQUE(id, owner_id)`を追加し、`assets(project_id, owner_id)`から複合FKを張る。これでProjectとAssetのowner不一致をDBで拒否できる。FKはProject hard delete時にAsset rowをcascade削除せず`RESTRICT`する。Storage objectの存在確認前にDB行を消せないようにする。

Asset表はRLS enabled/forced。利用者は自分のProjectに紐づくAssetのみ参照・作成・削除できる。owner_id/object_key/status等を自由に更新させず、状態遷移はGo制御の限定RPC、またはColumn GRANTとDB制約で許可対象を最小化する。service_role table accessはStep 7b同様、明示して評価する。

### Cloud envelopeと既存形式の境界

`.arvproj` v1は引き続きself-containedなローカル保存形式とし、変更しない。ProjectDocument v1もそのまま受け入れ、既存の素材なしProject CRUDとの互換性を維持する。

画像背景を含むクラウドProjectには別versioned DTOを設ける。候補は`cloudDocumentVersion: 1`, `metadata`, `editorState`, `featureTimeline`, `assetRefs`。画像背景のdata URLをDTOから除き、`backgroundAssetId`のようなAsset参照として転送する。Frontend adapterは保存前にEditor Blueprint v1から背景バイナリをAssetへ分離し、読み込み後にAssetを取得して通常のPNG/JPEG data URLまたは既存`RenderAssets`へ復元し、既存`validateBlueprint`を通してからEditorへ反映する。Timelineおよびその他Blueprint v1 fieldsは維持する。

音源FileもAsset referenceのみクラウドProjectへ結び、Project JSONへbase64を入れない。`.arvproj`のimportはクラウド保存操作を暗黙実行せず、素材をローカルだけで保持する。クラウド保存時にUploadが失敗したら素材を黙って外したProjectを保存せず、同期失敗を表示する。

## API契約案

以下は提案であり、Step 7b決定済みの5 endpoint契約を置き換えない。

| Method / path | 役割 | 成功/異常の案 |
|---|---|---|
| `POST /api/v1/projects/{projectId}/assets` | metadataを検証しupload reservation作成 | 201 `assetId`, `objectKey`, constraints, `status=pending_upload`; 400/401/404/409/413/415/422 |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/complete` | Storage objectのサイズ/type/hash照合後ready化 | 200 Asset metadata; incomplete/mismatchは422、Storage障害502 |
| `GET /api/v1/projects/{projectId}/assets` | ready assets一覧 | 200。pending/delete_pendingは返却または状態明示 |
| `GET /api/v1/projects/{projectId}/assets/{assetId}` | metadata/object ref取得。実byteはJWT付きStorage GET | 200、他人/不存在404 |
| `DELETE /api/v1/projects/{projectId}/assets/{assetId}` | delete_pending→Storage remove→row delete | 完了204。Storage/DB途中失敗は502/503で明示し、retry可能状態を残す |
| Step 7b `DELETE /api/v1/projects/{id}` | 全Assetの削除完了後にProject hard delete | 既存204を維持。関連Assetが残る/削除失敗時は成功を返さず502/503 |
| `PUT /api/v1/projects/{id}` cloud DTO | version付きasset referenceと編集データ更新 | revision競合は既存409。Asset参照が同じowner/projectのready assetでない場合422 |

すべてJWT必須。Project所有者と異なる利用者は404。API request bodyのJSON上限とbinary upload上限は分離する。Uploadは`Content-Length`を信用せず、stream読み込み時にもhard byte limitを適用する。Asset ID/object keyは利用者に任意指定させない。拡張子だけでMIMEを信用しない。

### Private bucket / RLS

専用private bucket例：`arvc-project-assets`。Public bucketは使用しない。保存pathは `{owner_uuid}/{project_uuid}/{asset_uuid}` とし、元ファイル名をpathへ含めない。owner情報はJWTから取得し、request body/pathからのowner指定を拒否する。

`storage.objects`のRLSで`bucket_id`、owner_id=`auth.uid()::text`、pathの各UUID、Asset registryのproject/owner/statusを照合する。INSERTは対応する`pending_upload`だけ、SELECTは`ready`だけ、DELETEは本人所有Assetだけとし、upsert/UPDATEは認めない。Storage docsはprivate bucketのdownloadもRLS対象、upload/overwrite/deleteはそれぞれRLS operation/policyが必要と説明する。Storage objectのmetadata ownerはJWT `sub`由来であり、service key作成はownerを設定しないため通常経路に使わない。

## 上限案（初期値・要承認）

- 音源：1 Projectあたり1個、最大32 MiB（既存`.arvproj`上限に合わせる）
- 背景：1 Projectあたり1個、PNG/JPEGのみ、最大10 MiB（現在のBlueprint data URL約14 MB文字列上限から逆算した上限に整合）
- Project合計：最大42 MiB / 2 assets
- Account：Project既存上限20件、Asset総量を初期840 MiBまで（20 × 42 MiB）。ただし全利用者合計のStorage/egress/月額費はこの値だけでは制御されず、provider-level quota/budget alertまたは運用上限が別途必要。
- Bucket/provider最大object sizeもAPI上限以下に設定する。Supabase公式docsはbucket/global制限を別途設定でき、6 MBを超えるuploadは信頼性のためTUS resumableを推奨する。32 MiB音源にstandard uploadを採るか、直接TUSを採るかを実装前に決める。
- MIME allowlistは`audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/opus`, `audio/mp4`, `audio/aac`, `audio/webm`, `audio/flac`; imageは`image/png`, `image/jpeg`。Content-Typeとsignatureの照合が必要。完全なcodec検査にFFmpegを使う案は、既知の未修正環境問題を踏まえて今回採らない。
- SHA-256は64-char lowercase hex。Client値は不trusted metadataとして扱い、信頼するためのserver-side再計算方法を定める。

Supabase公式の公開docsではFree projectsのglobal file size capは最大50 MBと記載され、bucket上限はそれ以下にできる。ただしプラン・価格・保存容量/egressは変わり得るため、月額1,000円以内を保証する根拠にはしない。Hostedを有効化する前に現行価格/usage limitsを確認する。

## 整合性・削除・再試行

StorageとPostgreSQL間に分散transactionはない。同期APIで一連の外部操作を行い、DB stateで途中結果を回復可能にする。

- ReservationはDB transaction内でProject revision/owner、種類ごとの一個制限、account quotaをロック付きで検査し`pending_upload`に予約する。
- Object upload成功後、completeでobject metadataと予約を照合し`ready`へ遷移。complete前にobjectがあれば同じAsset IDで再照合する。
- Upload失敗/中断時はpendingを即時消さず、期限付きcleanup候補として保持。自動queueは今回不要。次の同じ予約/明示cancelで状態照合して再開またはStorage object削除。
- Deleteは`delete_pending`にしてからStorage APIで削除し、Storage成功または当該予約keyが既に存在しないことをStorage APIで明確に確認できた場合だけDB rowを削除。APIがnot-foundを成功扱いする挙動を統合試験で確認する。確認不能時は失敗として状態を維持する。
- 一つでもAsset削除に失敗したProject DELETEはProject rowを削除せず非成功応答。既に消えたobjectは再試行で存在を確認してから進み、DB rowの保持により孤立keyを特定可能にする。
- DB row削除後にobjectが残った場合を防ぐため削除順をStorage firstにする。Storage success後DB delete失敗では`delete_pending`行を保持し、retryでmissing object確認→DB削除する。
- 不要な無制限retry、queue、service_role cleanup daemonは追加しない。`pending_upload`/`delete_pending`の列挙と手動/同一endpointによる再開方法を提供する。将来の期限切れcleanup workerは別承認。
- Project CRUD updateでassetRefsを外す場合、同一要求内で関連Assetを暗黙削除しない。明示Asset DELETE後にProject更新する。参照されているassetの削除は409、または削除後に参照なしで保存する明示順序とする。

## ローカル統合テストと受入条件案

実装時はStep 7b同様、新規専用local project/database/port/volumeを使い、稼働中local DBをresetしない。

- owner Aによるreservation/upload/complete/download/delete成功。owner B、anon、無効JWTはStorage APIおよびGo APIで拒否。
- AのProject/AssetをBがID/key改ざんしてGET/PUT/DELETE不可。Storage REST直接呼出しで他owner/path、別Project、bucket違い、未予約assetを拒否。
- `service_role`、anonの直接Storage object accessとDB assets accessが拒否されること。RLS bypass role/管理keyを通常実装へ渡さない。
- MIME偽装、拡張子偽装、zero byte、サイズ+1、Content-Length偽装、SHA-256不一致、base64/data URLの混入を拒否。
- duplicate reservation、二重complete、同時upload、同時delete、Project削除中upload、参照中Asset削除、revision競合と整合性を検査。
- Storage upload failure後のreservation、complete失敗後のobject、Storage remove failure、remove成功後のDB failureからの再試行で孤立しない。
- 20 Projects、種類ごとの個数、42 MiB/Project・account quotaの同時超過とraceをDB/API両方で拒否。
- DB dump/response roundtrip後のBlueprint/Timelineの版と内容維持。Cloud envelope→hydrateで既存`validateBlueprint`/`validateFeatureTimeline`を通し、Renderer asset mapに正しい背景画像が入る。
- `.arvproj` v1 import/export roundtripは現状維持。素材なしProjectは従来のProjectDocument v1 APIでcreate/get/update/deleteが成功。
- Storage private status、allowed MIME/max object size、RLS policies、service_role grantsをread-only invariant SQLで検証。
- Hosted environmentと本番bucketを一切使わない。

## 公式資料と根拠

- Supabase Storage Access Control：private bucketのRLSとoperation-specific policy、service keyはRLSを迂回する。[公式資料](https://supabase.com/docs/guides/storage/security/access-control)
- Supabase Storage Ownership：JWT `sub`からobject ownerが設定され、`owner_id`を使う。service key uploadではownerが設定されない。[公式資料](https://supabase.com/docs/guides/storage/security/ownership)
- Supabase Buckets Fundamentals：private bucket downloadはuser JWT/RLSまたはsigned URL。[公式資料](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- Supabase Standard Uploads：standardは小さなfile向き、6 MB超ではTUS resumable推奨。[公式資料](https://supabase.com/docs/guides/storage/uploads/standard-uploads)
- Supabase File Limits：Free global max 50 MBとして現行掲載、bucket-specific limit。[公式資料](https://supabase.com/docs/guides/storage/uploads/file-limits)
- Supabase Delete Objects：objectはSQLで消さずStorage APIで削除する。SQL deleteは実objectを消さず孤立させる。[公式資料](https://supabase.com/docs/guides/storage/management/delete-objects)

## 実装着手前に承認が必要な項目

1. クラウド専用Envelopeのversion/shapeとStep 7b CRUDでの後方互換・v1→cloud mapping。
2. ブラウザ直接Storage upload/download（user JWT + strict RLS）を採ること、TUS SDK/RESTを使うか、Go proxyを採るか。直接方式は性能/メモリに有利だが、Frontend実装・CORS・大容量中断処理の検証が必要。
3. `arvc-project-assets` bucket、owner/project/asset registryを照合するStorage RLS、およびassets DB表/権限を加える新規migrationの責務。
4. 提案上限（32 MiB audio、10 MiB image、1 per kind/project、42 MiB/project、840 MiB/account）とprovider-level aggregate quota/billing guard。
5. SHA-256を誰が検証するか。Browser hashだけなら整合性検出は悪意あるclientに対するserver proofではない。
6. delete semantics: asset参照中の削除拒否、Project DELETEの部分失敗応答、pending/tombstoneの保持期間と手動recovery。
7. Upload中断をTUSで再開するか、1回uploadと明示再試行に限定するか。

## 未確認事項

- 今回Storage APIのhealth/readiness、bucket/object、RLS、TUS対応は実環境へ操作・アクセスしていない。Supabase Storageの機能は公式資料で調査したが、現在のlocal CLI v2.122.0イメージでの細部は統合試験が必要。
- Hosted Supabaseのpolicy/migration/size limits/pricing/retentionは未確認。ローカル結果をそのまま本番へ適用できない。
- Supabase Storage APIが同一requestでmissing object removalをどう返すか、local版で未検証。
- 「monthly <= ¥1,000」はprovider-level usage/egress/backup/taxを含め保証できていない。

## 変更・検査

変更はこの設計報告とルート`CURRENT_TASK.md`のみ。Go/Frontend、既存Migration、DB、Storage bucket/object、Docker資源、依存関係は変更していない。Hosted Supabase接続、Gemini request、Git pushも行っていない。設計作業のためアプリ回帰テストは実行していない。
