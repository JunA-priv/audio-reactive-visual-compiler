# Step 7k-11i — Ink Flow / Color Mixing

- 状態：一部完了

## 結果

UIから導出する`Ambient / Atmospheric` categoryに、独立したEffect kindとして`ink-flow`と`color-mixing`を追加しました。既存の`ink-diffusion`も引き続き選択できます。Editorでは全20 Effect kindをそれぞれ一度だけ分類します。CategoryはEffect kindから導出され、serializationされません。

3種類のInk Effectは、それぞれ独立したEffect ID、Region ID、Binding、visibility/reactivity設定、color mode、opacityを持ちます。新規Flow/Mixing Effectの既定値は`music.energy`、Always visibility、Audio Reactive ONです。既存の6つの任意Ink parameterを再利用し、Effectごとに異なるEditor/AI-normalization既定値を設定します。

| Kind | Speed | Flow | Turbulence | Density | Scale | Response |
|---|---:|---:|---:|---:|---:|---:|
| ink-flow | 0.45 | 0.95 | 0.65 | 0.5 | 0.65 | 3s |
| color-mixing | 0.25 | 0.5 | 0.55 | 0.65 | 0.9 | 4s |

## 描画

既存のInk WebGL2 program/context、Region sizeの透明surface、Canvas2D合成、Polygon clip、fallback経路を再利用します。mode uniformで視覚fieldを選びます。

- `ink-diffusion`はStep 7k-11jの局所density mask、threshold、非線形alpha、premultiplied outputを引き続き使用します。densityとoutput-alpha計算はそのままです。
- `ink-flow`は複数の曲線stream ridgeと移動vortex/noise fieldを強調します。Canvas fallbackでは決定的な曲線stroke pathを使います。
- `color-mixing`は移動するpigment source 4つからdensityを求め、各sourceの空間寄与に応じて既存Global Gradient paletteを重み付けします。Custom Colorでは単色density fieldを維持し、Canvas fallbackは決定的な輪郭を重ねます。

各Effectはblueprint順に個別commandとして描画するため、1つのRegionに重ねてもBinding/opacity stateを共有しません。絶対timestamp、Timeline response、seed、Effect IDで出力が決まり、前frameのfluid stateは追加していません。PreviewとWebMは引き続き`renderEditorFrame`を通ります。

## Contractと互換性

Frontend/Go validatorは追加された2 kindを受理し、既存Ink parameter範囲を検証します。OpenAI Structured Output kind enum、prompt案内、normalization既定値を揃えました。OpenAI API callは行っていません。Project-file/Cloud-envelope roundtrip testではcategory fieldを含めず新kindを検証します。Blueprint、Feature Timeline、`.arvproj`、Project Document、Cloud Envelopeは引き続きv1です。dependency追加、Timeline feature、Python Island変更、DB/Auth/API migration、Hosted操作、pushは行っていません。

## Test

- `npm test -- --run`：12 file、136 test成功。
- `npm run typecheck`：成功。
- `npm run lint`：成功。
- `npm run build`：成功。
- `go test ./internal/blueprint ./internal/projects`：成功。
- `go test ./internal/service -run 'Test(OpenAISchema|OpenAIInk|OpenAINormalizesInk)'`：成功。
- `go vet ./...`：成功。
- `go test ./...`：既存`TestOpenAIResponsesRequestUsesStrictStructuredOutput`内の`httptest`がIPv6 loopbackへbindできず中断しました（`listen tcp6 [::1]:0: operation not permitted`）。testの削除や無効化はしていません。
- `git diff --check`：成功。

Frontend testではcategory割り当て、UI controls/既定Binding、順序を維持した独立renderer command/payload mode、timestampの決定的再評価、fallback clip、`.arvproj v1`/Cloud v1 roundtripを検証します。Go testでは新kindのparameter検証、schema列挙、normalizer既定値を確認します。

## 未確認事項

browser、WebGL2 runtime、単体GLSL compilerは利用できません。shader compile/link、実GPU pixel、3種類の見た目の差、context loss/resize挙動、実際のWebM一致、FPSは未確認です。自動検査は成功しましたが、状態は`一部完了`です。
