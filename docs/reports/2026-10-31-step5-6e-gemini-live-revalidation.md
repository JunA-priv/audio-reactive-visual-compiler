# Step 5.6e/f Gemini実API再検証

実施日: 2026-10-31（Asia/Tokyo）  
再開結果: **partial（Gemini upstream HTTP 503。Blueprint未取得。再送なし）**

## 結果

Step 5.6e再開では、`.env`をsourceしただけでGo processへkeyをexportしなかったため、local POST 1回がHTTP 503 `gemini_not_configured`で終わった。Gemini upstream requestは0回で、その試験内では再送しなかった。

Step 5.6fでは、ユーザーが対象ProjectのFree TierをAI Studioで確認済みという前提で、新たな最大1回のrequestを許可した。`.env`のkey設定は値を表示せず非空のみ確認した。`run-local.sh`経由でGo APIをloopback起動し、既存の12秒合成fixtureによるPOSTを**1回**実施した。Google Gemini APIからHTTP 503が返り、Go APIはサニタイズ済みHTTP 502 / `gemini_upstream_error`を返した。

安全な診断ログ:

```text
event=gemini_generation_failed
classification=gemini_upstream_5xx
latency_ms=1216
model=gemini-3.8-flash
upstream_http_status=503
```

curlで計測したlocal API total timeは1.246658秒。SDKはresponseをHTTP 503として分類した。Free Tier条件やAPI key認証エラーとは異なるstatusを受信しているが、SDKが上流本文をAPI/logへ露出しないため、503の詳細原因（Google側の一時的障害、サービス過負荷、経路など）は特定できない。追加requestを行わないため再確認もしない。

**Gemini実API request数: 1。** Automatic ContinuationとHTTP Retryは無効のまま。再送なし。

## 実行環境・key取扱い

- 対象ProjectのFree Tier確認: ユーザー確認済みとして扱った。課金/Cloud設定変更なし。
- `.env`のAPI key: 変数が非空であることのみ確認。値は表示、記録、報告書保存していない。
- `.env`の`BLUEPRINT_MODE=fixture`、model `gemini-3.8-flash`は維持。
- Step 5.6eの原因対応として`api/run-local.sh`を最小変更し、起動時に明示された`BLUEPRINT_MODE`を`.env`読み込み後も維持するようにした。dotenvの他の値は従来どおり`set -a`で子processへexportする。
- mock `go` executableを用いたrun-local検証は`mode=gemini`, model正当, `key_exported=true`を確認。実API試験前にも同じexport挙動をbooleanのみで確認。
- Go mainは`GEMINI_API_KEY`があればそれを明示configへ渡し、空なら`GOOGLE_API_KEY`へfallbackする。SDK v1.77.0は両環境変数設定時に警告文（変数名のみ）を出すが、SDK source上、明示config `APIKey`が非空ならenvironment keyで上書きしない。API key値は警告・Go API log・外部応答に含まれていない。

## Blueprint / Visual Editor結果

- API入力: 648 bytesの合成Music Summary、Feature Timeline、固定visual intentのみ。音源、Stem、画像、個人情報なし。
- 応答JSON: `{"error":{"code":"gemini_upstream_error","message":"Gemini request failed"}}`。上流response本文やtoken usageなし。
- Model: request設定は`gemini-3.8-flash`。provider response model IDは取得なし。
- Go Blueprint Validation: 未到達（Blueprintなし）。
- token usage: 取得なし。
- Visual Editor import / renderer validation: 未実施。互換性確認には生成Blueprintがない。
- 既存コード経路上、Goは成功時にEditorBlueprint v1 validationを通し、Frontendは`blueprint`値を`validateBlueprint`に通してstateへ取り込みrendererへ渡す。今回はその成功経路は確認できていない。

## 検証

- `go test -count=1 ./...`: passed
- `go vet ./...`: passed
- `bash -n api/run-local.sh`: passed
- run-local mock launch: mode overrideとkey export boolean passed
- `.env` Fixture default不変、key configured boolean true
- Frontend regression (Step 5.6e再開時): 3 files / 15 tests、typecheck、lint、build passed。fではFrontend files unchanged。
- `git diff --check`: passed

Go testsはmock/fixtureで実Geminiへ接続しない。実API試験後のRetry/Continuation request数は0。

## 変更ファイル

- `api/run-local.sh`: `.env`のFixture defaultを保持しつつ、明示されたprocess-only `BLUEPRINT_MODE` overrideを優先する。
- `CURRENT_TASK.md`: Step 5.6fの作業範囲に更新。
- `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`: 上流503、実request count、原因分類、再試験条件を反映。
- 本報告書: Step 5.6e初回のenv export漏れとStep 5.6fの実結果を併記。

API implementation、model、SDK、Prompt、Schema、Thinking、`.env`、dependency、Python Island、Demucs、FFmpeg、Frontend、課金設定、Cloud、GitHub remoteは変更なし。秘密値、prompt、upstream bodyは保存していない。試験API processは終了済み。

## 次の対応

今回の許可枠は使用済み。Gemini APIは1回だけ呼び出し、上流503を受けて終了したため、自動Retry・manual retryとも行わない。別の実API検証は新しい明示許可が必要。再実行前にGoogleのサービス状態/Free Tier状態を確認し、同じ合成fixture、model、schema、120秒deadline、retry無効、continuation無効で一度だけ試す。503の内部原因はresponse本文を保存していないため未解明。
