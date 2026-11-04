# Step 7k-11c — Particle Effectの改善

- **状態：** 一部完了

## 結果

`particles`はRegion内に複数particleを決定的に配置し、下部から上向きに動かすfieldを描画します。particleごとの横揺れ、size、glowは再現可能な形で変化します。音声応答に応じてparticle数、spread、上昇速度、明るさ、opacityを変えます。後続の7k-11c修正でTriggered + Audio Reactive ONに固定しました。旧データのAlways/non-reactive値は読み込めますが、Triggeredとして描画し、保存時に正規化します。

`particle-burst`は上向きに放出する代わりに円周全体へparticleを配置します。決定的な角度変化、event ordinalによる回転、lifetimeに基づくswirlを組み合わせます。音声応答に応じて数、速度/移動距離、spread、glowを増やします。Always modeでは、無音時に繰り返しburst eventを生成せず、薄いstatic baselineを表示できます。両Effectとも`renderEditorFrame`内で処理し、Region clipと既存の色/opacity解決を維持します。前frameの状態を使わず評価します。既存のcount検証によりEffectごとのparticle数は64以下で、event再構築はactive event 32件までです。

## 任意parameter

- `particles`：`spread` (0.1–1), `speedInfluence` (0–2), `glowIntensity` (0–2), `baselineOpacity` (0–0.35).
- `particle-burst`：`swirl` (-2–2), `audioInfluence` (0–2), `baselineOpacity` (0–0.35).

EditorとAI normalizationでは同じ既定値を使います。既存fieldとEffect kind名は変わりません。

## 互換性

Blueprint v1、`.arvproj v1`、Cloud Envelope v1、Project v1、Timeline v1、7種類すべてのaudio source、Global Gradient/Custom Color、opacity、visibility、Audio Reactive、Region、描画順を維持します。新fieldは任意で、旧dataも有効です。Python Island、Timeline、API/DB/Auth、dependencyは変更していません。OpenAI Structured Output schemaとpromptは更新しましたが、OpenAI API requestは行っていません。

## 変更ファイル

- `frontend/src/editor-model.ts`：任意parameter型と厳密な範囲/未知field検証。
- `frontend/src/renderer.ts`：上昇fieldとradial/swirl burst描画、決定的で上限付きの評価、visibility/audio-reactive処理。
- `frontend/src/VisualEditor.tsx`：対応する既定値、範囲内の編集、parameter controls。
- `frontend/src/editor-renderer.test.ts`：particle分布、response、visibility、source変換、seekの決定性を検証。
- `frontend/src/visual-editor.test.tsx`：Editor controlsを検証。
- `frontend/src/project-file.test.ts`、`frontend/src/cloud-project.test.ts`：v1 roundtripを検証。
- `api/internal/blueprint/blueprint.go`、`blueprint_test.go`：Go field allowlistと検証test。
- `api/internal/service/openai.go`、`openai_test.go`：strict schema、prompt、normalization既定値。
- `api/internal/projects/document_test.go`：Project/Cloud v1受け入れ確認。
- `CURRENT_TASK.md`と`docs/{CURRENT_STATE,OPEN_ISSUES,BLUEPRINT_SPEC,ARCHITECTURE,TEST_STRATEGY,VISUAL_EFFECT_ROADMAP}.md`：現状、contract、architecture、検証、手動視覚確認の残り。

## Test

- `npm test -- --run`：11 file、118 test成功。
- `npm run typecheck`：成功。
- `npm run lint`：成功。
- `npm run build`：成功。
- `go test ./internal/blueprint ./internal/projects`：成功。
- `go test ./internal/service -run 'Test(OpenAINormalizesEnhancedParticleDefaults|StructuredOutputSchema.*Particle)'`: passed.
- `go vet ./...`：成功。
- `git diff --check`：成功。

A full `go test` of `internal/service` was attempted, but an existing `httptest.NewServer` test cannot bind IPv6 loopback (`listen tcp6 [::1]:0: socket: operation not permitted`) in this sandbox. The relevant normalization test passed separately. testの削除や無効化はしていません。

## 残課題

実browser pixelの品質、Preview/WebM再生、複数particle Effect同時実行時のFPSは視覚計測していません。browserでの手動受け入れが残っています。service test package全体はsandboxのIPv6 loopback bind制限を受けます。

## 修正：Particlesの分布（Step 7k-11c follow-up）

### 原因

従来の無音時spreadは`configuredSpread * (0.24 + response * 0.76)`で算出していました。responseが0の場合、設定された0.78〜0.92幅はRegion幅の約19〜22%まで縮みました。また、X/Y変化に同じlinear congruential generator列の隣接seedを使っていたため、2軸が相関し、狭く固まって見えるfieldになっていました。従来baselineは設定countの約24%にとどまり、baseline opacityの既定値は0.14でした。

### 修正内容

- 無音時もRegion全体に設定spreadを適用し、responseに応じて最大幅へ広げます。
- indexごとに層化した水平slotを使い、黄金比数列に基づく独立した決定的垂直phaseと、別hashから得るjitterを組み合わせます。
- 設定countを上限として維持します。Always時のcountは設定値の36%から始まり、responseに応じて全数まで増えます。
- 新規/既定Always baseline opacityを0.14から0.26に上げ、size/glow分布を見やすくします。`opacity: 0`を含むユーザー指定値は引き続き反映します。
- renderer command/clip/gradient/opacity経路は維持します。schema、version、Binding、Burst、Timelineは変更しません。

### 座標とCanvasの検証

For the Stage Region (640×360 canvas; Region width 486.4 px), at configured count 64:

| Evaluation | Draw commands | Unique X / XY | X range | Region width | Maximum particles within 12×12 px | Alpha-visible |
|---|---:|---:|---:|---:|---:|---:|
| Always, silent, time 0 | 24 | 24 / 24 | 422.1 px | 486.4 px | 1 | 24 |
| Always, full response, time 200 ms | 64 | 64 / 64 | 475.5 px | 486.4 px | 1 | 64 |

Renderer tests also record each command's index, spawn/render coordinates, size, alpha, and phase; verify vertical movement, Audio Reactive OFF static positions, Always/Triggered behavior, polygon clipping, opacity/glow, continuous response scaling, seek determinism, and actual Canvas `ellipse` calls. Particle Burst regression tests remain passing.

### 検証結果と受け入れ上の制約

`npm test -- --run` (118 tests), `npm run typecheck`, `npm run lint`, `npm run build`, and `git diff --check` passed. Browser executables and Playwright are not installed in this environment, so rasterized pixels and real Preview/WebM appearance remain unconfirmed. Canvas command上の自動分布検証は完了していますが、人による視覚受け入れ確認が必要です。

## 追加調整：particle count上限の統一（Step 7k-11c）

従来の上限が不統一でした。`particles`はFrontend/GoとUIで200、`particle-burst`は32、OpenAI strict schemaで共通`count`は200を許可していました。共通範囲を**1〜64**に変更しました。

- 両kindのEditor number inputは1〜64を受け付け、整数へ丸めます。
- FrontendとGoのBlueprint validatorは両kindで1/32/64を受け付け、65を拒否します。
- OpenAI strict schemaの`count`上限は64です。API callは行っていません。
- rendererは`particles` fieldごとに64を上限とします。`particle-burst`は指定countと重複event全体で生存中のparticle合計を、Effectごとに64以下にします。Core flash commandは別の視覚layerとして維持します。
- 両kindで1/32/64、65の拒否、重複eventの合計上限を検証するrenderer testを追加しました。`.arvproj v1`、Cloud Envelope v1、Go Project/Cloud test fixtureをcount 64のroundtripに更新しました。

version、Timeline、API、DB/Auth、Python、dependency、Binding、Audio Source、gradient、opacity、particle移動/Burst分布は変更していません。 Full frontend tests/typecheck/lint/build, Go Blueprint/Project tests, targeted OpenAI schema/normalization tests, `go vet ./...`, and `git diff --check` passed. Details are in the current task changes and tests; real browser inspection was not part of this L1 limit adjustment.

count上限調整の検証： `npm test -- --run` passed (119 tests / 11 files), `npm run typecheck`, `npm run lint`, `npm run build`; `go test ./internal/blueprint ./internal/projects`, targeted OpenAI schema/normalization tests, `go vet ./...`, and `git diff --check` passed.

## 追加修正：ParticlesをTriggered専用に変更

`particles`の有効modeを`visibilityMode=triggered`、`audioReactive=true`に固定しました。Editorは設定を固定表示し、Particles追加時や他EffectからParticlesへのType変更時に両値を適用します。Particles parameterを編集した場合も正規化します。rendererは旧`always`と`audioReactive=false` flagを無視し、既存Bindingを評価してresponseが0ならcommandを出しません。既存のcontinuous/Event source変換、決定的な移動、count、spread、色、opacity、Region clipを引き続き使います。追加のtrigger detectorはありません。Particle Burstとその他Effectのvisibility経路は変更していません。

`particles + always`を含む旧Blueprint、`.arvproj v1`、Cloud/Project v1 documentは有効なまま読み込め、読み込み時に変更されません。Frontendの`.arvproj`またはCloud envelope serializerで保存すると、ParticlesだけをTriggered/Reactive ONに書き換えます。OpenAI normalizerも生成Particlesへ同じ値を強制します。strict schema enumは共通のまま変更していません。Go validationは有効な旧`always + audioReactive=false`組み合わせを引き続き受理し、Particles以外には既存のcross-field ruleを適用します。version変更やOpenAI requestはありません。

testでは無音/threshold未満の描画、7種類すべてのsourceからのactive response、64 particle上限、任意seek、旧AlwaysをTriggeredとして描画すること、Editor control固定、`.arvproj`旧形式の読込と正規化後の再保存、Cloud旧形式のhydrateと正規化後の再保存、OpenAI normalization、既存Particle Burst/その他EffectのAlways回帰を確認しました。

Triggered専用化の修正確認： `npm test -- --run` passed (123 tests / 11 files); `npm run typecheck`, `npm run lint`, and `npm run build` passed. `go test ./internal/blueprint ./internal/projects`, targeted OpenAI normalization/schema tests, `go vet ./...`, and `git diff --check` passed.
