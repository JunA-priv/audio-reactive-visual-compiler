# Step 7k-11j — Ink Diffusionの密度と透明度

**状態：一部完了**

## 調査

shaderの広域envelopeは`cloudEnvelope * (0.42 + u_density * 0.25)`を加え、thresholdは`0.19`から始まっていました。このためcore、satellite、expansion front、noiseを加える前からRegionの大部分にかなりの基礎密度がありました。smoothstep thresholdも公称thresholdよりかなり低いところから始まるため、弱いbackground densityが広い範囲で0以外のink alphaへ変換されていました。その後shaderはmaskに対してalphaをほぼ線形にscaleしていました。

Global GradientだけでRegionを塗るのではなく、pigment色を選択しfragment出力alphaがそのpigmentを制御します。Custom Colorも同じalpha経路です。WebGL contextは`premultipliedAlpha: true`を要求し、shaderはすでに`vec4(color * alpha, alpha)`を出力しています。これはCanvas2D `drawImage()`合成で正しいpremultiplied形式です。11i再調査で導入したRegion-local UVとStage空間Gradient mappingを維持しました。

## 変更

`frontend/src/ink-webgl.ts`で実施：

- 広域cloud envelopeを弱いcarrier（`0.075 + inkDensity * 0.12`）にし、radial falloffを狭めました。
- central Gaussian core、satellite source、移動expansion front、turbulence、flow filamentを局所density構造として維持しました。
- density thresholdを上げ、ink densityとaudio responseに反応させました。より狭いsmoothstep遷移によりthreshold未満の領域は透明になり、不規則noiseがdensity境界に隙間を作ります。
- alphaを`pow(ink, 1.6)`にdensity/expansion gainを乗算する形に変更しました。広い線形washを残すのではなく、密度の高い領域にopacityを集中させます。
- premultiplied output（`color * alpha`）とCanvas2D合成境界での既存effect opacityを維持し、Effect opacityの二重適用を防ぎます。

Effect parameter、Blueprint/Timeline/Project/Cloud schema、version、Binding挙動、Region clip、WebGL lifecycle、その他Effectは変更していません。

## Test

弱いenvelope、response連動threshold、局所smoothstep mask、非線形alpha、premultiplied outputを検査するshader contract assertionを追加しました。既存testではRegion-local UVとStage空間Gradient座標を確認します。

Passed:

- `npm test -- --run` — 12 file、133 test
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `git diff --check`

## 視覚検証と制約

環境にbrowser executableやGLSL compilerはありません。現在のtestはshader sourceとrenderer contractを調べますが、実pixelに透明な隙間ができること、alpha 0の割合、高alphaの割合、中心/外縁の平均alpha、時間/音声によるcoverage変化、見た目上のink品質を証明しません。shader compile/link、browser alpha readback、Polygon pixel、Preview/WebMの視覚的一致は未確認です。そのため実pixel reviewまで状態は一部完了です。

## 変更d files

- `frontend/src/ink-webgl.ts` — 局所density mask、弱めた広域field、非線形alpha。Region-local UVとpremultiplied outputを維持。
- `frontend/src/ink-webgl.test.ts` — shader contractの回帰確認。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md` — 実装と視覚検証の状況。
