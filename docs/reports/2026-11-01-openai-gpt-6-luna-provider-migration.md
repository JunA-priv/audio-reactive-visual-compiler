# Step 7i — OpenAI GPT-6 Luna provider migration

実施日：2026-11-01

## 結果

**当時のstatus: partial** — Provider実装とローカルMock検証は完了。実OpenAI応答は未検証であり、報告作成時点でMigration 018は未適用だった。この履歴状態はStep 7i-1の追記を参照。

## 変更内容

- Go APIの実providerをGemini SDKからOpenAI Responses REST APIへ置換。Go標準`net/http`を使用し、新規SDK依存を追加しない。
- model allowlist/defaultは`gpt-6-luna`。`OPENAI_API_KEY`のみをサーバーで利用し、旧Google key fallbackは削除。Fixtureが既定modeで、OpenAI実APIへは接続しない。
- `/v1/responses/input_tokens`で同じpromptとStructured Output formatの入力token数を取得して予約上限を照合後、`/v1/responses`を一度だけ呼ぶ。SDK/HTTP自動retryなし。API handlerの120秒Contextを両要求へ伝播する。
- `text.format`に`json_schema`, `strict: true`を指定。既存Blueprint schemaをOpenAI strict subset（全property required、optionalはnullable、additionalProperties false）へ変換。nullable値は受信後除去し、既存Go validatorでvariant固有必須項目、effect/binding/region参照、数値範囲を最終検証する。
- Effect enumは既存11種類（5基礎 + Radial Bars / Wave Ring / Particle Burst / Particle Trail / Ripple / Shockwave）を使用。Blueprint v1 / Renderer / Timeline / Gemini風の実フォールバック経路は変更しない。
- refusal、incomplete、invalid JSON、HTTP 4xx/429/5xx、deadline/transport failureを区別し、上流本文・key・promptをログ/API応答へ出さない。未知または欠落usageは`usage_unknown`として予約上限を保持する。
- OpenAI `input_tokens`と`output_tokens`を既存usage応答のprompt/candidate欄に割当。`output_tokens_details.reasoning_tokens`は診断用thoughts欄に入るが、output料金計算はreasoningを含むoutput_tokens全体を使う。成功後はMigration RPCが予約時にsnapshotした単価で精算する。
- Fixture / local developer exemptionは従来どおりFixture mode限定。OpenAI modeには拡張しない。

## 価格・Migration

OpenAI公式pricing page（Standard tier、2026-11-01確認表示）ではGPT-6 Lunaがinput **$0.10 / 1M tokens**、output **$0.50 / 1M tokens**。DB単位のmicro-USD per millionへは100,000 / 500,000。既存上限8,000 input + 4,000 outputの最大予約費用は`(8000*100000 + 4000*500000)/1,000,000 = 2,800 micro-USD ($0.0028)`。既存service budget $1.50/月、回数・token・並列上限は維持。

追加Migration `20261101001800_openai_gpt6_luna_budget_pricing.sql`は、`ai_budget_control`の単一許可model制約と現在の価格snapshotだけを変更する。過去usage行の価格snapshotは変更しない。**この報告の作成時点ではMigrationは作成のみで、未適用だった。**その後のlocal適用はStep 7i-1追記を参照。Provider-side spend cap / account billing stateは調査・変更していない。

料金参照：[OpenAI API Pricing](https://developers.openai.com/api/docs/pricing)。公開ページは動的で、契約/Tier、batch/cached usage等で価格が異なる可能性がある。本実装のrateはStandard uncached input/output前提であり、¥1,000上限や実請求を保証しない。

## API仕様照合

- Model reference: [`gpt-6-luna`](https://developers.openai.com/api/docs/models/gpt-6-luna)
- Responses create: [API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
- Strict Structured Outputs: [guide](https://developers.openai.com/api/docs/guides/structured-outputs)
- Input token count: [guide](https://developers.openai.com/api/docs/guides/token-counting)
- API rate/spend limits: [rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- Official Go SDK exists ([openai/openai-go](https://github.com/openai/openai-go)); stdlib REST was chosen to avoid dependency churn. Current repo Go toolchain is 1.27.3.

Responses output is parsed by status and typed output content; incomplete and refusal are not treated as success. Provider error bodies are discarded. The same request Context bounds both input token-count and generation calls; this means the two sequential calls share the existing 120s deadline. Cancellation does not guarantee provider-side work termination once accepted; ambiguous usage remains charged against reservation until operator recovery.

## 検証

- Go `go test -count=1 ./...`: 成功（httptest mock。外部接続なし）。
- Go `go vet ./...`: 成功。
- Frontend: 58 tests, typecheck, lint, build successful.
- Mock coverage: Responses request/model/output limit/reasoning config/strict schema; input token count request; nullable output normalization; refusal/incomplete/invalid JSON; 400/401/403/404/429/5xx; timeout; no retry; usage mapping; sanitized API/log errors; JWT/entitlement/quota/kill switch and local Fixture exemption.
- `git diff --check`: implementation complete, final check performed at report preparation.
- No OpenAI API call, key readout, billing change, hosted request, DB migration application, or push.

## 未解決・残存事項

1. GPT-6 Luna model/account availability, actual schema acceptance, real usage metadata and latency are not live-tested by design.
2. 実APIは未検証。Migration 018のlocal適用済み状態はStep 7i-1報告を参照。Hosted DBは未適用。
3. OpenAI project hard spend cap, API key project restriction, account access policy, and production secret storage remain operator/Hosted deployment work. Budget DB limit is app-side admission control, not invoice hard cap.
4. Current token count preflight and generation are two provider HTTP requests; only generation is billable generation work, but API behavior/availability should be confirmed before any authorized live test. No automatic retry.
5. Provider pricing can change; update the rate and `pricing_version` only through a reviewed additive migration, preserving historical snapshots.

## 変更ファイル

Go provider/config/tests, `api/go.mod`/`go.sum`, `.env.example`, current API/architecture/security/stack/cost/environment/test docs, `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, and additive Migration 018. No Frontend behavior, DB state, auth/RLS, Blueprint contract, or Renderer changed.

## Step 7i-1追記（2026-11-01）

Migration 018は別途許可を受け、接続先をloopback-onlyと確認した既存local Supabaseへ適用済み。Hosted環境には接続・適用していない。適用順序の修正、適用前後のデータ・権限確認、Fixture/API・回帰検証は[Step 7i-1報告](2026-11-01-step7i-1-openai-budget-migration.md)を参照。OpenAI実APIは引き続き未呼出し。
