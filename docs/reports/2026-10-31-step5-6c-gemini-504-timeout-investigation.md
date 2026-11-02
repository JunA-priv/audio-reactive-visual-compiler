# Step 5.6c Gemini 504 Gateway Timeoutの調査

調査日: 2026-10-31（Asia/Tokyo）  
状態: **completed（read-only診断。実API送信0回）**

## 結論

Step 5.6bの応答は、Go側のdeadlineやHTTP transport timeoutではなく、SDKが受け取った上流HTTP 504だった。Go APIはそれを`gemini_upstream_5xx`として記録し、既存契約どおり外部にはHTTP 502 / `gemini_upstream_error`を返している。

ただしローカルは45秒deadlineをGemini SDKへcontext伝播し、SDK v1.77.0は残り時間を丸めた`x-server-timeout` headerに載せる。このdeadline handoffは今回の504に関係した有力な候補だが、Gemini側がheaderをどう適用したか・なぜ42,019msで処理が打ち切られたかはresponse bodyを保存していないため確定できない。Gemini 3.xのdefault thinking（medium）とStructured Outputsによる生成時間も候補だが、個別の影響は測定されていない。

今回、timeout、SDK、model、schema、runtime設定は変更していない。

## Timeout・Context・Transport

| 層 | 採用設定 / 動作 | 504との関係 |
|---|---|---|
| Echo `Start` / `http.Server` | Echo v5.4.2 `StartConfig`の`ReadTimeout=30s`。`WriteTimeout`は0（未設定）、`ReadHeaderTimeout`も明示なし。 | ReadTimeoutはrequestの受信側。560 byte requestのbody受信後にGemini応答を待つ42秒を切る設定ではない。WriteTimeoutもhandler応答を42秒で止めない。Echoの[採用版server.go](https://github.com/labstack/echo/blob/v5.4.2/server.go#L750-L784)。 |
| API handler context | mainは`Timeout=45s`を渡す。`generate`はbody read・JSON decode・入力検証後、Gemini modeで`context.WithTimeout(r.Context(),45s)`を作る。 | SDKへこのcontextを渡す。Step 5.6bの応答は42.019sで到着し、`context.DeadlineExceeded`ではなくSDK `APIError.Code=504`として分類された。したがってローカルdeadlineが先に発火した事象ではない。 |
| SDK `HTTPOptions.Timeout` | `nil`（未指定）。 | SDK独自の短いrequest timeoutなし。 |
| SDK `HTTPClient` | v1.77.0 `NewInternalAPIClient`が`&http.Client{}`を作成。`Timeout=0`。client configから取得する値をoffline testで確認。 | `http.Client.Timeout`による約42秒の全体deadlineなし。 |
| Go default Transport | SDK default clientは標準`http.DefaultTransport`を使う。Dial timeout 30s、TLS handshake 10s、IdleConnTimeout 90s、ExpectContinue 1s。`ResponseHeaderTimeout`は未設定。 | Transport phase timeoutは通常Go側のtransport errorとして返る。HTTP 504の`APIError`を受信した記録とは異なる。 |
| Proxy | HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXYの環境変数は実行環境および`api/.env`に設定なし。SDK default transportは`ProxyFromEnvironment`を使う。 | 明示proxyは確認されない。透過的なネットワーク中継の有無まではローカルから判定できない。 |
| SDK Retry | `HTTPRetryOptions=nil`。v1.77.0の`retryHTTPRequest`はnilなら1回だけ実行。 | HTTP 504を受けた後のretryなし。 |
| SDK Automatic Continuation | `GenerateContentConfig.AutomaticContinuation=nil`。v1.77.0の`shouldEnableAutomaticContinuation`はnilをtrue扱いし、成功応答が`CONTINUATION`の場合は次のGenerateContentを送る。 | Retryとは別の機能。今回は最初の呼出しがHTTP 504で終わりcontinuation tokenを持つ成功応答がないため、追加呼出しは発生していない。将来「SDK内部も含め1 invocation=1 HTTP要求」を保証するなら、別途許可を得て`AutomaticContinuation=false`を明示する必要がある。 |

Go GenAI v1.77.0の根拠は[api_client.go](https://github.com/googleapis/go-genai/blob/v1.77.0/api_client.go#L55-L80)、[client.go](https://github.com/googleapis/go-genai/blob/v1.77.0/client.go#L475-L535)、[common.go](https://github.com/googleapis/go-genai/blob/v1.77.0/common.go#L471-L480)、[models.go](https://github.com/googleapis/go-genai/blob/v1.77.0/models.go#L5640-L5675)、[continuation.go](https://github.com/googleapis/go-genai/blob/v1.77.0/continuation.go#L53-L58)を採用タグのローカルmodule cacheと照合した。

SDK v1.77.0 `buildRequest`は`context deadline`、HTTPOptions timeout、HTTPClient timeoutの最小時間を推定し、残り秒数をceilして`x-server-timeout`へ設定する。今回のHTTPOptions/client timeoutは無指定/0なので、生成直前の45秒contextが元となり、およそ45秒が通知されたと考えられる（実際の送信header値は保存していない）。SDK source comment上、このheaderはend-to-end timeoutをloggingに使うものとされる。Google側のdeadline処理との正確な関係はコードだけでは確定できない。

`startedAt`はhandlerで入力検証が終わりmode switchへ入る直前に設定し、Gemini error logで`time.Since(startedAt)`を記録する。したがって42,019msはAPI入力受信全体の時間ではなく、ほぼGemini generation待ち時間。contextはその直後に作られるため2つの開始点は近いが、同一時刻ではない。curl client total timeは未取得のまま。

## Gemini GenerateContent requestの構成

- **Model / endpoint:** 設定`gemini-3.8-flash`。SDK v1.77.0はAPI version未指定時`v1beta`、`models/{model}:generateContent`を使う。Google公式model pageはこのmodel IDをStableとして掲載し、Structured Outputs対応を記載している。[model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- **Contents:** `genai.Text(prompt)`でrole=user、text partを1つ送信。SystemInstructionは未設定。12秒SummaryとTimelineのcompact feature statisticsを単一User Promptに含める。
- **送信データ統計（UTF-8 bytes）:** 外向きAPI request fixture 560 bytes、Summary 445 bytes、Feature Timeline 234 bytes、compact Feature Summary 243 bytes、`BuildPrompt` 917 bytes。Timeline全体はGeminiへ送らず、fixtureでは3 Bass sample/2 Kick sampleのみcompact値として含む。
- **小さな重複:** Music SummaryとFeature Summaryの両方に`durationMs`とfeature sample rateが含まれる。音源/Stem/画像やTimelineの重複送信はない。byte数上の小さな冗長性はあるが、42秒原因とする証拠はない。
- **Structured Output:** `responseMimeType=application/json`、`responseJsonSchema`。SchemaのJSON serializationは2,959 bytes、最大JSON nesting depth 12。`properties`/`required`/`additionalProperties`、`enum`、`items`/`minItems`/`maxItems`、`minimum`/`maximum`を使用し、unionやreferenceは使わない。
- **Schema contract:** root EditorBlueprint v1。Regionはrect/polygon、normalized bounds 0..1、polygon 3..64 points。上限はRegions/Effects/Bindings各32。Effect 5種、Binding source 2種。Effect-region/binding参照やvariant固有要件はGo validatorが別途検査する。
- **Payload size:** SDKの既知構造（contents + generationConfig）にpromptとschemaを載せたJSON構造推定は4,116 bytes。HTTP headerを含まず、実network bodyをcaptureした値ではない。
- **Generation config:** `MaxOutputTokens=7000`（公式model出力上限65,536より小さい）。ThinkingConfig、temperature、topP、topK、candidateCountは未設定。Google公式thinking guideは`gemini-3.8-flash`のdefault thinkingをOn/medium、対応levelをlow/medium/highとしている。Official troubleshooting docsはGemini 3.xのthinkingがlatencyを増やす場合があると説明する。[thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking)、[troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)

GoogleのStructured Outputsは使用中のschema keywordをサポートする。公式docsは非常に大きい/深いschemaや大きなnested `maxItems`がconstraint-state超過による400の原因になる可能性を挙げるが、今回観測したstatusは400ではなく504で、schema拒否を示す証拠はない。2,959 bytes/depth12/64 point upper boundがgeneration latencyへ影響しなかったとは断言できない。応答本文は保存していないためschema詳細のprovider診断も取得不能。[Structured Outputs schema subset/limitations](https://ai.google.dev/gemini-api/docs/structured-output?hl=en)

## 504分類と外部API契約

Step 5.6aの記録は`classification=gemini_upstream_5xx`, `upstream_http_status=504`, `latency_ms=42019`。SDK `APIError`を受け取ったため、これはcontextのdeadline発火・transport timeoutとは別である。Go handlerはcontext deadlineならHTTP 504/`gemini_timeout`、上流APIError 504なら一般upstream errorとしてHTTP 502/`gemini_upstream_error`へsanitizeする。Step 5.6bの外部HTTP 502は既存実装どおり。

Google公式GenerateContent API errorsは504 `DEADLINE_EXCEEDED`を「service unable to finish processing within the deadline」と分類し、prompt/contextが大きい場合を例示して、client deadlineを延ばす案内を掲載する。今回の4.1 KB程度のbodyは巨大ではないが、model thinkingやschema-constrained decodingに必要な処理時間は別問題で、API本文/usageが無い本調査では内部要因を決められない。[GenerateContent API errors](https://ai.google.dev/gemini-api/docs/generate-content/api-errors)

## 原因候補の評価

### 確認済み事実

1. Gemini Developer APIからHTTP 504がSDKへ返り、Go API内で42,019msを計測した。Go APIは外部に502を返した。
2. Go側contextは45sで、504はそのdeadlineより約3秒前に到着。ローカルの`context.DeadlineExceeded`ではない。
3. SDKは推定45sのtimeoutをrequest headerへ通知する。これがGoogleの内部deadlineとして同じ境界に使われたかは未確認。
4. HTTP client全体timeoutやserver WriteTimeoutに42秒設定はない。明示proxyも確認しない。
5. Fixture / prompt / schemaは小さく、full Feature Timelineも送っていない。
6. HTTP retry無効。ただしautomatic continuationは既定trueであり、HTTP retryと区別が必要。今回の504ではcontinuation応答がないため作動しない。

### 合理的候補（未確定）

- **有力:** 45s local deadlineをSDK経由でGemini側へ通知したため、backendがdeadlineを守って約42秒で504を返した。SDKがこのtimeout headerを作ることとGoogleの504 deadline semanticsは確認できるが、Google側deadline enforcementの因果関係は未確認。
- **あり得る:** Gemini 3.8 Flashのdefault medium thinkingとstructured decodingが生成時間を押し上げ、deadline内に完了しなかった。公式資料はthinkingがlatencyを増やし得るとしているが、今回thoughts usageは取得できず寄与度不明。
- **可能性は低めだが排除不能:** schemaのnested arrays/boundsがgeneration latencyに影響。公式制約資料は複雑schemaを400 rejection原因として説明する。今回は504なのでschema rejectionの証拠なし。
- **外側の中継:** proxy environmentはunsetだが、transparent intermediaryやGoogle gateway内部のどの層が504を生成したかはheaders/bodyを保存しておらず不明。

## ローカル検証

- 既存mock tests: context deadlineはhandlerで504/`gemini_timeout`、HTTP transport failureは別分類、schema/promptはStructured Outputs/compact featureを検証。
- 追加test: `genai.APIError{Code:504}`は`gemini_upstream_5xx`とHTTP 502/`gemini_upstream_error`になる。SDK clientのHTTPClient.Timeout=0、HTTPOptions.Timeout=nil、HTTP retry=nilをofflineで確認。
- Goの`go test ./...`：成功。Goの`go vet ./...`：成功。gofmt／`git diff --check`：成功。
- Fixtureのbyte/depth集計用一時testは実行後削除。Gemini API request数: **0**。API key値、prompt本文、上流本文のログ保存なし。
- Echo server timeoutは採用版sourceで確認。約42秒のslow-client/read/write server testは行っていない。Echo設定上read timeoutはrequest受信30秒でwrite timeoutは0、Gemini wait用の専用server timeoutはないため追加integration testは不要と判断。

## 判断・次回検証案

今回、runtime timeout、SDK/model、schemaは変更不要。もっとも、45s local deadlineを約45sのSDK headerとして通知する設定は504に関与し得るため、次回、別途明示許可を得た単発試験では、同じfixture/model/prompt/schemaを保ったままhandler deadlineを十分延ばす比較が第一候補。併せて一回のSDK invocationを一回のwire requestに限定する要件なら`AutomaticContinuation=false`を明示する。thinking levelをlowにするのは独立変数で、品質とのtradeoffもあるため同じ試験で同時変更しない。

再試験は現状のFree Tierを改めて確認し、response/status/latency、Google request metadata、token usageが返る場合の記録を一回に限定する。なお、Go error loggerはstatus/classification/latency/modelのみ記録し、Google request IDやresponse headersは保持していない。必要なら次段階で、機密を避けたrequest IDなどの安全な診断項目追加を別途検討する。

## 変更ファイル

- `CURRENT_TASK.md`: Step 5.6cのread-only調査範囲に置換。
- `api/internal/service/http_test.go`: HTTP 504の分類/外部mappingとoffline SDK HTTP timeout構成の検証を追加。
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`: 45s deadline handoff、504原因候補、SDK continuationの補足を追記。
- 本報告書: timeout層、payload統計、公式仕様照合、推測境界、次回比較案を記録。

モデル/SDK/Schema/実行timeout/API key/課金/Cloud/Python Island/Frontend/Rendererは変更していない。
