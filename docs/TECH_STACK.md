# 技術構成と選定状況

DECIDED（Step 7i更新）：React/TypeScript/Vite、Canvas 2D、Go/Echo、Python/Demucs CPU、OpenAI Responses API（`gpt-6-luna`）、Supabase Auth/PostgreSQL、Cloud Run、Cloudflare Pages/R2、GitHub Actions。クラウドは実装済みではない。Gemini SDKはprovider移行で削除済み。

FACT（2026-10-31、WSL2で実測）：Node 24.22.2、npm 11.19.1、Linux x86_64。`.nvmrc`とfrontend/package.jsonで固定。npm registryへ接続成功。

FACT（frontend lock済み）：React/React DOM 19.3.1、TypeScript 6.0.3、Vite 8.3.5、@vitejs/plugin-react 6.1.2、Vitest 5.0.5、ESLint 10.14.0。npm ci、互換性条件、npm auditを確認。監査結果はreportsを参照。

導入・公式URL・未検証区分は[ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md)。同資料にあるnvm版も導入手順の候補であり、全依存の安全性監査完了を意味しない。

DECIDED：採用時に確認日・公式advisory・互換性・完全版番号・lock・検証結果を記録する。Demucsは元リポジトリがアーカイブ済みのため、PyTorch/torchaudioとの互換性と既知の脆弱性を別環境で評価する。

FACT（2026-10-31）：Python IslandでPython 3.14.10 / PyTorch 2.14.1+cpu / Demucs 4.1.0 / NumPy 2.3.4を固定。uv 0.8.12がuv.lock生成・環境同期を担当し、Python standaloneはAstral python-build-standalone 20261026からSHA256検証してworkspace内に導入する。依存の詳細は`python-island/pyproject.toml`と`uv.lock`。

FACT：FFmpegは実測版6.1.1-3ubuntu5（Ubuntu 24.04）。安全な採用版は確定していないため、セキュリティ上の未解決事項として管理。特徴量は10ms（100Hz）間隔。Frontendの必須フィールドと時間単位(ms)を維持し、プロジェクト/API共通schema決定前のPython分析schemaVersion 1として付加情報を提供する。

FACT（Step 5、2026-10-31）：`api/go.mod`はGo 1.27.0 / toolchain 1.27.3、Echo v5.4.2、Google Gen AI Go SDK `google.golang.org/genai` v1.77.0を固定。Go 1.27.3は公式リリース、Echo v5はGo 1.25以降を要件とする現行major。旧`github.com/google/generative-ai-go`ではなく公式SDKを選択。Geminiモデル候補は`gemini-3.8-flash`（Structured Outputs対応を公式モデル一覧で確認）だが、実リクエストは未実施。

公式根拠：[Go release history](https://go.dev/doc/devel/release)、[Echo v5.4.2](https://github.com/labstack/echo/releases/tag/v5.4.2)、[Google Gen AI Go SDK v1.77.0](https://github.com/googleapis/go-genai/releases/tag/v1.77.0)、[Structured Outputs](https://ai.google.dev/gemini-api/docs/structured-output)、[Gemini models](https://ai.google.dev/gemini-api/docs/models)。

FACT（Step 5.5）：Gemini 3.8 Flashの公式移行案内に合わせ、GenerateContent requestからtemperature/top_p/top_k等を省略。`go-genai` v1.77.0のresponseからprovider `ModelVersion`と`UsageMetadata`を取得し、API diagnosticsへ非機密項目として返す。利用量metadataは応答で欠落する場合がある。

FACT（Step 7i、2026-11-01）：Go API providerは標準`net/http`によるOpenAI Responses REST API。model allowlistは`gpt-6-luna`。公式Go SDKも存在するが、新依存追加を避けるため採用せず。strict Structured OutputsとGo validator、Mock testsを実装。OpenAI実APIは未試験。旧Gemini SDK依存はgo.mod/go.sumから削除。

公式根拠：[GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)、[Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[Input token counting](https://developers.openai.com/api/docs/guides/token-counting)、[API pricing](https://developers.openai.com/api/docs/pricing)、[OpenAI Go SDK](https://github.com/openai/openai-go)。
