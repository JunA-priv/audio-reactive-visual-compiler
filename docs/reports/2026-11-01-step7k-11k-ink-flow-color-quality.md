# Step 7k-11k — Ink Flow / Color Mixingの視覚品質

**状態：一部完了** — 実装と自動contract検査は完了しました。GPU/browserでの視覚受け入れ確認が残っています。

## 結果

- Ink Flowは幅を広げて柔らかくしたdensity ribbonを使い、body/edge alphaと時間変化flow warpを調整します。細い輪郭ridgeを減らしつつ、局所vortexと滑らかな音声responseを維持します。
- Color Mixingはwarp/移動が独立したpigment density fieldを4つ評価します。各sourceの局所密度に応じてpigment色を混ぜ、境界bleedを抑えた上でdensity maskを狭めます。これにより透明な隙間を保ち、大きな一様色領域を減らします。
- Ink DiffusionのStep 7k-11jにおけるdensity/alpha処理は変更していません。

## Palette contract

Blueprint v1に任意field `color-mixing.customPalette`を追加しました。2〜4個の厳密な`#RRGGBB`色を持つarrayです。Frontend/Go validationは不正な長さや値、他Effect kindでの使用を拒否します。

- Global Gradientは既存の共有paletteを引き続き使います。
- `customPalette`を指定したCustom Colorは、別々のpigment density fieldへ各色を割り当てます。
- fieldがないCustom Colorは旧来の単色挙動を維持します。
- 新規Editor/正規化後AIのColor Mixing Effectは、color modeをGlobal Gradientのままにし、既定paletteをcyan、purple、pinkにします。

OpenAI strict schemaとnormalizationを更新しましたが、API callは行っていません。Project/Cloud v1 roundtripでは任意paletteを保持します。

## 互換性と描画

Blueprint、Timeline、`.arvproj`、Project、Cloudはv1のままです。Region-local UV、Stage空間Gradient、Rectangle/Polygon clip、opacity、描画順、audio binding、決定的seek、Ink WebGL2 fallback、共有`renderEditorFrame`のPreview/WebM経路を維持します。paletteのない既存Color Mixing projectも有効です。

## 変更ファイル

- `frontend/src/ink-webgl.ts` — Flow density、独立したMixing pigment field/合成。
- `frontend/src/renderer.ts` — palette payloadとfallback色処理。
- `frontend/src/editor-model.ts`、`frontend/src/VisualEditor.tsx` — 任意palette contract、既定値、palette controls。
- Frontend renderer/editor/project/cloud/shader test — palette、描画payload、roundtripを検証。
- `api/internal/blueprint/blueprint.go`、`blueprint_test.go` — palette検証。
- `api/internal/service/openai.go`、`openai_test.go` — strict schema、prompt、normalization。
- `docs/BLUEPRINT_SPEC.md`、`docs/ARCHITECTURE.md`、`docs/TEST_STRATEGY.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md`、`docs/VISUAL_EFFECT_ROADMAP.md`、`CURRENT_TASK.md` — contractと状態の記録。

## Test

- `npm test -- --run` — 12 file、137 test成功。
- `npm run typecheck` — 成功。
- `npm run lint` — 成功。
- `npm run build` — 成功。
- `go test ./internal/blueprint ./internal/projects` — 成功。
- `go test ./internal/service -run 'Test(OpenAISchema|OpenAIInk|OpenAINormalizesInk)'` — 成功。
- `go vet ./...` — 成功。
- `git diff --check` — 成功。

## 未確認事項

browser、WebGL2 runtime、単体GLSL compilerは利用できませんでした。shader compile/link、実GPU pixelと見た目上のFlow/Mixing品質、GPU性能/FPS、Preview/WebMの視覚的一致は未検証です。shader source/rendererの自動testはこれらの確認の代わりにならず、browser受け入れ確認が必要です。

dependency、Python Island、database、authentication、Hosted環境、他Effectの挙動は変更していません。OpenAI API callやGitHub pushも行っていません。
