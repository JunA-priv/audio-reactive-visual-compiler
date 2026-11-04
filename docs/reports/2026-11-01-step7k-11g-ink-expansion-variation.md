# Step 7k-11g — Ink Diffusionの拡張と形状変化

**状態：一部完了** — Rendererと決定的geometryの変更を実装し、自動検査は成功しました。この環境ではbrowser WebGL2 pixelを確認できず、視覚受け入れと実際のshader coverageは未確認です。

## 実装

### WebGL2 density field

- 初期/静穏状態でも開始位置が見えるよう、密度の高いGaussian風central coreを追加。
- satellite diffusion sourceを4つ追加。orbit角度、半径、非対称性はEffect ID/Blueprint seedと絶対時刻phaseで変え、別々のInk Effectや後のtimestampが同じvortex形状へ重ならないようにします。
- 絶対時刻、既存`diffusionSpeed`、平滑化済みBinding responseから決定的なdiffusion量を求め、幅広い密度envelopeと外向き拡張frontを制御します。Binding responseはfront到達範囲、flow、vortex移動、alpha密度も増やします。
- 旧3-vortex warpを、方向/半径が独立した局所vortex 4つに拡張。異なる時間周波数で動く2種類のnoise-warp scaleを使い、radial/angular filament fieldで単一ribbon方向ではなく複数の外向きthreadを加えます。
- Gradient pigmentは引き続きCanvas全座標と指定角度を使います。Custom Colorは単一pigmentで、密度に応じてtoneを変えます。

### Canvas2D fallback

Canvas2D fallbackを、下端から上がるribbonからcentral coreと周回するsatellite cloud 3つへ変更しました。それぞれ48点の決定的な非対称輪郭と内外の密度layerを持ちます。中心から曲線radial branchを5本伸ばします。検査した8秒後の静穏状態では、fallback輪郭の幅がStage Region幅の60%を超えます。これはgeometry上の幅であり、raster化した面積coverageの測定ではありません。Binding responseが強いと検査対象fallbackの範囲はさらに増加します。

## 決定性とcontract

すべての時間変化は、評価timestamp、Effect ID、Blueprint seed、既存Timeline response、既存parameterから計算します。前frame状態はありません。既存response平滑化とWebGL2 context cache/fallbackを維持します。Region clip、描画順、opacity、Global Gradient/Custom Color、`renderEditorFrame`は変更していません。

新しい任意fieldは不要でした。Blueprint、Timeline、`.arvproj`、Cloud Envelope、Projectはv1のままです。Frontend/Go validator、OpenAI schema、Python Island、他Effect、dependency、DB/Auth、APIは変更していません。

## Testと検証

- Renderer/shader対象test — 2 file、48 test成功。
- `npm test -- --run` — 12 file、128 test成功。
- `npm run typecheck` — 成功。
- `npm run lint` — 成功。
- `npm run build` — 成功（Vite bundle 366.67 kB、gzip後112.25 kB）。
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go test ./internal/blueprint ./internal/projects` — 成功。
- OpenAI schema/normalization対象test — Binding source enum、Ink schema既定値、normalizer、strict schema subsetが成功。
- `GOCACHE=/tmp/arvc-step7k11f-go-cache go vet ./...` — 成功。
- `git diff --check` — 成功。

広めのservice test regexでは`httptest.NewServer`を起動するHTTP mock testも選ばれましたが、sandboxのIPv6 loopbackへbindできませんでした（`listen tcp6 [::1]:0: operation not permitted`）。上記のschema/normalization単体testは別途実行し、成功しました。このstepではGo code/schemaを変更していません。

Renderer testでは、同じtimestampでのcommand一致、順序を変えたseekの一致、異なる時刻payload、0/3/8秒時点でのfallback輪郭範囲拡大、8秒時点でRegion幅の60%を超える広がり、静穏時に比べた強response時の範囲増加、Region clip command実行を検証します。shader静的testではcore、拡張/front、複数phase、複数scale warp、vortex構造を確認します。これらのtestはGLSLのcompile/raster化を行いません。

## 未確認事項

browser、GPU-backed WebGL2 context、GLSL compilerはインストールされていません。そのため、実際のshader compile/link、raster化されたcentral coreとRegionの60〜90% coverage、0/3/8秒での見た目の変化、Demo表示、実際のresponse強度、FPS、context restore、WebM再生/pixel一致は未確認です。Canvas2D輪郭範囲testやsource静的確認をGPU視覚受け入れと見なさないでください。

## 変更ファイル

- `frontend/src/ink-webgl.ts` — central-core density field、seed付き周回source、外向きfront、複数phase warp、多様なvortex field、拡張filament、response駆動coverage。
- `frontend/src/renderer.ts` — 決定的diffusion uniformと、広がりを増したcenter/radial Canvas2D fallback。
- `frontend/src/editor-renderer.test.ts` — shader payload/fallback geometryについてtime/seek/coverage/response/clipを確認。
- `frontend/src/ink-webgl.test.ts` — shader構造の静的assertion。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md` — 状態、設計、視覚受け入れの制約。
