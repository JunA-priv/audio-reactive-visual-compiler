# Step 5：Go/Echo APIとGemini Blueprint生成

確認日：2026-10-31（Asia/Tokyo）  
状態：**完了（ローカル実装、mock／fixture検証）**

## 対象と根拠の分類

`CURRENT_TASK.md`に記載したローカルAPIと、Visual Editorへの最小限の受け渡し機能を実装した。cloud resource、認証、database、job queue、model weight、FFmpeg、Python algorithm、本番deploy、GitHub pushは変更していない。Geminiへの実requestは行っていない。Python Islandのファイルは変更していないため、Python回帰テストは再実行していない。

**一次資料で確認した事項：** Go 1.27.3は公式release。Echo v5.4.2を採用し、v5はGo 1.25以降を要件とする。`google.golang.org/genai`はGoogleが保守する公式Go SDKであり、v1.77.0を採用した。Googleの資料では`gemini-3.8-flash`はstableでStructured Outputsに対応している。GeminiのJSON Schema対応はsubsetに限られるため、アプリケーション側で意味的なvalidationが必要。[Go releases](https://go.dev/doc/devel/release)、[Echo v5.4.2](https://github.com/labstack/echo/releases/tag/v5.4.2)、[Echo](https://github.com/labstack/echo)、[Google Gen AI Go SDK](https://github.com/googleapis/go-genai/releases/tag/v1.77.0)、[Gemini models](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)、[Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output)を参照。

**実装上の事実：** `api/go.mod`ではGo 1.27.0／toolchain 1.27.3、Echo v5.4.2、Gen AI Go SDK v1.77.0を固定する。既定のmodel候補は`gemini-3.8-flash`。SDK経路は`application/json`と`ResponseJsonSchema`を使い、retryは有効化していない。provider callにはdeadlineがあり、provider失敗は機密情報を除去したAPI errorへ変換する。

**解釈／未確認事項：** model対応とStructured Output設定は公式資料とcodeで確認したが、実requestは行っていない。アカウント利用可否、実際の応答品質、現在のアカウント固有quota／free tier、billingは未検証。実request前に料金とquotaを再確認する必要がある。model licensing／outputと公開・商用serviceへの適合性は法的評価を受けていない。

## API契約

- `GET /healthz` → `200 {"status":"ok"}`。
- `POST /api/v1/blueprints/generate`はJSON`{ "musicSummary": ..., "featureTimeline": ..., "visualIntent"?: "..." }`を受け、`{ "blueprint": <EditorBlueprint v1>, "mode": "fixture"|"gemini", "model"?: "..." }`を返す。
- errorは`{ "error": { "code": "...", "message": "..." } }`形式。不正JSON／shapeと上限超過requestは拒否する。provider timeoutは504、key未設定は503、不正provider output／provider failureはsanitize後に502または適切なstatusへ対応する。429／5xxは成功として扱わず、無制限retryもしない。
- `BLUEPRINT_MODE`の既定値は`fixture`。`gemini`を明示した場合のみ外部requestを有効化する。keyはサーバー側のみの`GEMINI_API_KEY`を使い、`GOOGLE_API_KEY`へfallbackする。`GEMINI_MODEL`は任意。既定候補は`gemini-3.8-flash`。serverは`127.0.0.1:8080`でlistenする。
- Summary／Timelineの必須項目、対応schema／version／time unit、duration一致、有限値・範囲、時刻順、要素数を検証する。request上限は2 MiB。Timeline上限はBass sample 50,000個、Kick event 20,000個。
- Timeline全体はローカルに保持する。promptにはmetadata／summaryとcompactなfeature統計を使い、sampleするBass値とKick値は各最大64個。音源、stem、画像は送信しない。生成可能な背景はsolid／gradientのみ。

## Blueprint生成と独立validation

正本の契約は`frontend/src/editor-model.ts`のEditorBlueprint v1であり、Renderer codeは変更していない。Gemini Structured Outputsでは、対応するJSON Schema機能を使ってJSON shapeを制約する。その後API側でJSONを独立してdecode／validateし、必須／未知field、schema version、対応Effect／Binding type、parameter／value range、正規化geometry、要素数上限、ID一意性、EffectとBinding／Regionの参照を確認する。Geminiのschema subsetでは完全に表せない規則も含む。不正または非対応のoutputは拒否し、検証済みBlueprintのみ返す。

Frontendはfixture Summaryと現在の固定Timelineを送信し、既存の`validateBlueprint`で応答を検証してから編集可能なstateへ取り込む。固定Timeline previewも引き続き利用できる。既存の決定論的評価は不変であり、Geminiは実行可能codeを出力せず、frame描画にも関与しない。

## 変更ファイル

- `CURRENT_TASK.md`：Step 5の対象、制約、判断、完了／停止条件、報告契約に置き換え。
- `api/go.mod`、`api/go.sum`、`api/cmd/server/main.go`、`api/internal/blueprint/*`、`api/internal/service/*`、`api/testdata/*`：ローカルEcho API、input契約、validation、Fixture／Gemini provider、test、固定fixture。
- `frontend/src/VisualEditor.tsx`、`frontend/src/visual-editor.test.tsx`、`frontend/vite.config.ts`：最小限のAPI取込UI、test、loopback dev proxy。
- `docs/ARCHITECTURE.md`、`docs/BLUEPRINT_SPEC.md`、`docs/TECH_STACK.md`、`docs/ENVIRONMENT_SETUP.md`、`docs/TEST_STRATEGY.md`、`docs/SECURITY.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`：Step 5の決定、実行方法、未解決事項に関する必要な更新。
- 本報告書。

## 検証

- Go：変更したGo fileの`gofmt`、`go test ./...`（`internal/blueprint`、`internal/service`）成功。`go vet ./...`成功。
- Frontend：`npm test -- --run`は3 file／15 test成功。`npm run typecheck`、`npm run lint`、`npm run build`成功。
- Fixtureによるlocal HTTP smoke：`GET /healthz`は200。不正／不足requestはstructured 422。妥当な固定Summary＋Timelineは200で`mode=fixture`と妥当なEditorBlueprintを返した。確認後にAPI serverを停止。
- Gemini providerのmock testはrequest schema／configuration、timeout、429／5xx、不正JSON／schema output、sanitize済みerrorを確認。Geminiを呼ばずにAPI key未設定動作も確認。
- Gemini実APIへのrequest：要件に従い**未実施**。したがって実認証、現時点のquota／料金、provider互換性と品質は未確認。
- Rendererの決定論性は既存testで確認済み。Renderer実装は変更していない。Python Island codeは未変更のためPython testは再実行していない。

## 未解決事項・引き継ぎ

1. Gemini実request前に公式model料金とアカウントquota／free tierを確認し、送信するSummary／feature payloadの実体とkey管理を確認したうえで、明示許可を得る。本作業ではrequestを行っていない。
2. Project全体の正式なBlueprint/API schemaとversioningを決める。現endpointはローカルEditor Blueprint v1とPython Timeline v1に意図的に合わせている。
3. 認証、公開deploy、永続化、rate limit、abuse対策は対象外。loopback開発APIを公開serviceとして外部公開しない。
4. 既存のFFmpeg securityと音源分離weight licensing課題は`OPEN_ISSUES.md`のまま維持する。プロジェクト制約によりDemucsの公開／商用処理と、信頼できない第三者音源の処理は引き続き禁止。

禁止された外部call、model download、system update、cloud変更、Python algorithm変更、GitHub pushは実施していない。
