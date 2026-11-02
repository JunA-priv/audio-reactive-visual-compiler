# Step 7g：認証・デモ・AI利用制限の実装報告

実施日：2026年11月1日  
状態：**completed（local implementation and verification）**

## 要約

Step 7fで定義した3段階権限モデルを、公開用Hosted環境ではなく既存local Supabaseに実装した。匿名利用者には合成音源・固定Feature Timeline・既存Blueprintを使う`/demo`、認証利用者には`/app`のEditor/Cloud機能、AI資格を持つ利用者にはDB利用枠内のBlueprint生成を提供する。

`POST /api/v1/blueprints/generate`は認証、DB entitlement、予算予約、同時実行制御、Idempotency-Key検査の後でのみ生成処理へ進む。Fixtureモードで実Auth JWT・DBとAPIを統合し、Gemini外部APIリクエストは0回。PostgreSQLを使った2つの独立connection poolからの並列予約も確認した。

statusは実装対象のlocal範囲ではcompleted。Hosted JWT/JWKS、専用role/DB接続方式、実provider課金・価格変更・spend-stopは未検証なので、Step 8公開可を意味しない。

## 参照・判断

PROJECT_CONTEXT、DEVELOPMENT_RULES、CURRENT_STATE、Step 7f設計、Step 7e監査、CURRENT_TASK、SECURITY、API_CONTRACTS、関連React/Goコード、Migration 001–015とテストを指定順に確認した。

Migration 001–015、Project/Asset API/RLS、ProjectDocument/Cloud Envelope、`.arvproj v1`、Renderer/WebM、Python Islandは変更していない。新しい依存関係は追加していない。Go APIはlocal loopback issuer限定の既存JWT validatorを再利用した。

## 実装

### Frontendと3段階アクセス

- `/`：demoとloginへの入口。
- `/demo`：`frontend/public/demo/sample.wav`の固定12秒合成WAV、既存`demoTimeline`、`initialEditorBlueprint`を共有Editor/Rendererで再生する。音源要素の`currentTime`を視覚評価時刻に使い、play/pause/seek/endを合わせる。
- `/login`：既存Supabase Auth REST/sessionを再利用。
- `/app`：session復元・期限検証後にEditorを表示し、未認証時はloginを出す。
- 開発用`/local`と既存default local Editorを維持。

`/demo`ではCloud account、Project/Asset、Gemini/Fixture API、音源・画像upload、`.arvproj`、WebMの操作を表示しない。Frontend unit testのfetch spyはmount/再生時にnetwork call 0を確認した。加えてWindows headless Chromeで合成音源再生を実行し、Audio currentTime 0.85s、Renderer表示0.82s（差0.03s）、Cloud/generation/WebM UIなし、resource中の外部/API/Auth request 0を確認した。これはローカルheadless Chromeの短時間確認で、他Browser/OSや長時間同期の保証ではない。

`/app`のBlueprint生成操作は有効sessionのBearer tokenとランダムな`Idempotency-Key`を付ける。401/403/409/429/503を利用者向けに分けて表示し、API側CORS allowlistにもIdempotency-Keyを追加した。Frontend表示制御は認可境界にせず、Goで再検証する。

### Go/Echo生成API

`AI_GENERATION_ENABLED=true`でのみ既存Supabase JWT validatorとAI budget storeを初期化する。Fixture/Geminiのいずれでもmiddlewareがない状態は503でfail-closedする。Gemini modeはmodel allowlist、API key、AI flag、issuer、budget DB接続が揃わなければ起動しない。`AI_GENERATION_ENABLED`未設定時は生成routeを使用不可にする。APIは引き続きloopback bindに限定。

要求は既存JSON/Blueprint/Feature Timeline validator、2 MiB body上限を通り、Idempotency-Keyは16–128文字のsafe characterに制限される。Gemini modeではbudget予約後にSDK CountTokensで入力token数を計測し8,000以下を確認し、最大4,000 output tokensで生成する。API key、Authorization、prompt、summary、Gemini response bodyは安全ログに記録しない。SDK HTTP retryは無効を維持した。

予算予約なしにGeminiへは進まない。CountTokens/GenerateContentまたはsettlement時にusage不明となったrequestは`usage_unknown`を記録し、予約最大費用を保持する。既知の成功は実usageで費用を精算する。Gemini request cancellationがprovider側停止を保証するとは扱わない。

### Migration 016・権限

新規`20261101001600_step7g_ai_entitlements_budget.sql`は以下を作成する。

- `ai_entitlements`：Auth user単位の資格。default deny、利用者の直接読書き不可。
- `ai_budget_control`：単一のglobal enable/kill switch、model/pricing version、quota/token/concurrency/budget設定。
- `ai_generation_usage`：request/user/model/pricing version、idempotency SHA-256、予約/実usage、状態だけを保持。prompt/audio/feature payloadを保存しない。
- `arvc_ai_budget`：別server role。NOBYPASSRLS/NOSUPERUSER/NOINHERIT、membershipなし。表への直接ACLなし。
- 非公開`arvc_internal.ai_generation_reserve`/`ai_generation_settle`：限定`SECURITY DEFINER` RPC。owner=postgres、空search_path、公開schema外。PUBLIC/anon/authenticated/service_role/asset verifierからEXECUTE不可。

reserve RPCはcontrol rowを`FOR UPDATE`して直列化し、entitlement、期限、重複key、user/service日次・月次回数、global/user concurrency、推定費用を同じtransactionで確認・予約する。DB不通はAPI 503。default initial valuesはuser 2/day・10/month、service 5/day・20/month、input 8,000、output 4,000、global concurrency 2、user concurrency 1、estimated monthly budget $1.50。これはローカル検証値で公開時の課金保証ではない。時刻境界はUTC。DB制約でもinput/output/budget上限を初期ポリシー範囲内へ固定。

`arvc_ai_budget`はMigration適用後、接続のためLOGIN passwordを生成し、loopback DSNをGit除外・mode 600の`api/.env`へ保存した。既存`arvc_asset_verifier`にはAI権限を付けていない。Migration適用後にPostgres作成主体から新roleへのadmin membershipが残ることが実測で分かり、Migration 016へ`REVOKE arvc_ai_budget FROM postgres`を加え、ローカルにも同じ単一REVOKEを適用した。最終verification SQLはrole membershipなしを確認。

Migration 016は対象を確認した既存local Supabase DBへ適用済み。migration listのlocal ledgerで001–016が一致。supabase migration upは対象DBへ接続不能の試行があったが、DDLは適用せず終了し、承認済みloopback接続で再実行した際に016のみを適用した。DB reset、既存volume削除、Hosted接続はない。適用前に作成したschema-only backupは`/tmp/arvc-step7g-pre-migration-schema.sql`（mode 600）にあり、Project/Asset/既存ユーザーデータは変更していない。

## API契約・応答

`POST /api/v1/blueprints/generate`のrequest/Blueprint JSONは既存契約を維持し、認証とidempotency headerを追加。主要な応答：

| 条件 | Status | 処理 |
|---|---:|---|
| JWT不在/不正 | 401 | entitlement、DB予約、provider処理なし |
| JWT有効・AI未許可/資格期限切れ | 403 | provider処理なし |
| 同userで使用済みIdempotency-Key | 409 | 再生成せず、結果cacheなし |
| user/service回数・concurrency超過 | 429 | provider処理なし |
| global stop、予算超過、budget DB障害 | 503 | fail-closed |
| entitlement・予約成功 | 200 | 検証済みBlueprintのみ返す |

日次/月次上限とbudgetはPostgreSQLの共有stateで複数API instance間に適用する。Idempotency-Keyはuserごとにhashのみを一意保持し、同一keyを再使用できない。usage ledgerの保持・削除期間は未定義であり、運用前にretention policyが必要。

## 検証結果

### Local Supabase統合

- Migration ledger: 001–016 all matched.
- Step 7b privilege invariants: 9/9 passed.
- Step 7c-1 verifier invariants: 15/15 passed。Asset verifierのpasswordだけを以前明示許可された再発行操作で回転し、ignored mode600 `.env`内のDSNを更新した。GRANT/RLS/role属性は変更していない。
- Step 7g AI budget invariants: 8/8 passed（restricted role、membershipなし、RPC限定EXECUTE、app rolesからRPC不可、RLS FORCE、直接table ACLなし、default policy、function hardening）。
- loopback API in Fixture mode + real local Auth JWT: unauthenticated 401、DB kill switch off 503、authenticated non-entitled 403、operator-granted fixture 200 + Blueprint validation、same idempotency key 409、second unique request 200、daily quota 429。
- Six distinct local entitled users against the shared service/day counter: first five Fixture requests returned 200, sixth returned 429. Test identities and usage rows were deleted.
- Temporarily lowered the local estimated service budget below one maximum reservation: eligible request returned 503 before generation; restored the original $1.50 value and deleted the temporary user/rows.
- Two separate Go/PostgreSQL pools concurrently reserve: same-user concurrency limit admitted exactly 1; global concurrency admitted exactly 2 of 3 different entitled users. All temporary test users, entitlement/usage rows were cleaned up.
- API health remained local. No Gemini provider call, key loading for Gemini, model call, or paid service activity occurred.
- Existing Projects/Assets local integration: `go test -count=1 ./internal/projects ./internal/assets` passed.

### 自動テスト・静的検査

- Go: `go test -count=1 ./...` passed; `go vet ./...` passed; gofmt applied.
- Frontend: 9 test files / 48 tests passed; typecheck, lint, build passed.
- Added route and fixed demo privacy/audio clock tests; added CORS preflight assertion for Idempotency-Key; extended Go provider-call-denial cases for entitlement, request quota, concurrency, global stop, budget, and DB unavailable.
- `git diff --check`: passed after documentation updates.

## 事故・資格情報対応

作業中、誤って`api/.env`を検索対象としたコマンドが、既存`SUPABASE_ASSET_VERIFIER_DSN`をtool outputへ出力した。値、パスワード、DSNは本報告に含めない。検知後、以前に明示許可されたlocal-only操作の範囲で`arvc_asset_verifier`のランダムpasswordを再生成し、ignored mode 600 `api/.env`だけを更新した。15件のAsset verifier権限不変条件を再実行し全件pass。Git追加・報告記録・Hostedへの使用はない。会話/tool transcriptに既出のコピーは削除済みと見なさず、旧値を他環境で再使用しないこと。ローカル統合APIは新DSNでProjects有効起動に成功した。

## 変更ファイル

- `CURRENT_TASK.md` — Step 7gの作業契約・結果。
- `frontend/src/App.tsx`, `frontend/src/main.tsx`, `frontend/src/VisualEditor.tsx`, `frontend/src/style.css` — route分岐、demo同期、認証済みEditor/生成UI。
- `frontend/src/App.test.tsx`, `frontend/src/visual-editor.test.tsx`, `frontend/public/demo/sample.wav` — route/demo testと合成音源。
- `api/cmd/server/main.go`, `api/internal/service/http.go`, `api/internal/service/gemini.go`, `api/internal/service/http_test.go`, `api/internal/authn/jwt.go`, `api/internal/aibudget/` — JWT-gated generation, token/output limits, budget store, safe failure handling and tests.
- `api/run-local.sh`, `api/.env.example` — safe plain dotenv parsing, process override, opt-in AI flag and dedicated budget DSN name.
- `supabase/migrations/20261101001600_step7g_ai_entitlements_budget.sql`, `supabase/verification/step7g-ai-budget-privilege-invariants.sql` — DB controls, restricted role/RPC, verification query.
- `docs/API_CONTRACTS.md`, `docs/SECURITY.md`, `docs/ENVIRONMENT_SETUP.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md` — local contract and state.

## 未解決・公開前リスク

1. Hosted Supabaseへの接続/DDL/role provisioningを一切試していない。既存JWT validatorはloopback HTTP issuer/JWKS限定であり、そのままHosted公開できない。
2. model/pricing versionは運用者が同期する設定で、自動価格変更検知はない。価格/為替/税/provider overage、AI Studio/provider spend capの強制性を保証しない。月額¥1,000以下の保証はできない。
3. signup/open registration、複数アカウント、CAPTCHA/invite/email verificationのHosted実効設定は未監査・未設定。資格grantがないユーザーはAI利用不可だが、公開Auth abuse自体は別対策が必要。
4. per-request countTokensは外部Gemini APIへpromptを送る。実APIのfree/paid扱い、latency/availabilityは未検証。実通信許可なしに呼んでいない。
5. quota usage ledgerはusage_unknown費用予約を残し、stale reservation/concurrency leaseをoperator確認・復旧する管理手段や自動retentionを追加していない。月次経過後に過去unknown rowsをどう解決するか運用runbookが必要。
6. `ai_generation_usage.user_id` currently uses `ON DELETE RESTRICT` to retain cost/idempotency history. Auth user deletion therefore requires a retention/anonymization decision and bounded cleanup procedure before hosted operation.
7. demo audio-clock synchronization passed in local Windows headless Chrome for a short sample interval; other Browser/OS, autoplay policy variation, and long-duration drift remain unverified.
8. local `arvc_asset_verifier` credential was exposed in this work session's tool output, then rotated. Treat the old value as compromised and do not reuse. The new local secret remains only in ignored mode 600 `api/.env`.
9. Step 5.6 Gemini実通信は過去報告どおりpartial/failed upstreamのまま。本作業では再試行していない。
