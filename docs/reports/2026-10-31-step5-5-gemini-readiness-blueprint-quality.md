# Step 5.5 Gemini実API検証準備・Visual Blueprint品質評価

確認日: 2026-10-31（Asia/Tokyo）  
状態: **completed (実API未実施、Fixture/local evaluation complete)**

## 要約

実Gemini APIへの送信・課金状態変更は行っていない。ローカルFixtureでGo APIの起動、health/generate、Blueprint検証、Frontend取込とRendererの自動評価を行った。公式資料上、`gemini-3.8-flash`は現行StableかつStructured Outputs対応。Free Tierは利用できるが、Free TierデータをGoogle製品改善等に利用し、レビュー担当者が入力・出力を確認する場合がある。有料Tierでは製品改善に使わないが、安全性/不正利用監視を目的とした限定的なprompt/response loggingがある。

## モデル・SDK・互換性

- モデル候補: `gemini-3.8-flash`。公式モデルページはStableおよびStructured outputs対応を掲載。[モデル公式ページ](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- SDK: 既存のGoogle公式 `google.golang.org/genai` v1.77.0を維持。Go APIはREST `generateContent`、`application/json`、`ResponseJsonSchema`を使う。SDKはv1.77.0のAPI responseに`ModelVersion`と`UsageMetadata`（prompt/candidate/thought/total token counts）を公開する。[Google Gen AI Go SDK v1.77.0](https://github.com/googleapis/go-genai/releases/tag/v1.77.0) / [Go API reference](https://pkg.go.dev/google.golang.org/genai)
- 具体的不適合: Gemini 3.8 Flash移行案内は`temperature`、`top_p`、`top_k`等のsampling parameterを除くよう指示している。Step 5で指定していた`temperature=0.8`を削除し、他のモデル/SDK/依存版は変更しなかった。[Gemini 3.8 migration](https://ai.google.dev/gemini-api/docs/latest-model)
- SDK retry: `ClientConfig.HTTPOptions.RetryOptions`を未設定にするとSDKはHTTP retryを実行しないことをv1.77.0実装で確認。初回試験は1リクエスト/リトライなしを満たす。

## 料金・Free Tier・データ扱い（公式資料、確認日現在）

- 公式価格表にGemini 3.8 FlashのFree Tier「Free of charge」行があり、Free Tier利用可能。ただしモデルごとの利用可否/レート上限があり、アカウント固有値は別途確認する。[料金表](https://ai.google.dev/gemini-api/docs/pricing)
- Standard paid price: 入力 $0.75 / 1M text tokens、出力（thinking含む）$3.75 / 1M tokens through 2026-12-31。公式表は2027-01-01以降それぞれ$1.50 / $7.50と案内。今回のAPIはSearch/Maps groundingやcachingを使わない。実請求額は入力/出力トークン数等で変わり、1回あたり料金は実レスポンスのtoken metadataを取得するまで確定しない。
- Unpaid quota: Googleは送信contentと生成responseをサービス提供・改善・開発に利用可能。人のreviewerがinput/outputを読んだり注釈したりする場合がある。機密/個人情報は送信しないこと。[Additional Terms](https://ai.google.dev/gemini-api/terms)
- Paid API service: prompt/responseを製品改善に使用しない。一方、禁止利用ポリシー違反の検出等のため限定期間ログされることがある。厳密なzero retentionが必要ならGemini Developer APIだけで保証できるとは扱わない。[Paid Services terms](https://ai.google.dev/gemini-api/terms)、[ZDR guidance](https://ai.google.dev/gemini-api/docs/zdr)
- rate limits: RPM、input TPM、RPD等。model/tier/projectごとに異なり、実際のactive limitはGoogle AI StudioのRate Limitsで確認する。API key単位ではなくproject単位で適用され、RPDはPacific timeの午前0時にリセット。画面値はアカウント状態で変化し保証値ではない。[Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- Billing status、Free/Paid tier、active quota、費用上限はAI StudioのProjects/Billing/Rate Limits等で確認可能。本調査ではログインやプロジェクト変更をしておらず、アカウント固有情報は**未確認**。課金を有効化・変更していない。[Billing](https://ai.google.dev/gemini-api/docs/billing)
- API key: この実行環境では`GEMINI_API_KEY`/`GOOGLE_API_KEY`は**未設定**（設定有無のみを判定。値にはアクセスせず、表示/保存/ログ出力なし）。今後の実試験用キーはGo serverのprocess環境にだけ設定する。Frontend `VITE_`やレポートに配置しない。

## 実API試験計画（今回は実施しない）

### 送信候補

既存の非音源fixtureを使用する。

- [`api/testdata/music-summary.json`](../../api/testdata/music-summary.json): synthetic metadata、12秒、44100Hz stereo、4 stem RMS、推定kick count=2。`fixture` model表記。
- [`api/testdata/feature-timeline.json`](../../api/testdata/feature-timeline.json): 0/6000/12000msのBass値3点、kickは1000/6000msの2点。実音源由来ではない固定値。
- Go promptはMusic Summaryの検証済み必要フィールドと、Timelineから作るcompact summaryを送る。Feature summaryはduration、feature sample rate、Bass min/max/meanと最大64個の時刻/値、kick件数と最大64件時刻のみ。今回は3 bass/2 kickなので全fixture sampleを含むが、Timeline全量は送らない。ファイル/Stem/image/個人情報なし。
- 出力はEditorBlueprint v1。version=1、最大5 renderer Effect種（`pulse-scale`, `glow-brightness`, `rotation-movement`, `particles`, `waveform-bars`）、Binding source（`bass.envelope`, `kick.events`）、Regionの矩形または3..64頂点polygon、normalized 0..1 bounds。Effect 1件につき対応RegionとBindingが各1件。コード/URL/data URLは生成対象にしない。

### 承認後の単発手順

1. その時点の公式料金・Additional Terms・AI Studioのモデル有効性、ProjectのBilling tier/active quota/rate limitsを確認。実プロジェクト/課金状態の変更はしない。
2. 送信予定fixtureとpromptを確認し、Free TierならGoogleの改善利用/reviewer accessがあり得ることを踏まえ合成fixtureのみとする。API keyをGo serverの環境変数に安全に設定し、値をコマンド引数/ログ/Frontendに出さない。
3. `api/`で `BLUEPRINT_MODE=gemini GEMINI_MODEL=gemini-3.8-flash go run ./cmd/server`を起動。API_ADDRは127.0.0.1:8080のまま。
4. 合成fixture bodyを1回だけPOSTする。例: `curl --silent --show-error --output /tmp/gemini-blueprint-response.json --write-out 'http=%{http_code} total=%{time_total}s\n' --header 'Content-Type: application/json' --data-binary @/tmp/gemini-blueprint-request.json http://127.0.0.1:8080/api/v1/blueprints/generate`。timeout/429/5xxは無断retryしない。
5. HTTP成功、`model`（providerの`modelVersion`がなければconfigured model）、`diagnostics.latencyMs`、`diagnostics.usage`、`diagnostics.validation="passed"`、Blueprint v1を記録。`usage`が欠落する場合は取得不可と明記し、0 tokensに読み替えない。`curl` total timeはクライアントの往復時間、latencyはGo内のgenerationからvalidationまでの時間。
6. 出力JSONから個人情報/意図しない内容を確認し、Go validator、Frontend `validateBlueprint`、Rendererを通す。レスポンスを共有・保存する範囲を明示的に管理。

前提承認: **この実API POSTを実行する明示的なユーザー許可**。この報告でモデル/fixture/コスト/データ取り扱いは提示したが、許可はまだなく、今回リクエスト数は0。

## Blueprint品質評価

### プログラム判定（実施済み範囲）

- Go `blueprint.Decode`: schema v1、未知項目/型、Effect種、Binding種、Region geometry/正規化座標、要素上限、ID一意性、Effect↔Region/Binding参照を検証。
- API fixture response: HTTP 200、mode fixture、diagnostics.validation `passed`。response payloadでEffect種が対応範囲内、EffectのRegion参照とBindingのEffect参照、polygon座標範囲を別途assert。
- Renderer tests: 固定Timelineに対するBass/Kick binding反応とrelease、同一timeでのframe出力一致（他時刻seekを挟んでも変化なし）、Effect command生成、Region clip、Canvas描画例外なし（fake context）を確認。
- VisualEditor test: API fixture responseを取り込み、検証済みblueprintを反映するReact integration testあり。固定Timeline、Effect/Binding編集、seek/play/pause等も既存テストで確認。

### 人間の視覚評価（未実施）

ブラウザを使った実画素/見た目の受入確認は行っていない。Geminiから実生成したBlueprintも無いため、芸術性、視覚的読みやすさ、Effect数/種類の偏り、特徴量と見た目変化の知覚的な対応、長時間の演出疲労は人による評価が未実施。fake Canvas testは実ピクセル品質を保証しない。実API後は同じFixture Timelineを固定し、任意時刻とBass/Kickイベント前後を複数スクリーンショットで確認する。

Geminiの責務はこの音楽メタデータから宣言的な演出設計を作ることのみ。分離、Kick検出、Bass envelope生成、Canvas描画には関与しない。Renderer/Feature計算の責務は変更なし。

## 実行結果

- Go: `gofmt`, `go test ./...`, `go vet ./...` passed。新規確認項目にはGemini 3.8 sampling parameter不使用、診断情報のsanitized responseを含む。
- Frontend: 3 test files / 15 tests passed、typecheck、ESLint、Vite build passed。
- Local HTTP: loopback API起動ログでEcho v5.4.2/127.0.0.1:8080。`GET /healthz`=200。実fixture POST=200、curl total 0.001140s、mode=`fixture`、validation=`passed`、validated effects=`pulse-scale`,`waveform-bars`。Fixtureのusage metadataは提供されない。内部diagnostics latencyはミリ秒丸めで0msだった。
- Browser screenshot / visual human acceptance: 未実施。
- Gemini external requests: 0。API key 未設定。Billing/tier/quotaは個別アカウント情報未確認。
- Python tests: Python Island変更なしのため未実施。

## 変更ファイル

- `CURRENT_TASK.md`: Step 5.5だけを記述。
- `api/internal/service/gemini.go`: Gemini 3.8に不要/非推奨のsampling settingsを外し、SDK responseのprovider model version/token usageを保持。
- `api/internal/service/http.go`, `http_test.go`: latency、validation、usage、実model IDを含む非機密diagnostics応答とテスト。
- `docs/reports/2026-10-31-step5-5-gemini-readiness-blueprint-quality.md`: 本報告と次回単発試験手順。
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TECH_STACK.md`, `docs/SECURITY.md`, `docs/TEST_STRATEGY.md`, `docs/BLUEPRINT_SPEC.md`: 実API準備、データ/価格条件、品質評価と残項目。

禁止された実送信、課金設定、Cloud/GCP変更、Python/Demucs/FFmpeg変更、公開、pushは行っていない。
