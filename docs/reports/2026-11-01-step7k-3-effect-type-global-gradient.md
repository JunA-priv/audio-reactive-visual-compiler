# Step 7k-3 — Effect Type変更と共通グラデーション

状態：partial（実装と利用可能な自動検証は完了。Go全suiteはsandboxのloopback socket制限によりservice HTTP mock testが停止。実ブラウザ画素評価は未実施。）

## 実装

- Editorに選択中EffectのType変更UIを追加。12種すべてを選択でき、Effect固有parameterはAdd Effectと同じ`newEffect`で再構築する。Effect ID、Region、Effect配列の描画順を維持し、Binding record/ID/settingsも保持する。sourceが互換なら維持し、Event-only/Continuous-onlyに対する不適合sourceのみそれぞれ`kick.events`/`bass.envelope`へ切り替える。
- Blueprint v1にoptional `globalGradient`（start/middle/end HEX、angleDeg）とEffect optional `colorMode`（`global-gradient` / `custom`）を追加。初期色は`#22d3ee` → `#8b5cf6` → `#ec4899`。global mode未指定のpaletteはこのdefaultへ解決する。
- `colorMode`欠落は既存Blueprintの明示colorを使うlegacy customとして扱う。既存Projectを読み込んだだけではmodeを補完しないため従来の見た目を維持する。新規Effectはglobal gradientを使う。個別色入力はcustomへ切り替え、global modeでは無効化。
- 各Effect draw commandに解決済みgradientを渡す。Canvas全体を座標系にして3 stopのCanvasGradientをfill/strokeへ適用し、Glow shadowはCanvas APIの制約に合わせ中間色を利用する。既存Region clip、配列順、Canvas 2D、`renderEditorFrame`を維持し、Preview/WebMで同じ経路を利用する。
- Frontend/Go validatorsとOpenAI Structured Output schemaを同期。OpenAI nullable optional出力は通常検証前にdefault palette/global modeへ正規化する。Blueprint v1、`.arvproj v1`、Cloud Envelope/Project v1のversionは変更しない。

## 変更ファイル

- `frontend/src/editor-model.ts`: optional color contract、defaults、HEX/range/mode validation。
- `frontend/src/VisualEditor.tsx`: in-place type switch、Binding compatibility維持、palette/color UI。
- `frontend/src/renderer.ts`: draw commandへのGradient伝搬、CanvasGradient作成/適用。
- `frontend/src/editor-renderer.test.ts`: opt-in gradientとcustom colorの描画命令回帰。
- `frontend/src/visual-editor.test.tsx`, `frontend/src/project-file.test.ts`: 12種Type切替/Binding source compatibilityとProject v1カラー設定往復。
- `api/internal/blueprint/blueprint.go`, `api/internal/blueprint/blueprint_test.go`: Go contract validatorとlegacy/invalid値テスト。
- `api/internal/service/openai.go`, `api/internal/service/openai_test.go`: strict schemaと出力正規化。
- `docs/BLUEPRINT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/API_CONTRACTS.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `CURRENT_TASK.md`: contract/current status。

## 検証

- Frontend: Vitest 80 tests passed; typecheck, lint, production build passed.
- Go: Blueprint and Project package tests passed; OpenAI schema tests passed; `go vet ./...` passed.
- `go test ./...`: all packages before `internal/service` passed; `TestOpenAIResponsesRequestUsesStrictStructuredOutput` cannot start `httptest.NewServer` because sandbox denies IPv6 loopback bind (`operation not permitted`). No OpenAI API was called.
- `git diff --check`: recorded at final review.

## 互換性と残存事項

既存のcolorMode/globalGradient欠落Blueprintは従来のEffect.color描画を維持する。JSON version、Project container version、Cloud document version、Renderer共通経路に変更なし。ブラウザ実画素のgradient direction/色品質、実WebMフレーム比較、UIで12種を一つずつ手操作する目視確認は未実施。Glow shadow itself uses middle stop as a solid Canvas shadow color; actual Effect fill/stroke still uses the full gradient.
