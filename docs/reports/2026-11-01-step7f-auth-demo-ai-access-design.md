# Step 7f：認証・デモ・AI利用制限の設計

実施日：2026年11月1日
状態：**completed（read-only調査・設計案）**

## 要約

基本方針として、未認証ユーザーには固定素材によるローカルデモ、認証済みユーザーにはフルEditorとowner-scoped Cloud Project、AI利用許可も得た認証済みユーザーにはサーバー強制のGemini生成枠を提供する三段階を提案する。デモはGemini、Demucs、外部従量処理を呼ばない。

公開前の必須条件は、Blueprint生成routeへのJWT検証とAI利用資格検査、複数API instanceで共有される原子的な回数・token・費用・同時実行制御、および全体停止機構である。現状では生成routeは未認証であり、これらの利用枠は存在しない。APIがloopback bindである現在のローカル制限を解除する前に実装する必要がある。

Frontendは既存React、Auth session、Editorを再利用し、pathnameによる小さな画面分岐を提案する。React Router等の新依存は不要。実装・DB・Migration・環境変更、Hosted接続、Gemini実リクエストは行っていない。

## 1. 調査範囲・根拠

指定順でProject Context、Development Rules、Current State、Step 7e監査、Step 7d-2報告、CURRENT_TASK、SECURITY、API_CONTRACTSおよび関連コード・Migration・テストを読んだ。`.env`や資格情報の値は読み出していない。コード・DB・設定・Docker・外部サービスの状態は変更していない。

主要な実装根拠：

- `frontend/src/main.tsx`は`<VisualEditor />`を直接mountし、Router依存はない。`frontend/package.json`にもRouter/Auth SDKはない。
- `frontend/src/VisualEditor.tsx`はEditor、Cloud Auth/CRUD、ローカル`.arvproj`、WebM、Blueprint生成操作を一つの大きな画面に含む。ログイン表示はProject Cloud UIのUXであり、生成routeの認可ではない。
- `frontend/src/auth-client.ts`は既存Supabase Auth RESTとtab-scoped `sessionStorage`、`validSession()`を使用する。`cloud-api.ts`はGo APIへBearer tokenを付ける。
- `frontend/src/editor-model.ts`の`demoTimeline`（12秒）と`initialEditorBlueprint`は固定fixtureとして再利用可能。現在のEditor Playは時間を進めるが音源を再生しない。
- `api/internal/service/http.go`は`POST /api/v1/blueprints/generate`をmiddlewareなしで登録する。Fixture endpointテストはAuthorizationなしの200を期待する。
- `api/internal/authn/jwt.go`は署名方式・issuer・audience・role・exp・UUID subを検証する既存Validator。ただしloopback HTTP issuer専用で、Hosted issuer設定にはそのまま使えない。
- `api/cmd/server/main.go`は現在loopback以外のlistenを拒否する。Project/Assetを有効化するときはAuth/JWKSとAsset verifier不足でfail-fastするが、生成APIはこの設定と独立する。
- Gemini経路は`api/internal/service/gemini.go`の単一GenerateContent呼出し。HTTP retryとAutomatic Continuationは無効、deadlineは120秒、出力上限は現状7,000 tokens。利用者別/全体のquota、予算、同時実行制限、停止スイッチはない。
- `supabase/config.toml`のlocal Auth signupは有効。これはHosted環境の設定・実効状態を証明しない。
- Step 7b/7cのProject/Asset owner JWT・RLS・Storage制約と`arvc_asset_verifier`権限境界はlocalで確認済み。AI利用資格やAI予算を担う契約ではない。

資料とコードの差：`docs/SECURITY.md`と`docs/API_CONTRACTS.md`には将来のAPIでJWT検証する一般方針があるが、Blueprint生成routeには未適用。Step 5 API契約も正式な公開認証契約は未決定と記す。実コードの未認証動作を優先して現在リスクとして扱う。

## 2. 推奨画面構成

ルート名は論理契約とし、実装は`window.location.pathname`による分岐と通常の`<a>`遷移で足りる。ViteのSPA fallbackと本番配信設定は別途確認する。Auth状態の初期復元中は保護画面やCloud操作を表示せず、session確定後に描画する。

| Path | 表示・動作 | 境界 |
|---|---|---|
| `/` | プロダクト説明、固定デモ、Loginへの導線。sessionがあれば`/app`導線も表示。 | Gemini/Cloud操作なし。 |
| `/demo` | 合成された同一配布物の短い音源、既存Feature Timeline/Blueprintでsample preview。選択・再生・seekと一時的な演出編集。 | network fetchはsame-origin固定assetだけ。Go API、Supabase Cloud、Gemini、Demucs/解析APIを呼ばない。利用者音源uploadも受け付けない。 |
| `/login` | 既存`auth-client.ts`でログインし、成功時に許可済みの内部`next`へ遷移。 | URL redirectは同一origin内の許可routeだけに制限。tokenは表示・ログに出さない。 |
| `/app` | 認証必須の既存フルEditor。local編集、`.arvproj`、WebM、Cloud Project/Asset機能。 | 未認証・失効時はsessionを消去してLoginへ。Cloud APIは既存JWT/RLS。AIボタンの表示制御はUXのみ。 |

Editorは共通コンポーネントに`variant`/capabilitiesを渡し、既存Rendererを再利用する。固定サンプルは第三者コンテンツでなく、短い合成WAVを`frontend/public/demo/`等のsame-origin静的assetとして置き、timeline/blueprintは既存fixtureから読む案。sample再生とvisual時間を合わせるにはAudio要素の`currentTime`を時計とし、play/pause/seek/endを同期する小さなadapterが必要。Rendererや解析処理の責務は増やさない。

公開`/demo`では固定サンプルのpreviewと一時編集を基本とし、Cloud操作・任意音源処理・`.arvproj` import/exportは出さない案を推奨する。既存の未認証ローカルEditor・`.arvproj`・WebMはローカル開発モードとして維持する。サンプル限定WebM出力を公開demoで許可するかは負荷・UX判断として未確定。WebMはブラウザ内ローカル処理でありGemini課金はないが、CPU/帯域・利用者体験の上限は別途必要。

## 3. 権限マトリクス

| 機能 | 未認証 | 認証済み・AI未許可 | 認証済み・AI許可 |
|---|---:|---:|---:|
| `/`, 固定`/demo` | 許可 | 許可 | 許可 |
| `/app`のフルEditor | 拒否（Loginへ） | 許可 | 許可 |
| 固定素材の再生・seek・一時編集 | 許可 | 許可 | 許可 |
| 任意音源/画像を使ったlocal Editor、`.arvproj`、WebM | 公開demoでは対象外。既存local-devはlogin不要 | 許可 | 許可 |
| Cloud Project CRUD / Asset | 拒否 | 許可（既存owner JWT/RLS） | 許可（既存owner JWT/RLS） |
| Blueprint生成API / Gemini | 拒否（401） | 拒否（403） | quota内だけ許可 |
| Demucs等の高負荷解析API | 提供しない | 提供しない | 提供しない（別承認・別契約） |

認証状態はJWTが有効か、AI資格はserver-side entitlementが有効かという別判定とする。Project所有権・Asset RLSもAI資格とは独立する。画面のroute guard、disabled button、CORSはAPI認可の代替ではない。

## 4. 認証・資格・生成フロー

1. Frontendは既存sessionを復元し、認証済み画面にのみCloud Project UIを表示する。Generate要求には同じaccess tokenをBearerで付け、ランダムな`Idempotency-Key`を付ける。
2. Go routeはJWT middlewareで署名・issuer・audience・role・expiry・subjectを検証する。失敗時401で終了し、body parse・DB予算予約・Gemini呼出しをしない。
3. 信頼済みDBから`sub`のAI entitlement、期限、全体kill switch、model allowlistを確認する。資格がない/無効なら403。資格はJWT `user_metadata`、Frontend state、リクエスト中のuser IDでは決めない。
4. 入力をJSON/Blueprint v1の既存validatorとより厳しい生成専用上限で検証し、prompt/token最大量を確定する。予算DBが unavailable ならfail-closedで503。
5. DB transaction/RPCでユーザー/全体request-token-cost予約、Idempotency-Key一意性、全体/ユーザー同時実行枠を原子的に獲得する。満たさない場合429または503、Geminiは呼ばない。
6. 固定allowlist modelへ1回だけGenerateContent。SDK retryは無効維持。client disconnect/120秒timeoutはcontextへ伝えるが、provider側停止・非課金は保証と見なさない。
7. 応答はGo Blueprint validatorでschema、参照、数値、Effect等を検証する。検証成功とusage確定後に実績を精算し、検証済みBlueprintだけを返す。秘密・prompt・音源・summary全文をログやusage ledgerへ保存しない。
8. Frontendは401で再ログイン、403でAI未許可、429でquota上限、503で全体停止/予算制御停止を表示。再送は同じidempotency keyを使う。

Fixture modeは公開`/demo`から呼ばない。local testはMock/Fixtureの専用test serverに閉じる。Gemini modeはloopback外で起動する場合、auth/entitlement/budget設定不備を起動時fail-closedにする。Production configurationがfixtureへ暗黙fallbackしない。health endpointはprovider keyやbudget detailを返さない。

既存JWT Validatorはlocal issuer限定のため、Hosted `/app`/AI公開には、許可issuer・JWKS rotation・issuer/audience/alg policyを構成可能にして別途テストする必要がある。Hosted検証を本設計だけで完了扱いしない。

## 5. Signup・利用資格データモデル

### 推奨

初期公開候補は**招待・承認制**とし、Authで登録できてもAI利用資格は自動で与えない。Hosted email confirmation/CAPTCHA/signup rate limitsの実効設定は別途確認する。MVPで管理画面を作らず、権限の限られたoperator手順で資格をgrant/revokeする。signup制限は複数アカウント回避を完全には止めないため、service-wide枠を別に強制する。

Migration 016候補の最小概念モデル：

- `ai_entitlements`: `user_id` PK/FK auth.users、`enabled` default false、`granted_at/by`、`expires_at`、理由コード（個人情報を含めない）。利用者自身・authenticated JWT・anonから変更不可。
- `ai_budget_control`: singleton、enabled、許可modelと価格表version、day/month request/token/cost上限、concurrency上限。kill switchはDB durable flagに加え、即時停止用process/env overrideをAND条件で使い、どちらかoffなら拒否。
- `ai_generation_usage`: request ID、user ID、idempotency key hash、固定model/pricing version、state、reserve/actual input/output token、reserve/actual cost micros、created/started/settled/lease times、安全なerror class。prompt、Music Summary、Feature Timeline、API key、JWT、raw provider bodyは記録しない。

利用者から見えるentitlementやusage summary endpointは必要最小限にする。最初は別usage APIを増やさず、認可エラー/429と固定文言でUIを案内する案。

### DB権限境界

現行`arvc_asset_verifier`へAI予算権限を追加しない。別Migrationで専用`arvc_ai_budget` server roleを用意する候補。NOBYPASSRLS/NOINHERIT/非superuser、業務表の直接SELECT/INSERT/UPDATE/DELETEなし、`arvc_internal`の限定SECURITY DEFINER reservation/settlement関数のみEXECUTEとし、PostgREST公開schemaへ含めない。関数は空`search_path`、完全修飾参照、owner・上限・状態遷移を再検査し、PUBLIC/anon/authenticated/service_roleへEXECUTE付与しない。Go server-only DSNはsecret storeに置く。Hosted Supabaseでこのrole/connection modelが成立するかは公式サポートと実環境を別途確認するまで未確定。service_roleを通常AI予算処理へ使わない。

## 6. 利用量・原子的予約・精算

PostgreSQLを共有状態の正とし、新Redisは不要。単一transactionのprivate RPCがglobal control rowとuser budget rowを一定順でlockし、entitlement、期間別上限、model、idempotency、予算、active concurrencyを判定・予約する。複数API instance間で同じDB lock/unique constraintが競合を直列化する。DBが使えない場合、メモリ内代替へ切替えずGemini呼出しを拒否する。

候補state：`reserved` → `succeeded` / `failed_known_unbilled` / `usage_unknown`。予約には設定上限に基づく最大token/costを確保し、成功時はprovider usage metadataで実消費を精算して未使用予約をreleaseする。request前に明確に拒否されたエラーだけ、根拠がある場合に限り費用をreleaseする。usage欠落、client disconnect、timeout、provider応答不明、精算transaction失敗は`usage_unknown`として最大予約を保持し、0使用と扱わない。active concurrency leaseは実処理終了時releaseし、process crash時は短いlease expiry後にslotだけ回収する。費用予約はoperator/provider usage照合まで保持する。無制限自動retryは禁止。

同じ`Idempotency-Key`で成功済み：24時間程度の短期cacheが承認された場合だけ同一検証済みBlueprintをreplayし、provider callをしない。in-progress/usage_unknown：409/202で再実行しない。failed-known：保存済みterminal resultを返す。別keyは新規枠を消費する。promptや音源要約を保存しない。Blueprint cacheもユーザー成果物の保持となるため、TTL・暗号化・削除方針の承認が要る。cacheを承認しない選択ではduplicate keyを409として再生成しない。

全体停止はoperatorがDB controlをoffにするdurable switchとenv kill overrideを併用する。月額予算到達、価格不明、モデル変更、usage metadata欠落の急増時にfail-closedする。監視にはmodel/pricing version、HTTP分類、latency、token/cost集計、reservation backlog、unknown state数だけを出す。個別promptやユーザーの音響内容は記録しない。

## 7. 初期上限候補（未承認）

Google公式価格表（Step 7e監査が2026-11-01確認）ではgemini-3.8-flash paid rateは2026-12-31までinput $0.75/M・output $3.75/M、2027-01-01以降$1.50/M・$7.50/M（thinking tokenはoutput側）。8,000 input + 4,000 outputなら新料金で最大見積り約$0.042/呼出し、20回で約$0.84。現行料金なら約$0.42/20回。価格・課金条件はprovider側で変化し得る。

| 制御 | 初期候補 | 備考 |
|---|---:|---|
| Model | `gemini-3.8-flash`固定allowlist 1件 | env任意overrideをproductionで禁止。pricing versionのないmodelはfail closed。 |
| user request | 2/day、10/month | 認証済み・明示許可user。 |
| service request | 5/day、20/month | 複数アカウントを含む共有上限。 |
| max prompt input | 8,000 tokens | 2 MiB transport limitより強い意味上限。実token見積り/SDK supportを実装前検証。 |
| max output | 4,000 tokens | 現行7,000から引下げる候補。完全Blueprintをfixture/mockで品質検証して決定。 |
| concurrency | global 2、user 1 | DB予約でatomic enforcement。 |
| service hard estimate budget | $1.50/month候補 | 20 request worst-case $0.84 (2027 rate)に余裕を持つ例。為替、税、price change、provider processing uncertaintyがあるため¥1,000保証ではない。最終額は保守的なUSD換算・税・為替bufferを承認し、より低い方を採る。 |
| request input | 既存2 MiBからgeneration-onlyでより小さく | 例として256 KiB transport。Summary文字列/map entry数/durationも別上限化。仕様v1 validatorとの互換確認が必要。 |

現在のduration上限24hや任意Metadata長はAI promptに必要な規模を超える。生成APIだけにduration 240s以下、各文字列長/要素数、compact feature countを制限する候補。既存Project/Blueprint契約自体は変えず、generation request boundaryで制限する。8k/4k予算、為替・税を含む¥目標保証、実usage metadataの安定性は未確定であり、表は提案であって決定値ではない。

Providerのproject spend capやalertはアプリ予算の代替ではない。Step 7eで確認した公式資料上、Project capはexperimentalで遅延overageがあり得る。Alertは通知であり停止保証ではない。安価な上限設定/Prepay等を使う場合も残余overageを前提に別途承認し、今回の作業ではbillingを照会・変更しない。

## 8. 既存コードへの影響・Migration

| 対象 | 実装工程で想定する最小変更 |
|---|---|
| `frontend/src/main.tsx` | pathnameによる`/`, `/demo`, `/login`, `/app` dispatch。Router依存なし。 |
| `frontend/src/VisualEditor.tsx` | shared Editorのvariant/capability gates、demo sample時計、ログイン/資格エラー表示。Renderer/export coreは変更しない。 |
| `frontend/src/auth-client.ts` / `cloud-api.ts` | 既存session利用、Generate adapterへBearerとidempotency header、401/403/429/503表示。token log禁止。 |
| `frontend/public/demo/`またはfixture module | 合成短音源、既存timeline/blueprint fixture。third-party mediaなし。 |
| `api/internal/service/http.go` | generation routeを既存JWT middleware後にentitlement/budget serviceへ通す。外部error sanitize維持。 |
| `api/cmd/server/main.go` | Hosted向けissuer/JWKS設定は別検証のうえ追加、Gemini modeのauth/budget misconfig fail-fast、model/pricing allowlistとkill switch。 |
| 新規 `api/internal/aibudget/` | Reserve/settle interface、Postgres implementation、fail-closed policy、unit/integration tests。 |
| Supabase | Step 7b/7c/7c-1不変条件を維持する新Migration候補016、private entitlement/control/usage tables、限定RPC・専用role。 |

既存Project/Asset migrations 001–015、Cloud Envelope v1、`.arvproj v1`、Renderer/WebM/Python Islandは変更しない。Migrationは単一サーバー予算、資格、集計period、reservation、concurrencyを共有するため必要。実装前にfresh local DB bootstrapと権限handoffをStep 7b-2方式に合わせて設計する。Hosted migrationは対象外。

## 9. テスト計画・受け入れ条件

### Frontend / demo

- route direct navigation、未知path、session復元中、期限切れ、login/logout/next allowlist。
- 未認証demoで同一origin固定素材のみ読込み、API fetch spyで`/api/v1/blueprints/generate`・Cloud/Auth/Storage呼出しが0。
- demo play/pause/seek/endと音源時計・Renderer時刻一致、固定timeline/blueprintでの描画、編集は一時stateだけ。
- `/app`未認証redirect、Auth済みAI未許可/許可でbutton状態が異なるUX、直接API拒否も別に確認。
- 既存local-only Editor、Cloud CRUD/Asset hydrate、`.arvproj v1`、WebM、Renderer determinism回帰。

### Go / DB / mock provider

- JWTなし/署名不正/期限切れ/issuer/aud/role/sub不正は401かつentitlement DB/Generator呼出し0。
- valid JWT + no/expired entitlementは403、Generator呼出し0。authorizedはmockのみ成功。
- body/summary/map/Timeline/token/output上限、unknown model/pricing、disabled global switch、DB unavailableでfail-closed。
- atomic reserve/settle、計算・通貨単位・period boundary、同一/別idempotency key、known 429/5xx、timeout/client cancel、unknown usage、settlement失敗。
- 並列user/global上限・budgetを上回らず、global lock順序でdeadlockなし。複数API instanceからlocal Postgresを共有して競合試験。
- dedicated roleだけが必要RPCをEXECUTEし、table直アクセスなし。PUBLIC/anon/authenticated/service_roleからprivate RPC拒否、PostgREST schema非公開。既存Step 7b/7c invariants保持。
- API key、Authorization、prompt、Summary/Timeline、provider bodyがlogs/errors/DB usageに混入しない。

Gemini実APIは呼ばない。Gemini mock/Fixtureでusage metadata欠落・Structured Outputs異常系を注入し、request call count 0/1を確認する。Step 7eに列挙された既存Project/Asset RLS local integrationを回帰する。

### 完了条件

本設計の実装完了は、3権限状態、demo non-billable/no-server-work境界、hosted JWT認証、AI entitlement、shared atomic quotas/budgets/concurrency、fail-closed kill switch、mock/DB並列試験、および`.arvproj`/WebM/Cloud回帰をすべて満たすこと。Hosted公開は別の明示承認・環境検証まで不可。

## 10. 未確定事項・実装前の承認

1. **Signup方式**：初期は招待・operator承認を推奨。メール確認、CAPTCHA、Hosted Auth rate limitをどこまで必須にするか。
2. **Quota初期値**：候補（2/user/day、10/user/month、5/global/day、20/global/month、8k input、4k output、global concurrency 2/user 1、$1.50/month hard estimate）を承認・変更する。為替/税/price buffer込みで¥1,000以下を保証可能な額を決める。
3. **資格運用**：operator grant/revoke主体、監査記録、期限、緊急停止担当者。
4. **専用DB role/Hosted成立条件**：`arvc_ai_budget`の専用DSNを許可するか、Hosted Supabase上で最小権限接続/RPCがサポートされることを何の公式証拠で確認するか。
5. **Idempotency**：検証済みBlueprintだけを24時間保持して再送応答するか、同一keyの再試行を常に409にするか。
6. **Demo範囲**：固定素材を一時編集可能にする範囲、sample-only WebMを公開demoで許可するか。実音源/`.arvproj`の未認証公開機能は既存local modeと区別する。
7. **Hosted JWT**：issuer/JWKS、rotation、audience、secret storage、TLS/CSP/allowed origins、匿名health endpointを実環境で検証する計画。
8. **費用停止**：Google側のcap/Prepay/alertを追加防御として何を設定するか。いずれも遅延等の残余費用をアプリ強制上限と混同しない。

## 未確認事項

- Hosted Supabase Authのsignup・email confirmation・JWT/JWKS・専用role/connection・RLS実効権限。
- Gemini APIの個別Projectのtier、実効quota、課金設定、API key restrictions、project spend cap。
- Hosted deploymentの複数instance数・DB接続プール・DB latency・価格換算・実運用コスト。
- Geminiのtoken counting/usage metadataが候補上限を正確に満たすか。最終SDK仕様は実装時に再確認する。
- 公開demo用音声・WebMの帯域/CPU上限。公開demoの視覚評価は人手実施が必要。

## 実施していないこと

アプリコード、Migration、DB、RLS、Auth設定、Docker、環境変数は変更していない。Hosted Supabase/Gemini APIへ接続していない。実課金・AI API・負荷試験・GitHub pushは行っていない。

## 参照

- [Step 7e監査報告](2026-11-01-step7e-auth-ai-cost-resource-abuse-audit.md)
- [Step 7d-2 local E2E報告](2026-11-01-step7d-2-verifier-e2e.md)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini API billing / spend caps](https://ai.google.dev/gemini-api/docs/billing)
- [Gemini API key security](https://ai.google.dev/gemini-api/docs/api-key)
