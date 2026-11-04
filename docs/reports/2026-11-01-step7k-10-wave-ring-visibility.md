# Step 7k-10 — Wave Ring offsetとEffect visibility

**状態：一部完了**

## 結果

Wave Ringの`layerCount`を1〜10に拡張しました。自動設定の`layerAngleOffsetDeg: 0`では、層ごとに`180/layerCount`度を使います。正の値では従来どおり手動指定の隣接層間隔です。同じoffsetがpath角度と周期的なsample phaseの両方をずらします。既存の単層Blueprintと手動offsetは変わりません。新規Wave Ringの既定値は4層です。renderer上限の10層・256 sampleの場合、Effectが評価するring pointは最大2,560点で、元sample列を再利用します。

15種類すべてのEffectが、任意の`visibilityMode`（`triggered`/`always`）と`audioReactive`（boolean）を受け付けます。項目がない場合は従来のTriggered + Reactiveとして扱います。Editorで新規作成するEffectと正規化後のAI EffectはAlways + Reactiveが既定です。Alwaysでは既存の基本geometryを低alpha floorで表示します。BurstとShockwaveはeventがないとき決定的なstatic baselineを使いますが、合成eventは作りません。Peak waveform EffectはAlways選択時にpeaksがなければ簡単なbaseline line/contourを描き、波形dataを合成しません。Audio Reactive OFFはAlwaysの場合だけ有効で、EditorはOFFにするとAlwaysへ切り替えます。Binding signalは抑制しますが、実peaksはclip開始時にstatic baselineとしてsampleされ、Continuous BPM rotationは続きます。

Blueprint v1、Feature Timeline v1、`.arvproj v1`、Cloud v1、7種類のAudio Source、Opacity、Gradient、Category → Type、Region clipping、BPM rotation、共有`renderEditorFrame`は維持します。OpenAI strict schemaとnormalizationを更新しましたが、OpenAI APIは呼び出していません。

## 変更ファイル

- `frontend/src/editor-model.ts`：visibility/reactivityの型と検証、層数範囲1〜10。
- `frontend/src/renderer.ts`：自動offset式、Always baseline、audio signal抑制、static peak mode、決定的なevent Effect baseline。
- `frontend/src/VisualEditor.tsx`：controls/既定値、無効な組み合わせの防止、層数制限、状態表示。
- `frontend/src/editor-renderer.test.ts`：offset geometry、10×256負荷、Always/no-event/missing-peak、reactive off、BPM共存。
- `frontend/src/visual-editor.test.tsx`：15種類を通じたcontrols、設定変更、Type変更時の保持。
- `frontend/src/cloud-project.test.ts`：Cloud v1が追加項目を保持すること。
- `api/internal/blueprint/blueprint.go`、`blueprint_test.go`：対応するenum/bool/pair検証と層数範囲。
- `api/internal/service/openai.go`、`openai_test.go`：strict property、AI既定値/prompt、schema検査。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/BLUEPRINT_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md`：互換性contractと検証記録。

## Test

- Frontend `npm test -- --run`：**109 test成功**。
- `npm run typecheck`、`npm run lint`、`npm run build`：成功。
- Go `go test ./internal/blueprint ./internal/projects`：成功。
- Go OpenAI schema/normalization/rotationの対象test：成功。
- Go `go vet ./...`、`git diff --check`：成功。

`go test ./...`も試しました。既存の`TestOpenAIResponsesRequestUsesStrictStructuredOutput`は、sandboxがIPv6 loopback listener（`listen tcp6 [::1]:0: operation not permitted`）を拒否して開始できませんでした。それ以前のpackageは完了しました。testを無効化/変更して回避していません。実ブラウザーが利用できず、実際の画質、preview/WebM frame比較、FPSは未検証です。

## 互換性と範囲

すべて任意項目としてBlueprint v1へ追加しました。version、Timeline、Project、Cloud、database、API persistence、dependency、Hosted環境は変更していません。旧BlueprintはTriggered + Reactive、Wave Ringは1層として扱います。既存rendererとexport経路は変更していません。

## 残課題

- IPv6 loopback bindを許可する環境でGo service全体のsuiteを実行する。
- 実ブラウザーで10層の合成、clip、WebM出力を確認する。

## Layer offsetの修正（2026-11-01）

報告された重なりは、`layerOffsetDeg`を逆の役割で二重に適用していたことが原因でした。rendererは`features[index + phaseOffset]`をsampleすると同時に、点を`baseAngle + layerOffsetDeg`へ配置していました。角度θのsample featureに両方のshiftをかけると、同じfeatureが元のworld angleへ戻ります。そのため、数値上はgeometry offsetがあっても、非対称contourがほぼ重なって見えていました。

修正後は、すべての層が同じ参照sample（`features[index]`）を評価し、共有BPM rotationとlayer offsetはCanvas座標角度にだけ適用します。radius step、振幅decay、smoothing、cyclic closure、opacity、gradient、clip、Binding sampleは変更していません。

非対称な単一sampleのdipを作り、`renderEditorFrame`とCatmull-Rom Canvas経路で描画して、最終path endpointからfeature位置を検出するregression testを追加しました。3/4/6/10層の自動offset、4層の45°間隔、手動13°間隔、BPM連続回転と初期角19°、smoothing、評価順が前後しても同じtimeなら同じ結果になること、共通Renderer経路を検証します。従来のphaseと座標の両offset実装ではtestが失敗します。

修正確認：`npm test -- --run src/editor-renderer.test.ts`成功（38 test）。全体確認では`npm test -- --run`（110 test）、`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check`が成功しました。schemaおよびRenderer以外の実装は変更していません。修正後の手動browser確認は、この環境ではできません。

## Step 7k-10b 角度と同心半径の修正

自動の隣接層stepは`360 / layerCount`になりました（3層：120°、4層：90°、6層：60°、10層：36°）。すべての層で同じ基準`radius`を使用します。共有sample列は層間で変更せず、BPM rotation、初期角、層ごとのoffsetを一度だけ描画Canvas座標に合成します。これによりphase cancellationを防ぎ、非対称波形peaksを指定どおり一周分ずらします。

`layerRadiusStep`はBlueprint v1で引き続き任意項目として受理・検証するため、旧Blueprintや`.arvproj`/Cloud v1 dataを読み込めます。Wave RingのEditorからはこの設定を削除し、rendererでも無視します。version、API、Timeline、OpenAI schemaの変更は不要でした。

更新testは、最終的にsmoothingしたCanvas path座標での120/90/60/36°、手動offset、初期角とBPM rotation、順序を変えた決定的評価、旧`layerRadiusStep`があっても同じ半径であること、obsoleteなradius controlをUIで隠すことを確認します。検証ではFrontend `npm test -- --run`（110 test）、`npm run typecheck`、`npm run lint`、`npm run build`、Blueprint/Project Go package test、Go Blueprint/OpenAI schemaとnormalizationの対象test、`go vet ./...`、`git diff --check`が成功しました。広範なGo service testのfilterでは、既存httptestが必要とするIPv6 loopback listenerをsandboxが拒否しました（`operation not permitted`）。listenerを使わないschema対象testは成功しました。実browserのpixel確認は未実施です。
