# Step 5.6d Gemini Timeout調整・再検証準備

実施日: 2026-10-31（Asia/Tokyo）  
状態: **completed（ローカル設定・mock検証。Gemini実API送信0回）**

## 結果

Gemini生成用Context Deadlineを45秒から120秒へ変更し、Google Gen AI Go SDK v1.77.0のAutomatic Continuationを明示的に無効化した。main serverと`NewServer`のdefaultは`DefaultGeminiTimeout`定数を共有する。HTTP retryは従来どおり`RetryOptions=nil`で無効。

モデル`gemini-3.8-flash`、SDK v1.77.0、Prompt、Structured Outputs Schema、最大出力token数、Thinking設定、外部APIエラー形式、Blueprint validation、診断ログのサニタイズは変更していない。

## SDK設定根拠

採用済みSDKのローカルmodule source `google.golang.org/genai@v1.77.0`を確認した。

- `GenerateContentConfig.AutomaticContinuation *bool`が正式な設定field（`types.go`）。`genai.Ptr(false)`によりfalseを渡す。
- `Models.GenerateContent`は設定falseなら初回responseを返し、Continuation tokenがあっても次のGenerateContentを呼ばない（`models.go` / `continuation.go`）。未指定nilは有効扱い。
- SDKのHTTP request builderはcontext deadline残量を秒へceilして`x-server-timeout`へ設定する。API handlerは120秒のdeadline contextをGeneratorへ伝える。
- `HTTPRetryOptions=nil`ではHTTP retryは1回のみ。Continuationはretryとは別の複数request機能である。

参照したSDK v1.77.0 source: [types.go](https://github.com/googleapis/go-genai/blob/v1.77.0/types.go), [models.go](https://github.com/googleapis/go-genai/blob/v1.77.0/models.go), [continuation.go](https://github.com/googleapis/go-genai/blob/v1.77.0/continuation.go), [api_client.go](https://github.com/googleapis/go-genai/blob/v1.77.0/api_client.go)。

## 自動継続とBlueprintへの影響

Continuationを無効にしても、モデルが単一応答内でSchema適合JSONを完成すれば生成契約は変わらない。SDKが途中応答を自動連結する挙動だけを止める。途中終了でJSONが不完全な場合は、既存のGo Blueprint decoder/validatorが拒否し、APIは既存のサニタイズ済みinvalid-output応答となる。部分JSONを正常扱いするfallbackはない。

従って、明示無効化が通常の完全応答を不成立にする問題は確認していない。一方、途中応答からの自動回復を使わなくなるため、出力上限等で切れた場合は生成失敗として表面化する。現Schemaの最大要素数と7000 output token設定を維持し、ローカルmockで安全側の失敗経路を保つ設計とした。実モデルが通常のfixtureで一応答に収まるかは未確認であり、実API試験が必要。

## ローカル検証

新しい `api/internal/service/gemini_sdk_test.go` はネットワークlistenを使わず、SDK `HTTPClient`に偽RoundTripperを注入する。Geminiへの通信は発生しない。

- `DefaultGeminiTimeout == 120s`と、API handlerからGeneratorへ渡るdeadlineを確認。
- SDK mock requestの`x-server-timeout`が`120`であることを確認。
- wire payloadにJSON MIME typeと既存response JSON Schemaがあることを確認。
- mockが`finishReason=CONTINUATION`とtokenを返してもrequest数が1であることを確認。
- 503 mockでrequest数が1、分類が`gemini_upstream_5xx`であることを確認。
- 既存testでSDK HTTP retry nil、429/5xx/timeout分類、診断ログへの秘密情報非混入、外部エラーsanitize、Blueprint検証を回帰確認。

実行結果:

- `go test ./...`: passed
- `go vet ./...`: passed
- `gofmt`: changed Go files formatted
- `git diff --check`: passed
- Gemini実API request: **0**
- Frontend/Python test: 未実施（変更なし）

## 変更ファイル

- `api/internal/service/http.go`: 共通default timeoutを120秒に変更。
- `api/cmd/server/main.go`: 同じdefault timeout定数を明示利用。
- `api/internal/service/gemini.go`: `AutomaticContinuation=false`をStructured Outputs configに指定。
- `api/internal/service/http_test.go`: 120秒deadlineと明示falseのassertion。
- `api/internal/service/gemini_sdk_test.go`: header、wire request数、Schema payload、HTTP 503をoffline mock検証。
- `CURRENT_TASK.md`: Step 5.6dの作業契約。
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`: 設定・mock確認・実疎通保留を反映。
- 本報告書: SDK根拠、影響、テスト結果。

API keyの値は読み出し、出力、保存していない。Cloud、billing、dependency、model、Schema、Python Island、Frontend、Renderer、Git remoteには変更なし。

## 次回の実API検証

別途明示許可の後、Free Tier状態をその時点で確認し、12秒合成Music Summary/Feature fixtureで単一POSTを行う。120秒contextによりSDK headerも残り時間に応じて約120秒となる。HTTP retryとAutomatic Continuationはともに無効のため、生成endpointは一回のSDK呼出しで追加HTTP requestを行わない。応答status、latency、返却された場合のmodel ID/token usage、Go validation結果を記録する。失敗時は再送せず、次の許可を待つ。
