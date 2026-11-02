# Step 7k-18 — 円形Effectの描画補正・UI文言最適化

## Status

**partial** — 原因をコード上で特定してRendererと表示ラベルを修正。Frontend自動検証は成功。実ブラウザでの最終画素・UI受け入れは未確認。

## 楕円化の原因と修正

EffectのRegion boundsはStage pixel単位で幅・高さが異なる。円形Effectの一部は、正規化radiusへRegion幅を掛けたX半径とRegion高さを掛けたY半径をCanvasへ渡していた。Canvasのellipseや同様のX/Y個別スケーリングにより、16:9 Stageおよび非正方形Regionで円が楕円になっていた。

対象のpulse-scale、wave-ring、waveform-ring、ripple、shockwave、radial-bars、radial oscilloscope-lineは、RegionのStage pixel短辺を基準に等しいX/Y pixel半径・距離を使うようにした。中心座標とRegion-local座標の意味、既存radius/scale値、Wave Ringの半径方向変形、RegionのRectangle/Polygon clip、opacity、Binding、draw orderは維持。PreviewとWebMの共通renderEditorFrame経路も維持した。

particle-burstなど、既に同一ピクセル半径を使う非対象の円形描画は変更していない。意図的に矩形・楕円・線形となるEffectも変更対象外。

## UI文言

- Audio Source表示をBass、Kick、Snare（推定）、Drums、Vocals、Other、全体の音量へ整理。特にmusic.energyはMaster Busを示すと誤認させない表記にした。
- Binding項目はAudio Reactive、Audio Source、反応量、しきい値、Attack（ms）、Release（ms）とし、音楽制作で理解しやすい用語を採用。
- Timelineのsource一覧を反応データ、選択中Effectの操作表示をBass/Kick表記へ調整。
- 内部Audio Source key、Effect kind、保存値、APIは変更なし。

## テスト結果

- npm test -- --run: 13 files / 158 tests passed
- npm run typecheck: passed
- npm run lint: passed
- npm run build: passed
- git diff --check: passed
- geometry testは16:9と1:1 Stage、横長/縦長Rectangle、Polygon clip、最終Canvas pixel半径のX/Y一致、中心と放射距離を確認する。表示ラベルtestは7 Audio Sourceの表示を確認する。

## 互換性・変更範囲

Blueprint / Timeline / Project / Cloud v1、.arvproj、API、Audio Analyze、解析処理、Effect kind/parameter意味、Renderer APIは変更なし。共通Renderer内のpixel geometryだけを補正。

主な変更ファイル：frontend/src/renderer.ts、frontend/src/VisualEditor.tsx、frontend/src/editor-renderer.test.ts、frontend/src/visual-editor.test.tsx、docs/BLUEPRINT_SPEC.md、状態/検証資料。

## 未確認事項

この実行環境ではWindows Chromeの実画素評価を行っていない。Canvas上での実ブラウザ表示、WebM出力画素の手動比較、UIラベルの実画面での可読性は未確認。自動テストはgeometry命令とCanvas fake-contextを検証しており、GPU/実ブラウザのラスタ画素を保証しない。

対象外のAPI・Go/Python・DB・認証・依存・Hosted・OpenAI・WebM専用処理の変更はない。
