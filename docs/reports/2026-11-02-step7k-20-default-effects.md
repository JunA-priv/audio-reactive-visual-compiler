# Step 7k-20 — デフォルトEffect構成の変更

## Status

**partial** — 新規Editor向けBlueprintを切り分けて実装し、自動検証は成功。実ブラウザ表示は未確認。

## 調査結果と変更

既存のinitialEditorBlueprintはEditor初期化、Demo reset、音声解析後の初期値、テスト用Fixtureの基礎データに共有されていた。これを直接変更するとDemoや生成Fixtureも変わるため、保持したまま新規Editor専用のnewEditorBlueprintを追加した。

新規EditorのEffect順:
1. spectrum-bars（UI: 周波数バー、Category: EQ / Spectrum）
2. ink-diffusion（UI: インク拡散、Category: Ambient / Atmospheric）

両Effectはregion-stage、colorMode global-gradient、opacity 1、visibility always、audioReactive true。Stored effect colorsは既存の水色#91e8ffと紫#8b5cf6。Bindingはともにmusic.energy、strength 0.9、threshold 0.1、attack 60ms、release 260ms。

Spectrum固有値は既存作成時default（barWidth 0.72、spacing 0.12、amplitudeScale 1.35、glowIntensity 1.15、segmented true、segmentsPerBar 12、effect-local attack/release 35/180ms）。Ink固有値も既存default（diffusionSpeed 0.25、flowStrength 0.4、turbulence 0.3、inkDensity 0.65、cloudScale 0.5、responseTime 3）を維持。

## 適用範囲と互換性

- local/app variantの新規Editor mountとAudio Analyze成功後の初期値に適用。
- Demoは従来initialEditorBlueprintを継続使用。
- Fixture/Blueprint generation APIの返却Blueprintはそのまま適用。
- .arvproj読み込みは復元Blueprintをそのまま適用。
- Effect kind、Blueprint/Timeline/Project/Cloud v1、保存形式、API、Renderer/WebM処理は変更なし。

## テスト結果

- Frontend: 13 files / 159 tests passed
- typecheck: passed
- lint: passed
- build: passed
- git diff --check: passed

追加UI/model testはnewEditorBlueprint validation、2 Effectと順序、basic settings、Binding、Spectrum/Ink固有値、初期Editor表示を確認する。既存initialEditorBlueprintの5 EffectとProject/Fixture load testも維持。

## 未確認事項

実ブラウザでの色味・Preview描画の手動確認は未実施。画像の具体的なRGB測定を伴う変更ではなく、既存色定義を再利用した。対象外のAPI/Go/Python/DB/Auth/Renderer/WebM/依存変更なし。
