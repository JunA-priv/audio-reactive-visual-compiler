# Step 7k-11i — WebGL2 Ink Region clip修正

**状態：一部完了**

## 原因

`renderEditorFrame`は通常のCanvas command経路より先に`ink-diffusion`を処理していました。通常commandは`drawCanvasCommand`を通り、Canvas状態をsaveしてから描画前に`pathRegion(...)`を適用します。一方WebGL経路は、Region sizeの矩形offscreen canvasへ描画し、Polygon clipを設定しないまま`drawImage()`を直接呼んでいました。そのためoffscreen textureが矩形bounding box全体に合成されました。

Region頂点とnormalized座標からCanvas座標への変換は正しく、欠けていたのはdestinationの`drawImage()`を既存Canvas clipで囲む処理です。

現行Frontend Effect unionにあるInk Effect kindは`ink-diffusion`の1種類です。`ink-flow`と`color-mixing`は独立登録されたEffect kindではなく、このEffect内のshader-level挙動です。そのため共通修正はこれらの視覚部分にも適用されます。

## 修正

`renderEditorFrame`のWebGL Ink branchで次の処理を行います。

1. destination Canvas状態を保存する。
2. commandのRegionとBlueprint寸法を使い、既存`pathRegion()`を適用する。
3. 矩形WebGL offscreen imageを描画/合成する。
4. `finally` blockでCanvas状態を復元する。

既存のPolygon/Rectangle clip機構を使い、別のpolygon mask実装は追加しません。WebGLが利用できない、または失敗した場合、一時clipを復元し、Canvas2D fallbackは既存のcommand単位Region clipで描画を続けます。Effect順、compositorへ渡すopacity、色処理、Preview/WebM共有`renderEditorFrame` entry pointは変更していません。

## 回帰確認

diamond PolygonとRectangleを使うfake-context統合testを追加しました。WebGL `drawImage()`合成時にclip pathが有効であること、fallback path commandにも適切なclipを適用することを確認します。実pixelではなく状態と処理順を検査します。

成功：

- `npm test -- --run` — 12 file、130 test
- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `go test ./internal/blueprint ./internal/projects`
- `go vet ./...`
- `git diff --check`

他Frontend検査と並行して実施した全test runの1回では、既存のaudio restoration/WebM export UI testに断続的な無関係の失敗がありました。その後、単独で全testを実行し130件すべて成功しました。

## 互換性と残りの検証

Region geometryや永続化定義は変更していません。Blueprint、Timeline、Project、Cloudはv1のままです。他Effect、API、dependency、DB、Auth、Python Island、OpenAI挙動も変更していません。

browser executableがないため、Polygon外pixelが保持されること、shader/WebGL raster出力、実canvasでのresize/Region編集時の挙動、WebM pixel一致は未確認です。実装と自動clip state/order検査は成功しましたが、視覚受け入れは一部未完了です。

## 変更ファイル

- `frontend/src/renderer.ts` — WebGL Ink合成時に既存Region clipを適用し、状態を確実に復元。
- `frontend/src/editor-renderer.test.ts` — WebGL image合成とCanvas fallback描画におけるPolygon/Rectangle clipを検査。
- `CURRENT_TASK.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md` — 実装と未完了の視覚受け入れを記録。

## Stage範囲の再調査

上のRegion clip修正でpolygon漏れは解決しましたが、Inkの見える範囲が小さい問題は残っていました。既定modelとrender dataを比較した結果、別の問題が分かりました。

- Blueprint Stage Region：640×360 Blueprint上でnormalized `x=.12`、`y=.14`、`width=.76`、`height=.72`。論理pixelではx=76.8、y=50.4、width=486.4、height=259.2。
- `effectCommandLayers`は`normalizedBounds(region)`を使い、Ink commandを正確にその範囲へ配置します。
- WebGL offscreen pixel sizeは`ceil(region width/height × target canvas pixel scale)`です。viewportはtexture sizeと一致します。
- `drawImage()` destinationは同じ論理Region rectangleです。Preview target sizeはBlueprint size、WebMは均一scaleしたbacking canvasを使い、transformとoffscreen pixel scaleが対応します。
- fragment shaderの`v_uv`は、Region sizeのoffscreen texture内ですでに0〜1を取ります。しかし誤って全StageのUVとして扱い、`(uv - regionOrigin) / regionSize`を再適用してtexture外側を捨てていました。そのためboundsと合成先が正しい場合でも、内側の小さな矩形しか描かれませんでした。

shaderのdensity-field座標を`local = v_uv`に変更しました。Gradient座標は引き続き`Region origin + local × Region size`からStage座標へ変換するため、global gradientの向きはStage基準です。density aspectはRegion width/heightとStage resolutionから求めます。padding、固定inset、destination scaleは追加していません。最初の11i修正で追加したdestination Region clipも有効なままです。

既定Stage bounds、全canvas/半分サイズRectangle Region bounds、WebGL compositor destinationの正確な引数、Region-local shader UV、Stage座標でのGradient mapping維持を確認するregression testを追加しました。Polygon/RectangleのWebGL合成clip stateとfallback clipも引き続き検証します。

再調査後、`npm test -- --run`は12 file / 132 test成功。`npm run typecheck`、`npm run lint`、`npm run build`、`git diff --check`も成功しました。browserがないため、Stage outlineと実pixelの比較、GPU shader compile、描画後のPolygon/Rectangle pixel、browser上のcanvas resize、WebM raster寸法/一致は未確認です。視覚受け入れまで状態は一部完了です。

再調査で変更した追加file：

- `frontend/src/ink-webgl.ts` — Stage基準Gradient mappingを維持しながら、density評価にRegion-local offscreen UVを使用。
- `frontend/src/ink-webgl.test.ts` — Region transform二重適用の再発を防止。
- `frontend/src/editor-renderer.test.ts` — Stage/Rectangle boundsとcompositor destination値を検証。
