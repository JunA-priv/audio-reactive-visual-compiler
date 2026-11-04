# Step 7k-11h — Region占有率の正規化

**状態：一部完了**

## 結果

18種類すべてのEffectで、割り当てたRegionを主なlayout境界として扱うようRenderer geometryを調整しました。Blueprint、Feature Timeline、Project、Cloudのschema/versionは変更していません。PreviewとWebMは引き続き同じ`renderEditorFrame`経路を通り、絶対時刻による既存評価とRegion clipを維持します。

coverageの調整幅が最も大きいのはInk Diffusionです。WebGL2 shaderのdensity envelopeとexpansion frontを、Region内でcentral coreからより遠くまで広げます。Canvas2D fallbackではcore、satellite cloud、外向きbranchの範囲を時間/responseに応じて拡大します。既存central source、決定的なtime/seed変化、response平滑化、色/opacity処理、fallback lifecycleは維持します。強いresponseではfallback geometryがRegion端まで届きます。shader pixelの実coverageは測定していません。

その他のgeometry変更：

- 円形/radial：Pulse ScaleはRegionの幅/高さを別々に使用します。Rotation Movementの基準rectangleを拡大しました。Waveform Ring、Wave Ring、Radial BarsはRegion相対の横/縦radiusを使います。RippleとShockwaveはRegionの両軸に応じて拡張し、円形OscilloscopeはRegion相対の楕円pathを使います。
- Waveform/Spectrum：barとlineはRegion幅全体への配置を維持し、振幅にはRegion高さを使います。既存実装がすでにRegion全体を使っていたため、無関係なparameterは変更していません。
- Particles/transform：Particle Trailの縦方向到達範囲を広げました。Particlesは既にRegion emitter幅に分布し、Particle Burstも設定されたRegion相対originから拡張していたため変更していません。Glow Brightnessも既にRegion全体を対象としていました。
- Ink：polygon Regionを含め、共通Region経路で引き続きclipします。

## Test

18種類すべてのEffectをrectangleとpolygon両方のRegionで動作させるrenderer testを追加しました。生成geometryの幅/高さが割り当てたRegionに合うこと、共通Region clip経路が適用されることを確認します。既存Ink testでは、同じtimestampの決定性、順序を変えた評価、response変化、fallback範囲を引き続き検証します。これらはcommand/geometryを確認し、raster pixelは確認しません。

成功：

- `npm test -- --run` — 12 file、129 test
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `go test ./internal/blueprint ./internal/projects`
- `go vet ./...`
- `git diff --check`

## 互換性と制約

保存field、既定値、validator、OpenAI schema、version番号は変更していません。既存Region clip、color mode、opacity、Binding評価、決定的seek、Preview/WebM共有renderer経路を維持します。

browser executableはありませんでした。WebGL2 shader compile/link、実際のInk pixel coverage、polygon raster clip、browser性能/FPS、WebM pixel一致は未確認です。したがって本reportが示すのは自動geometry改善であり、視覚受け入れではありません。

## 変更ファイル

- `frontend/src/renderer.ts` — Region相対geometry sizeとInk Canvas2Dの到達範囲。
- `frontend/src/ink-webgl.ts` — Ink density envelopeとexpansion frontを拡張。
- `frontend/src/editor-renderer.test.ts` — 18種類すべてのEffectに対するrectangle/polygon coverage回帰確認。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/VISUAL_EFFECT_ROADMAP.md` — 実装状況と視覚受け入れ状況。
