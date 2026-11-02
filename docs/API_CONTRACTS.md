# API契約

状態：PROPOSED。全API共通のパス・OpenAPI・クラウド向け契約は未定義。Step 7b local Project CRUDとStep 7c local Asset APIのみ範囲を限定して決定済み。

DECIDED（Step 7i更新）：GoはSupabase JWTを検証し、プロジェクト・解析ジョブ・素材アクセスを所有者単位で認可する。AI生成providerはOpenAI Responses API / `gpt-6-luna`。応答は検証してから返却・描画へ渡す。実OpenAI応答は未検証。

PROPOSED：API群はプロジェクトCRUD、アップロード認可、解析ジョブ作成/状態取得、Blueprint生成、暗号化export/import。ジョブはqueued/running/succeeded/failed/cancelledを候補とし、遷移と再試行・二重実行の扱いを確定する。

実装前の確定事項：認証ヘッダー、リクエスト/レスポンス、所有者照合、ページング、エラー形式、冪等性、タイムアウト、サイズ・回数・同時実行制限、署名URL有効期限。契約はcontractsに置き、Go/Python/TypeScriptで整合性を検証する。

## Step 7b ローカルProject API（この範囲のみDECIDED）

本節はローカルSupabaseで検証したProject CRUDに限定する。Hosted環境、解析Job、素材API、Frontendクラウド保存は契約しない。認証は`Authorization: Bearer <Supabase user access token>`。Go APIはES256・固定loopback issuer・`authenticated` audience/role・有効期限・UUID subjectを検証し、検証済み`sub`だけをowner IDに使う。

| Method / path | 成功 | 主な拒否 |
|---|---:|---|
| `POST /api/v1/projects` | 201 | 400 JSON、401、413、422、409 上限 |
| `GET /api/v1/projects?limit=&cursor=` | 200 | 400、401 |
| `GET /api/v1/projects/{uuid}` | 200 | 400、401、404 |
| `PUT /api/v1/projects/{uuid}` | 200 | 400、401、404、409 stale revision、413、422 |
| `DELETE /api/v1/projects/{uuid}` | 204 | 400、401、404 |

Create bodyは`{ "title": string, "document": ProjectDocumentV1 }`。Updateは同じ形に正の`revision`を追加する。レスポンスは`id`, `title`, `revision`, `document`, `createdAt`, `updatedAt`を返しowner IDは返さない。一覧はcursor keyset paginationでlimit 1..20、既定20。ProjectDocument v1は既存Editor Blueprint v1とFeature Timeline v1のJSONを保持するwrapper（metadataの各schema version、renderer/analysis version、seedを含む）。不明version、未知field、不正参照・数値、画像背景・assetを含む文書は拒否する。documentは最大1 MiB、ユーザーごと最大20件。更新はDB RPCでrevisionを比較し、所有者と不存在を同じ404へ写像する。競合は409。削除はhard delete。エラーは`{"error":{"code":"...","message":"..."}}`。

Step 7k-2ではFeature Timeline v1の既存必須fieldを維持し、Snare Events/strength、Vocal/Other Envelope、Music Energyを任意加法fieldとして受け入れる。Demucs stem由来の追加系列は10ms hop、time origin 0ms、normalized 0..1。旧文書のTimelineはそのまま受け入れ、新featureの欠損時は対応Bindingを非活性にする。Goは新continuous pointsの順序/有限値/durationとSnare event-strength alignmentを検証する。

この決定はStep 7bのlocal API/DB実装範囲に限り、文書冒頭の将来API全体に対するPROPOSED状態を変更しない。実測・migration適用手順・制限事項は[Step 7b報告](reports/2026-11-01-step7b-auth-project-crud.md)を参照。

## Step 7c ローカルAsset API / Cloud Envelope v1

状態：**ローカル範囲でDECIDED・実装済み。Hosted運用は未検証**。全endpointはStep 7bと同じBearer user JWTを要求し、ownerは検証済み`sub`から決定する。bucket `arvc-project-assets`はprivate。object keyはサーバー発行UUIDから`{ownerId}/{projectId}/{assetId}`で構成する。音源最大32 MiB、画像最大10 MiB、Projectごとに`source_audio`/`background_image`各1件、userあたり40 assets/840 MiB。対応MIMEは音源MPEG/WAV/OGG/Opus/MP4/AAC/WebM/FLAC、画像PNG/JPEG。

| Method / path | 成功 | 主な拒否 |
|---|---:|---|
| `POST /api/v1/projects/{projectId}/assets` | 201 `pending_upload` reservation | 400/401/404/409/413/422 |
| `GET /api/v1/projects/{projectId}/assets` | 200 ready assets | 400/401/404 |
| `GET /api/v1/projects/{projectId}/assets/{assetId}` | 200 ready metadata | 401/404 |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/content` | 200 after bounded stream SHA-256/type/size check and Storage upload | 401/404/409/413/415/422/502 |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/complete` | 200 after stored bytes are re-read and verified | 401/404/409/422/502 |
| `GET /api/v1/projects/{projectId}/assets/{assetId}/content` | 200 binary stream | 401/404/409/502 |
| `DELETE /api/v1/projects/{projectId}/assets/{assetId}` | 204; referenced assets are rejected | 401/404/409/502 |

予約JSONは`{ "kind", "name", "contentType", "byteSize", "sha256" }`。binary uploadは予約時の`Content-Type`を使う。レスポンスはcamelCaseのAsset metadataで、`objectKey`は公開しない。APIエラー形式は`{ "error": { "code", "message" } }`。uploadはGo APIが受信byte streamを上限付きで読み、サイズ・MIME signature・SHA-256を確認してからStorageへ保存する。完了APIはStorageから実objectを再読込してSHA-256を照合した後にのみready確定を要求する。通常状態遷移は`pending_upload`→`ready`、削除はStorage remove前に`delete_pending`を記録し、失敗時は再試行可能なmetadataを保持する。Project DELETEはobjectsを先に削除し、失敗時はProject rowを残す。

Cloud Document Envelope v1は変更していないProjectDocument v1と`.arvproj` v1から独立する。`cloudDocumentVersion: 1`、version metadata、`editorState.blueprint`、任意の`editorState.backgroundAssetId`、既存`featureTimeline`、任意の`assetRefs.audioAssetId`を持つ。背景画像は保存時にcanonical solid placeholder `#000000`で表し、Frontend adapterは参照画像をdata URLへhydrateする。同一owner/projectのready状態かつ期待するkindのAssetだけ参照できる。Frontendクラウド保存UIはStep 7d対象。

ready確定は利用者JWTのPostgREST RPCではなく、Go APIから専用PostgreSQL roleで行う。Migration 012–015で作成した`arvc_asset_verifier`はNOBYPASSRLS・NOINHERIT・非superuser・membershipなし、projects/project_assetsへのtable ACLなしで、非公開schema `arvc_internal`の`project_asset_mark_ready(uuid,uuid)`だけEXECUTEできる。旧public RPCはPUBLIC/anon/authenticated/service_roleからEXECUTEを撤去した。Data API公開schemaに`arvc_internal`を含めない。`SUPABASE_ASSET_VERIFIER_DSN`はGoサーバーだけが使用し、通常CRUDやStorage APIでは使わない。接続DSNはlocal loopbackなら`sslmode=disable`または`verify-full`、remoteなら`sslmode=verify-full`を必須とする。

専用roleはDB表を直接参照・変更できないが、ready関数自体は`postgres` ownerの`SECURITY DEFINER`である。関数は`search_path=''`、完全修飾名、owner/Asset/pending状態/Project整合/object key/Storage object ownerを検証する固定処理に限定する。ローカルAuth/Data API/Storage統合でauthenticated/anon/service_role直呼出し拒否、private schema非公開、hash検証済み完了を確認した。Supabase公式資料ではpersistent backendのPostgreSQL direct connectionとcustom database role接続が案内されているが、Hosted環境のrole作成・pooler/ネットワーク・運用は未接続・未検証であり、本契約をHosted用の確定保証としない。詳細は[Step 7c-1報告](reports/2026-11-01-step7c-1-asset-ready-authorization.md)。

## Step 7d Frontend local cloud integration（local-only）

状態：**ローカル実装・mock検証済み。実ブラウザSupabase往復は未確認**。Frontendは既存Supabase Auth REST (`/auth/v1/token?grant_type=password`, refresh token, logout)を利用し、access/refresh tokenをtab-scoped `sessionStorage`に保存する。Vite configはloopback Supabase URL以外を拒否する。Frontendには公開anon/publishable keyのみを`VITE_SUPABASE_ANON_KEY`で渡し、service_role、Secret key、DB DSNは渡さない。Go APIへのProject/Asset要求にはuser bearer tokenを使用する。

ログイン後は最大20件のowner-scoped Project一覧を表示し、一覧から読込、Cloud save/update、hard deleteを行う。素材なしProjectDocument v1も読み込み時にCloud Envelope v1としてFrontend内で包み直し、次回saveでサーバーへEnvelope v1として更新できる。Project CRUDはStep 7b契約の`/api/v1/projects`を再利用。409 revision conflictは再読み込みを案内する。RendererのFeatureTimeline型にはschema metadataが含まれないため、Cloud adapterはAPIへ送るTimelineに必須`schemaVersion: 1`と`timeUnit: "ms"`を加える。素材はBrowserでSHA-256計算後、既存Asset reservationと`POST .../content`、complete、GET content、DELETE APIを用いる。BrowserはSupabase Storageへ直接接続せず、Go APIが既存のowner JWT/Storage RLSとSHA verifierを経由する。Cloud Envelope v1 adapterが背景画像・音源をAsset ID参照へ変換し、読み込み時はdownload byte size/SHA-256を照合してから既存Blueprint/Timeline validatorを通しEditor stateをcommitする。

保存時、新Projectは素材参照なしで作成後に素材をready化し、revision更新でEnvelopeを保存する。素材削除/置換は先に参照なしEnvelopeをrevision保存し、その後Asset DELETE、upload、最終Envelope更新を行う。途中失敗時に状態を成功表示せず、Projectを再読込できるrevisionに更新し、tab内のupload reservationは手動再試行で再利用する。予約前/途中のクラッシュからの自動回復、複数ページProject一覧UI、アカウント作成、Hosted利用は対象外。ローカルEditor/.arvproj/WebMは未認証でも利用可能。

## Step 7j authenticated local audio analysis

状態：local-onlyでDECIDED・実装済み。HostedでのCPU実行は対象外。`AUDIO_ANALYSIS_ENABLED=true`を明示した場合だけrouteを登録する。Go API自体はloopbackにbindし、local Supabase issuerの既存JWT validatorを適用する。既定値は無効。

| Method / path | Success | 主な拒否 |
|---|---:|---|
| `POST /api/v1/audio/analyze` | 200 `{featureTimeline, musicSummary, analysisMetadata}` | 401, 413, 415, 422, 429, 499, 502, 504, 500 |

Requestは`multipart/form-data`内の`audio` fileと、任意の`kickGateMode` text field（`off|soft|middle|hard`）を受け付ける。`kickGateMode`省略時は`hard`で、従来のKick採否条件と同じ。未定義値、重複field、その他のpartは拒否する。clientはBrowserで選択区間を44.1 kHz stereo PCM16 WAVへcropし、そのclipのみをBearer user JWT付きで送信する。Request全体16 MiB、実測clip 0より大きく60秒以下、PCM signed 16-bit little-endian、44.1 kHz、2 channelを要求する。全API processで同時処理は1件、timeoutは600秒。拒否エラーは`{ "error": { "code": "...", "message": "..." }}`で、外部向けにpath・process stderrを返さない。

Goは0700 private temporary directory、0600入力fileを使い、固定設定済みPython Island executableへshellなしの固定argv（input path、`--output-dir`、`--threads 4`、`--kick-gate-mode`と検証済み値）で子プロセスを起動する。Python output JSON file各々へbyte上限（Feature Timeline JSONは8 MiB）を適用し、Summary/Timelineを既存Go validatorで検証したうえでmetadata version、htdemucs/CPU、44.1kHz/stereo、実fileBytes、clip duration一致を検証する。この内部結果上限は有効な60秒Timelineの実測出力に合わせたもので、外部multipart request上限16 MiBとは別である。process groupをtimeout/cancelで終了し、全経路でtemp directoryを削除する。ResultのTimeline時刻原点は選択clip先頭=0ms。分析APIはAI生成を行わない。Frontendはその後、既存`POST /api/v1/blueprints/generate`へclip由来Summary/Timelineを送るため、AI entitlement・quota・Idempotencyは既存契約どおり適用される。

`/app`の既存音源形式/32 MiB source limitを維持し、確定前はsource fileを送信せず、解析成功時だけcrop clipをEditor audio stateへcommitする。Project/Cloud ProjectとWebMは同じclipとTimelineを使う。source offsetは永続化しない。`/demo`は固定full-length asset/Timelineのままで、分析routeを呼ばない。

FACT（Step 7k-12）：`/app` Previewのhidden AudioElementはEditorへcommitされたcrop WAVを再生し、その`currentTime`をFeature Timeline/Rendererの時刻として読む。Play/Pause/Stop/Seekは同じclip-relative 0..duration時間軸を使う。元source MP3はrange selection UIのpreviewだけに使い、非0秒の選択開始offsetはcrop時に除去されTimelineへ持ち込まない。`/local`の合成時計と`/demo`の固定音源時計は維持する。

## Step 7g Blueprint generation and AI budget (local-only)

### Step 7i provider更新

実AI modeはGeminiではなくOpenAI Responses APIを使用し、model allowlistは`gpt-6-luna`。Fixtureは既定で外部APIを呼び出さない。`POST /api/v1/blueprints/generate`の認証、entitlement、Idempotency-Key、原子的budget予約/精算、quota、kill switch、エラーJSON形式は維持。Responses Structured Outputsを使用し、Go側の既存Blueprint v1 validatorを最終判定とする。usage診断項目のJSON名は互換維持されるが、意味はOpenAI input/output/reasoning token数。Migration 018は2026-11-01にlocal Supabaseへ適用済み。Hosted環境には適用していない。詳細は[Step 7i-1報告](reports/2026-11-01-step7i-1-openai-budget-migration.md)。

`POST /api/v1/blueprints/generate` は `AI_GENERATION_ENABLED=true` のときだけ既存Supabase JWT validatorを必須とする。設定が無効/欠落、またはbudget storeが使えない場合は503でfail-closed。JWTなし/不正は401、JWTは有効だがDB entitlementがない/期限切れなら403。user/service request quotaまたはconcurrency超過は429、全体停止/estimated budget超過/DB障害は503、同じuserのIdempotency-Key再利用は409。生成前に入力JSON・Feature Timelineを検証し、キー（16–128安全文字）のSHA-256だけを保存し、同一キーでの再生成・結果cacheはしない。Bearer tokenはJWTの`sub`をserver側owner IDとし、リクエストbodyのuser IDやJWT user_metadataを資格根拠にしない。

Migration 016 historically initialized the local control row with the Gemini allowlist. Migration 018 has been applied to the local DB and switches that row to `gpt-6-luna` and its Standard price snapshot while preserving user 2/day + 10/month, service 5/day + 20/month, input 8,000 tokens, output 4,000 tokens, global concurrency 2, per-user 1, estimated service budget $1.50/month. These are configurable local initial limits, not a public cost guarantee. Migration 016 tables have no application-role table grants; dedicated `arvc_ai_budget` may execute only private `arvc_internal.ai_generation_reserve` and `ai_generation_settle` SECURITY DEFINER RPCs. PostgreSQL serializes admissions on the singleton budget control row; app reservation requires the database before any provider call. Known usage settles actual counts; ambiguous usage is retained as `usage_unknown` with its maximum reservation. Provider retry remains disabled. `AI_GENERATION_ENABLED=false` is the process-level kill switch; the database singleton `enabled` is the durable operator switch. Both must allow generation. Hostedには未適用。

Fixture modeでもJWT、active entitlement、予約、Idempotency-Keyを必須とし、固定Blueprintだけを返して外部AI providerへ接続しない。Migration 017では、設定された開発者UUID 1件に限るprivateなlocal Fixture予約を追加した。entitlement、kill switch、入力/Schema検証、重複防止は維持し、当該usage行だけを通常の回数・費用・同時実行の集計から除外する。Go APIがこの経路を使うのは、明示local flag、`fixture` mode、検証済みJWT `sub`と設定UUIDの一致、API/Authのloopback制約が揃う場合だけ。OpenAI modeでは特例設定を拒否し、他ユーザーは通常のquota RPCを使う。`/demo`はGo/Auth/Cloud/Asset/AI endpointを呼ばない、別の同一origin固定合成WAV previewである。local `/local`/`/app`のEditor機能は従来どおり。Migration 001〜016、Project/AssetのRLS/API契約は変更していない。このlocal契約はHosted issuer/JWKS、専用roleの本番設定、公開時の料金/費用挙動を保証しない。
# Step 7k-3 Blueprint v1 additions

Blueprint v1 accepts optional `globalGradient` and Effect `colorMode` fields without changing Blueprint, Project, or Cloud envelope versions. The Go validator rejects unknown/null/malformed gradient fields, non-`#RRGGBB` colors, out-of-range angles, and unknown color modes. Existing v1 documents with omitted fields remain valid and retain legacy Effect colors. OpenAI Structured Output exposes these optional nullable fields and normalizes omitted values to the default palette/global mode before standard validation.

FACT（Step 7k-5 Timeline input extension）：Optional `featureTimeline.waveformPeaks` accepts exactly 20ms/882-sample signed-full-scale metadata and five source arrays. Each array has ceil(durationMs/20) finite `{min,max}` samples within [-1,1], maximum 12,000. Existing 2MiB request limit is unchanged; peak arrays are not forwarded to OpenAI generation. Legacy Timeline v1 without peaks remains accepted.

FACT（Step 7k-8）：Optional Timeline v1 fields `bpm` and `bpmSource` must be supplied together. Allowed source values: `kick-estimated` (60..180) and `fallback` (exactly 120). Missing values in legacy timelines resolve to 120 BPM fallback in renderer and API compact prompt features. Blueprint v1 circular Effects may optionally define BPM rotation settings; if any are present all four are required and validated. No API request size, Project version, or Cloud Envelope version changes.

FACT（Step 7k-11a）：Blueprint generation accepts optional `featureTimeline.frequencySpectrum` in Timeline v1: 20ms hop, FFT size 4096, 32 bands, sampleRateHz and Nyquist-bounded range, whole-clip p99 log-RMS normalization, `uint8-linear-0-255` row-major values. Value count is `ceil(durationMs/20)*32`, maximum 384,000 entries (4-minute Timeline). Go validates metadata, exact fields, dimensions, integer range, and 2MiB request limit. Spectrum values are not placed in the OpenAI prompt; only existing compact summary features are sent. Old Timeline without this field remains accepted.
