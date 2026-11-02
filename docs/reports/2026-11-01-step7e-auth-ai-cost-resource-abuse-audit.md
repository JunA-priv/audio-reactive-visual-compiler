# Step 7e：認証・AI従量課金・リソース悪用リスク監査

実施日：2026年11月1日  
状態：**completed（read-only監査）**

## 要約

監査対象コード・設定・既存テストを確認した。アプリケーションコード、DB、Migration、RLS、Docker、課金設定は変更しておらず、Geminiを含む外部APIへの実リクエストも行っていない。

**公開前の重大な阻害事項：** `POST /api/v1/blueprints/generate`にはJWT middlewareが適用されていない。Gemini modeとサーバー側API keyが有効で、このAPIを外部から到達可能にすると、未ログイン利用者を含む任意のcallerがprovider callを発生させられる。Project/Asset APIの認証はこの経路を保護しない。現状のserverはloopback bindを強制するため、通常の外部接続はできないが、loopback制限を外すだけでは安全に公開できない。

さらに、生成APIにアプリ側の利用者別・サービス全体の回数/予算制限、同時実行上限は見つからなかった。入力・最大出力には上限があるが、最大値の濫用を防ぐ認証・rate controlとは別の制御である。**Cloud公開前に生成APIの認証・利用資格判定、共有状態を使うrate/token/concurrency budget、全体停止スイッチを設計・実装し、公開経路で検証する必要がある。**

## 監査方法と根拠

参照順に`PROJECT_CONTEXT.md`、`DEVELOPMENT_RULES.md`、`CURRENT_STATE.md`、Step 5〜7d報告、`CURRENT_TASK.md`、`SECURITY.md`、`API_CONTRACTS.md`を確認し、Echo route registration、handler/middleware、Gemini client、JWT validator、Project/Asset handler、Migration、Frontend auth/API adapter、Python CLI/pipeline、関連テストを追跡した。`.env`は値を読まず、ファイルmode `0600`とGit ignoreのみ確認した。

主なコード根拠：

- `api/internal/service/http.go`：`/healthz`、Blueprint generation route、body/input validation、Gemini context deadline、エラー処理、local-only CORS。
- `api/cmd/server/main.go`：Gemini mode/key/model、Projects有効化、loopback bind強制、server起動。
- `api/internal/service/gemini.go`、`input.go`：公式SDK呼出し、retry/continuation、出力token、prompt構成、入力上限。
- `api/internal/authn/jwt.go`：Project/Asset用JWT verifier。
- `api/internal/projects/handler.go`、`api/internal/assets/service.go`：認証route、Project/Asset上限・操作。
- `supabase/config.toml`、`supabase/migrations/20261101000100_step7b_projects.sql`、`20261101000900_step7c_project_assets.sql`、`20261101001200_step7c_verified_asset_transition_role.sql`等：signup設定、RLS、Project/Asset制限、ready権限。
- `frontend/src/auth-client.ts`、`cloud-api.ts`、`VisualEditor.tsx`：Frontend session/UIと生成API呼出し。
- `python-island/src/python_island/{cli,audio,pipeline}.py`：ローカル音源入力制限とCPU処理。
- 既存テスト：`api/internal/service/http_test.go`、`gemini_sdk_test.go`、`api/internal/authn/jwt_test.go`、Project/Asset local integration tests。

既存テストの照合：`TestFixtureEndpointReturnsValidatedBlueprint`はBearer tokenなしでgenerateへPOSTし200を期待する。Gemini mock testsは429/5xx/timeout分類、秘密情報sanitize、retry無効、120秒deadline、continuation無効を検証する。JWT testsはES256固定、issuer/audience/role/exp/sub、署名不一致を検証する。Project/Asset local integrationはowner分離・anon拒否・RLS/ready権限を検証する。generate routeのunauthenticated 200は設計どおりのfixture/local API挙動をテストが固定しており、公開時も安全という意味ではない。今回テストは実行していない。

既存テストは読み取りのみであり、今回再実行していない。現在のHosted環境、AI StudioのProject tier/API key restrictions、実効quota、Cloud Storage/DB契約・料金は照会していない。

## 全Go/Echo endpoint・認証・課金・資源使用マトリクス

| Method / path | 現行認証 | 実行・保存先 | コードで確認した制限 | 監査結果 |
|---|---|---|---|---|
| `GET /healthz` | 不要 | Go process health | responseは固定statusのみ | 公開時も情報量は小さい。可用性監視用の保護/分離は未定義。 |
| `POST /api/v1/blueprints/generate` | **不要** | Fixture、またはGemini `GenerateContent` | JSON 2 MiB、duration 1..24h、bass 50,000、kick 20,000、visualIntent 500 chars、promptではfeatureを各最大64 sampleへcompact、output 7,000 tokens、provider context 120秒、SDK HTTP retryなし、Automatic Continuation無効 | Gemini modeでは直接従量課金経路。user/service rate、token budget、concurrency制限なし。公開時High blocker。 |
| `POST /api/v1/projects` | Bearer JWT必須 | Supabase Data API / Project DB | user 20件、document 1 MiB、schema/asset参照検証、DB制約/RLS | Owner subは検証済みJWT由来。rate limit・global capはなし。 |
| `GET /api/v1/projects` | Bearer JWT必須 | Project DB | page limit 1..20、cursor長512以内 | owner-scoped。連続pollingへのrate limitなし。 |
| `GET /api/v1/projects/{id}` | Bearer JWT必須 | Project DB | UUID形式、RLS/owner照合 | 他owner/不存在は404。rate limitなし。 |
| `PUT /api/v1/projects/{id}` | Bearer JWT必須 | Project DB | 1 MiB、revision競合409、document validator、owner/RLS | 個別Project/user制限はあるが連続更新rate limitなし。 |
| `DELETE /api/v1/projects/{id}` | Bearer JWT必須 | Storage cleanup + Project DB | owner/RLS、hard delete、asset cleanup失敗時はProject維持 | 認可済み。ただしdelete再試行を制御するrate limitなし。 |
| `POST /api/v1/projects/{projectId}/assets` | Bearer JWT必須 | Asset metadata DB | 64 KiB JSON、MIME/name/hash/size検査、project owner、kindごと1件、user 40 assets/840 MiB | 個人枠あり。全user合計の上限・rate limitなし。 |
| `GET /api/v1/projects/{projectId}/assets` | Bearer JWT必須 | Asset metadata DB | owner/project scope | polling rate limitなし。 |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/content` | Bearer JWT必須 | Go stream → private Supabase Storage | 音源32 MiB、画像10 MiB、allowlist MIME、実byte hash/type/size検証、DB quota、Go HTTP client timeout 2 min | per-user quotasあり。総保存量/費用、同時upload、request rateの上限なし。 |
| `POST /api/v1/projects/{projectId}/assets/{assetId}/complete` | Bearer JWT必須 | Storage object再読込、専用verifierでready化 | stored bytes SHA-256、pending状態、owner等を再検証 | 認可境界はlocal integrationで検証済み。短時間の同時呼出しは状態遷移で保護。rate limitなし。 |
| `GET /api/v1/projects/{projectId}/assets/{assetId}` | Bearer JWT必須 | Asset metadata DB | owner/project scope、ready metadata | rate limitなし。 |
| `GET /api/v1/projects/{projectId}/assets/{assetId}/content` | Bearer JWT必須 | private StorageからGo経由stream | owner/project scope、ready、Go client 2 min | 大量download帯域/同時実行のアプリ上限なし。 |
| `DELETE /api/v1/projects/{projectId}/assets/{assetId}` | Bearer JWT必須 | Storage + Asset DB | 参照中拒否409、delete_pending状態を経由 | userの上限はある。大量delete/retryのrate limitなし。 |
| `OPTIONS`（各path） | 不要 | CORS preflight handler | `http://127.0.0.1:5173` / `http://localhost:5173`のoriginだけCORS responseを付与 | Preflight 204は認証前に返るがdata operationではない。CORSは非browser callerに対する認証ではない。 |

`PROJECTS_ENABLED`がfalseならProject/Asset routes自体を登録しない。trueなら起動時にJWT verifier、Data API、asset verifier DSNが必須で、不足時にfail-fastする。この設定はProject/Asset経路の保護であり、Blueprint generation routeには影響しない。Gemini modeでkeyが空なら生成APIは503となるが、keyが設定されれば認証なしで生成を実行する。`API_ADDR`はloopback以外を拒否するため現実装はlocal-onlyである。公開サービスは現行構成で起動できず、これを外す変更は認証対策と同時に扱うべきである。

## 認証・signup・認可の確認

**確認済み：** Project/Asset handlersは`authn.Validator.Middleware`をGroupに適用する。Validatorは許可algをES256固定、loopback Auth issuer固定、audience/role=`authenticated`、expiry必須、UUID `sub`を検証する。所有者IDは検証済み`sub`を使う。既存unit/local integrationは偽造署名、期限切れ、role/audience/issuer不一致、他owner、anon、直接Data API/RLS制約を確認している。Step 7b/7c-1の権限不変条件とStep 7d-2 E2Eは過去の記録上合格。Hosted issuer/JWKSと専用role接続は未検証。

**重大な差：** `service.NewServer`はBlueprint generationをmiddlewareなしで直接登録する。`http_test.go`の`TestFixtureEndpointReturnsValidatedBlueprint`もAuthorizationなしのfixture POSTで200を期待する。Frontend login画面はProject UIの認証UXであり、`VisualEditor.tsx`のBlueprint generate fetchはログインsession/JWTを付けない。ブラウザCORSはcurl等のcallerや悪意あるserver-side callerを防がず、API認証の代わりにならない。

**仕様との不一致：** `docs/SECURITY.md`と`docs/API_CONTRACTS.md`の一般的なDECIDED記述はGo APIがSupabase JWTを検証し、解析等を所有者単位で認可する方向を示すが、現在のBlueprint generation routeにはその認証・所有者scopeが実装されていない。API_CONTRACTSのStep 5節も正式な認証/公開契約を未定義としている。実装を正とすると、generate routeの安全性は未決定のまま未認証である。公開時に文書とコードの両方を同一契約へ更新すべき。

**signup：** `supabase/config.toml`のAuth email設定で`enable_signup = true`。Frontendはsign-in/logout UIのみだが、signup endpointはSupabase Authの公開APIであり、Hostedに同設定を適用すれば公開anon keyだけでsignup可能となる可能性がある。招待制、メール確認のHosted実効状態、CAPTCHA、IP/user signup rate limitは今回確認できず、アカウント作成制限として合格扱いしない。さらに、API AI routeは未認証なので現状の生成悪用にsignup自体は不要。

## AI API・利用量・費用

### アプリケーション側

- 外部AI呼出し箇所はGo `GeminiGenerator.Generate` → `client.Models.GenerateContent`の1経路。検索Grounding、画像/音声送信、他の有料AI APIはコード上見つからなかった。音源分離はローカルPython CLIで、GeminiにはSummary/compact Feature値とBlueprint仕様のみ送る。
- `BLUEPRINT_MODE`の既定はfixture。`gemini`時はserver環境の`GEMINI_API_KEY`優先、なければ`GOOGLE_API_KEY`。modelは`GEMINI_MODEL`で任意overrideされ、defaultは`gemini-3.8-flash`。モデルallowlist・固定による単価保護なし。
- SDK `google.golang.org/genai` v1.77.0のHTTP retryはnil、Automatic Continuation false。Context deadline 120秒。handlerはincoming request contextを親にするためclient disconnect/cancelはSDK contextへ伝播する構造。ただしproviderがcancel後に生成処理・課金を停止することはコードだけでは保証できない。
- JSON body上限2 MiB、Timeline 50,000 bass point/20,000 kick、Summary/Timeline各v1、duration最大24時間。PromptはTimeline全体を渡さず最大64 bass sample/64 kick sampleへcompactする。しかし`model`, `device`, `format`, `codec`, `kickDetection`など任意文字列の個別長上限はなく、`stemRms` mapにも総key数上限がない。外側request sizeが最後の上限。
- max output 7,000 tokens。1 requestあたり上限はあるが、token count preflight、per-user/per-project quota、service-wide monthly token budget、request rate cap、semaphore/worker limit、global disable thresholdは確認できなかった。server creationは明示的HTTP Read/Write/Idle timeoutを設定していない。
- 429、5xx、timeout分類とsanitized error、latency/model-only logは既存mock testsで確認される。無制限retryはない。失敗したHTTP 400/500はGoogle公式Billing FAQ上tokens課金されない一方quota計上される。client timeout/disconnect時にprovider側でどこまで処理・課金されたかは本監査では未確認で、同一操作のmanual resubmitは二重利用となる可能性がある。

### Google公式情報（確認日：2026-11-01）

- Google公式価格表は`gemini-3.8-flash` StandardのFree Tier token価格をfree、Paid Tierを**2026-12-31まで入力$0.75/100万 tokens、出力（thinkingを含む）$3.75/100万 tokens**、**2027-01-01から$1.50/$7.50**と掲載する。料金は変わり得る。個別Projectのtier/利用枠は参照していない。[公式料金表](https://ai.google.dev/gemini-api/docs/pricing)
- 公式rate limitsはRPM、input TPM、RPDを挙げ、値はmodel/project/tierで異なりAI Studioで確認、保証値ではないと説明する。上限は**API keyごとではなくProject単位**。Spend-based controlが適用される場合はrolling 10分あたりFree=N/A、Tier 1=$10、Tier 2=$50、Tier 3=$200。ただし対象適用はbilling history/tier次第。[公式Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- 公式Billingは月間spend capをbilling-account tierとProject双方に記載する。Project cap機能はexperimentalで、約10分の遅延overageがあり得る。長時間Batch/Agentは超過し得る。Billing account tier capはFree=N/A、Tier 1=$250、Tier 2=$2,000、Tier 3=$20,000–$100,000で、account全Projectの利用を集約し到達後停止する。このため月1,000円目標に合致する強い停止保証としてTier capやアラートを扱えない。Prepayは残高0でAPI停止するが約10分のpipeline latencyに伴うoverage可能性がある。利用量はAI Studio Dashboard > Usage、active quotaはAI Studioで確認する。[公式Billing / Spend caps](https://ai.google.dev/gemini-api/docs/billing)
- 公式API key資料はkeyをpassword扱いとし、漏洩時に第三者がquotaを消費し請求を増やし得ると説明。server-side保管、Gemini API restriction、billing alertsを推奨する。[公式API key安全策](https://ai.google.dev/gemini-api/docs/api-key)
- 過去Step 5.5報告はFree Tierの改善利用・人手review可能性を記録している。本監査ではdata policyを再確認していない。実データを送る前に現行Termsを再確認する。

**運用費目標：** アプリ側でuser/service token/request budgetを拒否する仕組みはない。Provider quota/rate limitはper-project safety limitであり、ユーザー配賦・1,000円上限を意味しない。公式Project monthly capはexperimental/遅延overageと明記される。Billing alertは通知であり停止機構ではない。1,000円以内を要件とするなら、application hard stop + provider-level低い上限/Prepay/不要時のbilling無効など複数境界を設計し、10分遅延の残余overageと為替/税等を含む許容額を決める必要がある。現在の実効tier、spend cap、キー制限、請求状態は不明。

## クラウド資源・入力・漏洩

- **Project DB：** per-user 20 Projects、document 1 MiB、revision制御をDB/RLSで強制。user登録数には合計DB容量上限がなく、API rate limitもない。
- **Assets/Storage：** private bucket、音声32 MiB/画像10 MiB、Projectごとkind別1件、user 40 assets/840 MiB。Goはstream上限、MIME signature/hash検証、owner JWTとStorage RLS、ready server-only RPCを適用し、直接upload/ready迂回をlocal integrationで拒否。個人上限はあるが、全利用者合計Storage容量/費用、同時upload/download/削除、API頻度、保持期間、pending-upload期限/清掃のglobal ceilingは未実装/未確認。公開signupと併用すると個人上限の積み上げで全体資源が増える。
- **Python/Demucs/FFmpeg：** Go/Echoに解析実行routeはなく、Python IslandはローカルCLI。入力は.wav/.mp3、512 MiB、最大240秒、threads 1..16。ffprobe timeout 20秒、ffmpeg decodeは音源長に応じたtimeout。ファイル/実時間/thread数の上限はあるがOS/containerのメモリ・CPU総枠、並列実行制御なし。直接HTTP経由のF成立は現APIではしないが、Step 8でworker化/公開する場合にユーザー入力queue/APIを付ければ高負荷DoS経路となる。信頼できない第三者音源と既知のFFmpeg保留事項にも注意。
- **MIME/SSRF：** Assetはallowlistとserver側byte/hash検査。Project/BlueprintはJSON/schema validation。Go APIにcaller URLをfetchする機能・routeは見つからず、API由来のSSRF経路は確認できなかった。Python CLIはlocal file pathを直接受ける。ファイル形式検査は誤装偽装を減らすがFFmpeg parser脆弱性やresource exhaustion全般を排除しない。
- **Prompt injection：** `visualIntent`は500文字、他Summary文字列に長さ上限なし。入力内テキストはpromptへ含まれ、直接指示・prompt injectionは可能。しかし出力はJSON schema/Go Blueprint validatorで既存Effect等へ限定され、任意JS/Python/shader実行はない。AIが課金外の操作を起動するコード経路は見つからない。費用/品質の濫用、規約違反内容の生成を完全には防がない。
- **Secrets/logs：** Gemini keyはserver envからSDK clientへ渡し、Frontendへ配布しない。`.env`はmode 0600かつGit ignoreを確認し、値は読んでいない。Gemini診断logはclassification/status/latency/modelに限定し、API key/prompt/bodyをlogしないテストがある。Hosted Secret Manager、key API restriction、rotation・alert運用は未確認。プロセス環境はhost/process権限に依存するため`.env`のlocal ACLだけで本番保護を満たさない。
- **DB/RLS：** Project owner RLS/JWT、Storage policy、専用`arvc_asset_verifier`とprivate ready RPCはlocalで確認済み。VerifierはNOBYPASSRLS、No table ACL、RPC限定。Step 7c-1 negative integration testsとStep 7d-2の15/15 SQL invariantを根拠とする。Hosted role/network/pooler/effective permissionsは未検証。通常Project/Asset経路へservice_roleを使う実装は確認されない。

## 攻撃シナリオ

| ID | 成立条件・現行判定 | 影響 / 深刻度 | 最小修正案 | 修正後の検証 |
|---|---|---|---|---|
| A 未ログイン利用者がAI APIを直接実行 | **成立する。** Generate routeにJWT middlewareなし。現在はAPI_ADDR loopback固定だが、公開proxyで到達可能にするかbind制限を外すと任意callerがGeminiへ到達。CORSは防御にならない。 | Provider quota消費、課金、可用性阻害。公開時 **High（公開停止条件）**。 | RouteへJWT middlewareを適用し、認証済み`sub`と明示的AI利用資格を検証。login済みだけで自動開放せず、必要なら招待/承認。 | JWTなし/不正/期限切れ/role違い401、許可外user拒否、許可user成功。proxy経由直叩き・Frontend以外も試験。 |
| B 正規利用者の短時間大量要求 | **アプリ制御なし。** Provider RPM/TPM/RPD/該当spend rateはProject単位で一部防御するが値は動的でユーザー別ではない。APIにはsemaphore/rate limiterなし。 | Provider quotaを使い切る、他userを拒否、費用急増。 **High**。 | Auth後にuser別+project/global rate/token budget、全体同時実行上限、queue拒否をサーバーで強制。複数instanceでは共有Redis/DB等の原子的counterを使う。 | 並列/境界/複数instance integration test、limit後provider mock未呼出し、reset/window境界。 |
| C 複数アカウントで枠回避 | signup config true。登録数/メール確認/captcha/invite制御はHostedで未確認。現状AIにはuser枠自体がない。将来のuser-only quotaは複数アカウントで回避可能。Provider quotaはproject単位なので複数Auth userで増えない。 | Signup濫用、user quota回避、全体resource増加。 **Medium**（公開Authが自由signupならHighへ）。 | Invite/verified email/abuse controlsに加え、user capだけでなくproject/global provider budgetも課す。 | 未確認email/連続signup/重複アカウントと同一project aggregate limitを試験。 |
| D 大量入力・最大出力でtoken費用を増やす | 2 MiB request、Timeline件数上限、prompt compact、7,000 output tokensはある。個別Summary文字列やstemRms map key数、userごとの値/total token capなし。 | 入力処理・prompt token/出力費用増加。 **Medium〜High**。 | nested field/max-key/string長制限、input token count/estimated-cost cap、低いconfigurable output cap、duration上限を実解析契約に合わせる。 | 2MiB境界、huge strings/map, max token estimate、limit超過前にprovider未呼出し。 |
| E timeout/retryで利用量増加 | SDK retry nil、AutomaticContinuation false、120s context。HTTP errorはsanitize。Client disconnectはcontext伝播するがprovider停止・請求状態は不明。利用者のmanual retryと並行重複を抑えるidempotencyはない。 | 完了済み生成のresponse喪失後に再送し二重利用する可能性。 **Medium**。 | 1回callは維持し、client向けretry指示を慎重にし、短期間のidempotency/dedup keyまたは生成中重複排除を検討。provider call状態/費用を安全に記録。 | Mockでtimeout/disconnect/response-loss、重複key、429/5xx回数が各一回、再試行上限を確認。 |
| F 大量音源処理でCPU/メモリ占有 | 直接HTTP routeなし。local CLIは512 MiB/240秒/1..16 threadsだが同時実行数、OS memory/CPU quotaなし。公開API/workerから実行できるようになると成立。 | local machineまたは将来worker枯渇。現時点外部未認証remote経路なし。 **Medium（公開解析を追加する前のblocker）**。 | Worker前にowner auth、queue admission、per-user/global concurrency、CPU/memory/container limit、job timeout/cleanup、FFmpeg保守版を整える。 | synthetic bounded jobs並列時のCPU/RSS上限、cancel cleanup、malformed media timeoutを隔離環境で試験。 |
| G Storage/DB大量アクセス | Project/AssetはJWT/RLSとuser quotaあり。認証済み連続GET/upload/deleteを抑えるrate limitなし。global cap/expiryなし。公開signupがあれば複数userで個人quotaを積み上げ可能。 | 帯域、DB/API負荷、保存料。 **Medium〜High**（Hosted料金次第）。 | Auth rate limit + global storage byte/object ceiling、upload/download/concurrency cap、pending expiry/cleanup。Hosted provider quota/billing controlsも別途設定。 | user/global quota境界、同時reservation、RLS cross-owner、over-limit before Storage、deletion/retry test。 |
| H Gemini keyを取得しアプリ外で使用 | keyをFrontendに出さずserver envから使う。local `.env`は0600/ignored。ただしHosted Secret Manager/Google API restriction/rotation設定は未確認。 | key漏洩後はアプリのuser認証/limitを迂回してprovider Project quota/費用に直接影響。 **High if key leaks; current local control good**。 | Hosted secret manager、Gemini API専用restriction、最小IAM、key rotation/runbook、usage anomaly alert。必要時key revoke。 | frontend bundle/network/log/repo secret scan、restricted-key smoke、rotation drill、alert. 値を出さず検証。 |

## 公開前対策の優先順位

1. **P0 / High：** Generation endpointのJWT auth + explicit entitlement; API bind/proxy/CORSを認証とは別に整理。Authentication failure時はGemini client呼出しより前に必ずreject。
2. **P0 / High：** shared service-level kill switchと原子的な同時実行・request/minute・daily/monthly token/spend budgetを実装。user単位だけでは複数accountで回避可能。
3. **P1 / High：** model allowlist、nested string/map cardinality、input token/cost estimate、出力token ceiling、request timeout/body admissionを制限。Client disconnect時にprovider継続する可能性も含める。
4. **P1 / Medium-High：** signup/invite/verified account policy、認証endpoint rate controls、per-user + global DB/Storage cap、pending asset TTLをHosted仕様に合わせて定める。
5. **P1 / Medium：** Gemini keyをSecret Managerへ置きGemini-only restriction・rotation・alertを運用。provider spend capは過剰費用を軽減する追加層であってアプリ側quotaの代替ではない。
6. **解析公開の前提：** Python/DemucsをAPIから起動する前にjob admission/concurrency/resource isolation、FFmpeg保守状態、モデル重量許諾を解決する。

1,000円/月はプロダクト運用目標であって現在のコードに強制値はない。公式tier capはこれより大きく、Project capはexperimentalで遅延overageあり。最終的な停止許容額、為替/税、Google Billing account全Project集計、Prepay/auto reload方針を運用者が決めてから公開する。

## 確認済み事実・解釈・未確認事項

### 一次資料/コードで確認済み

- Route registryとhandlerに基づく全Go/Echo endpoint、JWT適用範囲。
- Geminiの1呼出し経路、env key、model override、120s context、retryなし、continuationなし、7,000出力token、2 MiB input、timeline limit。
- Project/Assetのowner JWT、per-user DB/storage上限、RLSとprivate Asset設計。既存local integration test記録。
- Python local CLIのfile/duration/thread上限とFFmpeg呼出しtimeout。
- `.env`のmode 0600/Git除外。秘密値は取得していない。
- Google official pricing, rate limits, billing/spend caps, API key guidance（上記リンク）。

### 合理的解釈

- 公開可能なnetwork pathが存在し、Gemini mode+keyが設定されると、unauthenticated callerはprovider quota/costを消費可能。
- per-user allowance aloneは複数アカウント、per-project provider quota、global Storage costを制御できない。
- bounded request/output token sizeは1回の消費を制限するが、無制限回数・並行数・月額総量を制限しない。
- Google月次caps/Prepayはアプリ固有の利用者制御ではなく、project capは公式説明上遅延overage可能。

### 未確認

- Hostedで実際に使うAPI address/proxy/network、JWT issuer/audience/JWKS、signup確認/CAPTCHA/rate settings、CORS/TLS/CSP。
- 対象Gemini Projectの現在のtier、active RPM/TPM/RPD、spend cap、Prepay/Postpay、billing alerts、key restriction、実請求。
- Hosted Supabase Storage/DBの料金・global quotas・retention、専用Verifier roleの運用。
- timeout/cancel後のGoogle側処理停止・請求確定時点、正確な一要求token/cost分布。
- OS/containerのメモリ制限、Go server defaults/ingress timeoutの最終公開構成。

## 監査完了判定

監査作業は完了した（`completed`）。これは公開準備完了を意味しない。**現在のloopback-only APIはlocal用途に限定される。Step 8で外部公開する前に、少なくとも未認証Gemini generationと、app側rate/token/concurrency/global budgetの未実装を解消し、公開構成で試験すること。** Hosted account/infra固有事項はStep 8前に別途確認する。

今回の変更は本報告、`CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`のみ。コード、DB、設定、外部API、Hosted、Docker、課金設定、GitHubへの変更・呼出しなし。
