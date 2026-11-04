# Step 7k-11e — Ink Diffusionの視覚品質と描画方式の検討

**状態：一部完了** — Canvas2Dを大幅に改善し、自動検査は成功しました。利用可能な環境にbrowser/Playwright executableがなく、実際のbrowser pixel、WebM再生、raster FPSを確認できませんでした。

## Canvas2Dの変更

従来の独立した4中心・同心輪郭3本を、絡み合いながら上昇するplume ribbon 3本と、先細りのbranch ribbon 6本に置き換えました。3本のplumeは3つの局所vortex centerを持つ時間変化flow fieldを共有します。輪郭は複数の高さで広がり、非対称に折れ重なります。branchは異なる高さから分岐し、同じflow fieldに沿って曲がります。空間harmonic turbulenceと緩やかなtime phaseにより、動きを連続させ、seek後も安定させます。

各plumeは柔らかい外側washと密度の高い内側fillを持ちます。6本のbranch ribbonは細長いflowを追加します。色はCanvas座標上で既存のGlobal Gradient、または既存のCustom Colorを使い、通常のCanvas `source-over` alpha合成を行います。Effect Opacityは共通command経路で引き続き乗算します。Region clip、描画順、`renderEditorFrame`は変更していないため、PreviewとWebMは同じ評価/描画関数を呼び出します。

## 実装量と性能上限

- **Ink Effectごとにpath command 12個：** plume fill 6個 + branch ribbon 6本。
- **Effectごとに輪郭vertexを600個提供：** 2層plume 3本で384個、ribbon 6本で216個。
- **Always Effectを4つ同時実行：** 1 frameあたり48 command、輪郭vertexは最大2,400個。
- ローカルVitest command生成probeは、Ink Effect 4つで240 frameを**合計120.01ms（0.50ms/frame）**で評価しました。初回response cache構築を含みます。これはJavaScript command評価だけの計測で、browser Canvas raster化、合成、表示FPSは含みません。
- 決定的response tableは、cache entryあたり最大12,001値、Timelineあたり16 parameter variantの上限を維持します。

環境にbrowser、Playwright/Puppeteer、SVG rasterizer、Canvas packageがないためPNGは生成していません。repository内のreference imageは確認しましたが、生成commandのgeometryはbrowser screenshotとして表現されていません。そのためreferenceとの類似性、見た目上の色混合、demo1/demo3での表示、WebM画像との一致は視覚的に未確認です。

## 自動検査

testはplumeの広いpath 3本、先細りbranch ribbon 6本、輪郭範囲と空間的な結合、0以外のopacity/Gradient、音声response scaling、1msで1px未満の輪郭移動、繰り返し/順序を変えたseekの決定性、Region clip適用、既存Ink visibility/parameter挙動を検証します。Canvas test doubleは渡されたpathとclip callを検証しますが、raster化はしません。

- `npm test -- --run` — 126 test成功。
- `npm run typecheck` — 成功。
- `npm run lint` — 成功。
- `npm run build` — 成功。
- Go Blueprint/Project testとOpenAI schema/normalization対象test — 成功。Blueprint/API contractに変更なし。
- `go vet ./...` — 成功。
- `git diff --check` — 成功。

## 描画技術の評価

| Option | Fit for this Ink-only effect | Tradeoffs |
|---|---|---|
| Canvas2Dを継続 | 現在の選択。曲線ribbon、procedural field、gradient fill、clip、timestamp評価を既存経路で利用でき、dependencyや出力pipelineの変更も不要です。 | Inkをgeometryで近似するため、pixel密度field/advectionがありません。raster処理なしでは立体的な拡散や細かな乱流混合に限界があります。 |
| ローカルWebGL2 shader | browser reviewで結果が不十分と判断された場合の次候補です。fragment shaderでpixelごとにadvected noise/densityと色混合を評価できます。透明offscreen WebGL canvasを`drawImage`で既存2D surfaceへ合成すれば、外側の`renderEditorFrame`とcapture経路を維持できます。 | Ink専用GPU resource lifecycle、shader compile/fallback、alpha/color space検査、context loss処理、実出力検証が必要です。未実装であり、承認もありません。 |
| PixiJS | WebGL/WebGL2とWebGPU rendererに加え、displacement/noise filterやblend modeを提供します。 | Effect 1種類のために新dependencyとrenderer lifecycleが増えます。現行文書ではWebGPUを成熟中/experimentalとし、本番にはWebGLを推奨しているため、小規模なローカルWebGL2 passに比べて利点は限定的です。 |
| WebGPU | 将来のGPU経路候補です。 | 2D inkには不要です。browser APIの利用可能性やsecure context制約が互換性作業を増やします。将来3Dを検討する可能性だけでは導入理由になりません。 |

WebGL2推奨は、今回のCanvas変更を人がbrowserで確認し、結果を不十分と判断した場合に限ります。WebGLはbrowser上で高速な2D/3D描画を提供し、既存2D rendererは`drawImage`でcanvas image sourceを描画できます。PixiJS文書ではWebGLを安定版/推奨、WebGPUをexperimental/成熟途上としています。参考資料： [MDN WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API), [MDN drawImage](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage), [PixiJS renderers](https://pixijs.com/guides/components/renderers), [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API), [MDN secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts).

GPU実装、dependency、schema、Timeline、Project、Cloud contractは変更していません。

## 変更ファイル

- `frontend/src/renderer.ts` — plume ribbon、共有flow field、vortex branch、密度を上げた内側輪郭。
- `frontend/src/editor-renderer.test.ts` — 空間的な結合、branch形状、時間的連続性、response、clipの回帰確認。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md` — 実装状況、性能上限、未完了の視覚受け入れ。

## 残りの受け入れ確認

実browserでEditorを起動し、demo1/demo3を使って無音/弱/強source、Ink Effect 1つ/複数、Region clip、出力WebMを確認します。実frameを保存済みink referenceと比較し、raster frame時間/FPSを測定します。結果が連続したinkではなく独立したgeometry ribbonに見える場合でも、Ink専用WebGL2 offscreen prototypeが別途承認され、Preview/WebM合成とseekの決定性を検証するまではCanvas2Dを変更しません。
