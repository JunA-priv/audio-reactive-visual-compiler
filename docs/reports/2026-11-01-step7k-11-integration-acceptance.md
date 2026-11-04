# Step 7k-11 — 統合受け入れ検証

**状態：一部完了。** 自動contract検査とbuild確認を実施しました。この環境では必要なbrowser/GPU、実際の再生、WebM、性能の受け入れ検査を完了できませんでした。

## 環境

- Frontend：Node/npm toolchainを利用可能。
- Python Island：repositoryの`.venv`を利用可能。
- Go：`/usr/local/go/bin/go`を利用可能。この環境では既定のuser cacheがread-onlyのため、Go build cacheを`/tmp`に変更。
- media確認：`ffmpeg`と`ffprobe`を利用可能。
- 利用不可：Chrome/Chromium、Firefox、WebGL2 browser runtime、単体GLSL compiler。Playwright/Puppeteer browserのインストールも見つかりませんでした。

## EffectとAudio Sourceの結果

Frontend suiteは20種類すべてのEffectを含めて成功しました。renderer/editor/validator、Binding、Region geometry、決定的seek、Project/Cloud contract testを含みます。これは描画commandと永続化contractの自動検証であり、Effectごとの人手による視覚受け入れを示すものではありません。

7種類のsource値（`kick.events`、`snare.events`、`bass.envelope`、`drums.energy`、`vocals.envelope`、`other.envelope`、`music.energy`）は既存enum/schemaとrenderer testで引き続き検証されています。各sourceを変更し、再生中の反応を確認するlive browser操作はできませんでした。

| 領域 | 自動検証結果 | 手動/runtime結果 |
|---|---|---|
| 20種類のEffect、Editor/renderer contract | Frontend suite成功（137 test） | 個別の見た目は未確認 |
| 7種類のAudio Sourceとevent/continuous contract | 既存testとschema確認で検証 | 実際のsource応答は未実施 |
| Region/決定的評価 | geometry、clip、seekの既存test成功 | Stage/Rectangle/Polygonのpixel未確認 |
| Ink WebGL2 shader、lifecycle、合成 | source/command contract test成功 | shader compile/link、context loss、resize、GPU pixelは未確認 |
| Project/Cloud v1 | FrontendとGo contract packageの既存roundtrip test成功 | 手動Editor save/reload未実施 |

## Demo asset

`demo-assets/source/`にはMP3が3曲あります。Feature TimelineとSpectrum sidecar、および公開ローカル用の`frontend/public/demo/` copyもあります。`ffprobe`の結果：

| Demo | 音声長 | Timeline長 | 差 | Spectrum |
|---|---:|---:|---:|---|
| demo1 | 180.240s | 180.200s | 40ms | 32 bands、20ms hop、9,010 frames / 180.200s |
| demo2 | 166.080s | 166.040s | 40ms | 32 bands、20ms hop、8,302 frames / 166.040s |
| demo3 | 118.080s | 118.054s | 26ms | 32 bands、20ms hop、5,903 frames / 118.060s |

Spectrum frame数はquantize後のbyte数を32 bandsで割って求めています。durationはTimelineと20ms frame内で一致します。browserで音声を再生していないため、load、pause/resume、seek、track終端処理、聴覚/視覚同期は未確認です。Demo公開の承認とasset gateは変更していません。

## Preview、WebM、性能

共有`renderEditorFrame`経路と自動testは維持されています。Preview描画やWebM生成を行えるbrowserはありませんでした。そのためGPU Inkの有無、PreviewとWebMの視覚一致、encode後の再生、Codec/FPS/解像度/duration、音声同期、encode後pixel上のEffect順は未確認です。FPS、frame時間percentile、GPU/CPU負荷、memory、export時間は測定していません。`ffprobe`はsource音声の長さ確認だけに使い、WebMは作成していません。

## Test結果

- Frontend `npm test -- --run`：12 file、137 test成功。
- Frontend `npm run typecheck`、`npm run lint`、`npm run build`：成功。
- Python `python -m pytest -q`（repository venv）：27 test成功。
- Python `mypy --strict`：成功。
- Python `ruff check src tests`：変更していないPython source/test fileにE501行長違反が16件あると報告。`ruff check --ignore E501 src tests`は成功。このtaskではPython fileを変更していません。
- Go `go test ./...`：`internal/service`より前のpackageは成功。service suiteは`httptest.NewServer`がsandbox内で`[::1]`へbindできず（`operation not permitted`）、`TestOpenAIResponsesRequestUsesStrictStructuredOutput`で停止。
- Go Blueprint/Project対象testと一部service schema/Timeline test：成功。
- Go `go vet ./...`、`git diff --check`：成功。

## 不具合と変更

取得できた確認範囲では新たな製品不具合を確認しなかったため、実装コードは変更していません。task/status文書と本reportだけを更新しました。API、DB、Auth、Hosted環境、dependency、Python、OpenAI runtime、Effect挙動は変更していません。GitHubへのpushもしていません。

## 残りの受け入れ作業

WebGL2対応browserで20種類のEffect visual matrixを確認し、3曲のDemoで7種類すべてのsourceを試します。実pixelでInkのpolygon clipping/opacity/gradientとcontext lifecycleを検証し、音声付き/音声なしWebMをexport・再生して、FPS/frame time/resource usageを記録します。IPv6 loopback bindが可能な環境でGo suite全体を再実行します。既存Ruff E501 findingsは別途reviewまたはbaseline化してください。
