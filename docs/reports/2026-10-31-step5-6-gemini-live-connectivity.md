# Step 5.6 Gemini実API疎通試験

確認日: 2026-10-31（Asia/Tokyo）  
状態: **partial（Free Tierで1回送信したが、Gemini応答を取得できず）**

## 事前条件

- 前回試験は送信0回でBilling Tier確認不能により停止。今回ユーザーが対象Google AI Studio ProjectのFree Tier設定を確認したと申告。
- Google公式モデルページを確認し、`gemini-3.8-flash`はStable、Structured Outputs対応と確認。[Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- 公式価格表に本モデルのFree Tier input/outputが`Free of charge`と記載されることを確認。Paid Standardのtoken単価もあるため、ユーザー確認済みのFree Tierを条件として1回を実施。[料金表](https://ai.google.dev/gemini-api/docs/pricing)
- 残りのproject-specific quota数値はAI Studioアカウント情報へアクセスできず独立確認していない。モデル利用可否とFree Tier価格は公式資料、ProjectがFree Tierという点はユーザー確認に基づく。Free Tier枠を超過する状態ならAPIがエラー応答になる前提で実行し、paidへ切り替える設定は行っていない。
- `api/.env`にGemini API key環境変数が非空であることを確認。`.env`には`GEMINI_API_KEY`と`GOOGLE_API_KEY`が両方設定されていたが、値は表示/記録していない。既存main.goは`GEMINI_API_KEY`を優先するため、試験サーバーprocessでは`GOOGLE_API_KEY`だけをunsetしてSDKの曖昧な環境警告を抑え、明示的な既存優先順位を保った。`.env`自体は変更していない。SDK v1.77.0のretry設定は未指定でretry無し。

## 実試験結果

- Gemini API POST: **1回**。追加POST/retryは0回。Gemini modeでloopback Go/Echo APIを起動し、12秒の合成`music-summary.json`と`feature-timeline.json`から作った既存request fixtureを使用。音源/Stem/画像/個人情報は送信していない。
- APIから`{"error":{"code":"gemini_upstream_error","message":"Gemini request failed"}}`を受信。Go APIのエラーmapping上HTTP **502**。生のprovider errorはAPIが意図的にsanitizeするため、認証拒否、モデル利用不可、Structured Output schema拒否、その他provider障害のどれかは特定不能。再送は禁止されているため調査目的の再呼び出しは行わない。
- Go内`diagnostics`、provider model version、token usageは成功応答にのみ含まれるため未取得。`curl --write-out`のtime出力はexec sessionの出力として回収できず、正確な応答時間は未記録。実行ツールはcurl開始から30秒時点で継続中となり、その後レスポンスfileが現れたため完了まで概ね30秒超だが、これは粗い観測であり確定値ではない。
- Structured Outputsによる生成JSONは取得できず、Go Blueprint Validationは実行対象のBlueprintがないため成功していない。生成Blueprintの保存なし。Visual Editorへの今回の生成物import確認も未実施。
- APIサーバーは停止済み。API keyの値はログ/レポートに出していない。初回のsandbox内server startupはloopback bind拒否でGemini通信前に終了し、その後許可済み環境でserverを起動。HTTP POSTは上記1回のみ。

## 原因と限界

判明したのはGo APIがprovider失敗をsanitizeして502で返したところまで。既存`classifyGeminiError`は429だけをrate limitとして区別し、それ以外のprovider statusをすべて`ErrUpstream`にまとめるため、provider status/bodyは記録されない。この安全なエラー応答から具体的根因は診断できない。推測による修正や二度目の実リクエストはしていない。

このためStep 5.6の成功条件（Gemini応答、Structured Outputs、Go validation、Editorで利用可能なBlueprint）は未達。1回の許可枠は消費済みで、このStep内の追加実リクエストは行えない。

## ローカル検証

- Go `go test ./...`: passed.
- Go `go vet ./...`: passed.
- Frontendはコード変更なし。生成Blueprintが得られなかったため今回の出力を使うVisual Editor検証は不能。既存のFixture/UI testsはStep 5.5報告を参照。
- API実requestは上記1回のみ。Gemini response/Blueprint/usageは成功データとして保存していない。エラーbodyは一時的に`/tmp`へ受け、報告にはsanitize済みcode/messageだけを記録。

## 変更・引き継ぎ

- `CURRENT_TASK.md`: Step 5.6範囲を維持（既存記載）。
- `docs/CURRENT_STATE.md`: ユーザー確認後のFree Tier試験、1回のupstream error、未取得metric、成功条件未達を追記。
- `docs/OPEN_ISSUES.md`: Billing Tier確認blockerを解除し、失敗後retry不可の未解決接続状態に更新。
- 本報告書: 前回0回の停止記録を残し、今回の唯一のPOSTと結果を追記。

追加送信、課金設定変更、Cloud/GCP操作、依存・SDK・モデル・Blueprint schema変更、Python/Demucs/FFmpeg変更、GitHub pushは行っていない。

## Step 5.6a：上流エラー診断の改善（2026-10-31）

前回の実行記録は変更せず、ローカル診断機構を追加した。実Gemini API呼び出しは **0回**。

- SDK v1.77.0の`genai.APIError`にHTTP status code、message、自由文字列status/detailsがあることを確認。HTTP codeを固定分類へ変換し、本文/message/status/detailsは記録しない。
- HTTP 400/401/403/404/429/5xxを個別分類。context timeout/cancelと`net.Error`をtransport failureとして区別。取得不能なstatusは省略し、上流本文は解析・出力しない。
- Gemini失敗時に構造化ログへevent、固定classification、数値HTTP status（SDKで取得できた場合）、経過ms、設定model IDを記録する。SDK error文字列、API key/Authorization、URL、prompt、Music Summary、生成本文はログしない。
- 外部API応答は互換性維持。429は従来どおり429/`gemini_rate_limited`、timeout/cancelは504/`gemini_timeout`、それ以外は502/`gemini_upstream_error`。
- SDK v1.77.0の実装はretry optionsがnilの場合1回のみ送信する。client設定でnilを明示し単体テストで確認。
- Table testでstatus分類、timeout、transport、機密文字列のログ非混入、外部応答sanitize、retry無効を検証。`go test ./...`、`go vet ./...`、gofmt、`git diff --check`が成功。

これは次回の**新たに許可された**実リクエストの失敗診断を可能にする変更であり、API利用可否やStep 5.6の原因自体を確定するものではない。Step 5.6の一回試験枠は消費済みで、再送には別途許可が必要。

補足（Step 5.6c）：上記「retry options nilで1回」はHTTP retryの意味であり、SDK `Models.GenerateContent`全体が常に一HTTP requestとは限らない。Go GenAI v1.77.0の`AutomaticContinuation`は未指定時trueで、successful continuation response時に後続GenerateContentを送る。Step 5.6bの504は最初のHTTP error responseのため継続は起きていない。将来厳密に単一HTTP requestとする場合は、別途許可を得て`AutomaticContinuation=false`を設定する必要がある。タイムアウト/ペイロード調査の詳細は[Step 5.6c報告](2026-10-31-step5-6c-gemini-504-timeout-investigation.md)。

## Step 5.6b: 再疎通試験（2026-10-31）

状態: **partial（送信結果・根因を取得できず）**

- `.env`の`GEMINI_API_KEY`/`GOOGLE_API_KEY`は両方とも空でないことだけを判定。値は表示・ログ・記録していない。既存の優先設定を用い、起動processでは`BLUEPRINT_MODE=gemini`、`GEMINI_MODEL=gemini-3.8-flash`、loopback bindを指定した。
- 既存12秒合成`music-summary.json`と`feature-timeline.json`から560 bytesのrequest bodyを生成。音源/Stem/画像/個人情報は含まない。Go build/tests/vetは成功。
- loopback health check成功後、retry 0の`curl` POSTを**1回だけ実施**。実行sessionの初期出力回収は遅延したが、同一試行のresponse fileとserver logを後続確認で取得した。再送はしていない。
- API外部応答はHTTP 502 / `gemini_upstream_error`。Step 5.6aの構造化ログは`classification=gemini_upstream_5xx`、`upstream_http_status=504`、`latency_ms=42019`、`model=gemini-3.8-flash`を記録。すなわち上流からHTTP 504 Gateway Timeoutが返り、Go APIは従来どおりsanitizeして502へ写像した。分類・statusは確定したが、Google側内部のさらに細かい原因までは応答に情報がなく特定不能。
- API内所要時間は42,019 ms。curlのclient total timeは実行session出力から回収できず未記録。provider model version、token usage、Blueprintは得られていない。
- Blueprintが無いためGo response validation（成功Blueprint対象）とFrontend `validateBlueprint`、Visual Editor取込・描画は未実施。API processは終了済み。API key、prompt、上流本文は報告に含めていない。
- 再検証: Go `go test ./...` / `go vet ./...` passed。Frontend Vitest 3 files / 15 tests、typecheck、lint、build passed。生成Blueprintが無いため、この実行固有のFrontend import/visual checkはできていない。
