# Step 6 — WebM動画出力とローカルProject保存／復元

日付：2026-10-31  
状態：**partial（一部完了）**

## 結果

ローカル動画出力経路と、独立した平文ローカルProject形式を実装した。出力frameには既存の`renderEditorFrame`を再利用する。単体テストと静的検査は成功した。作業環境にブラウザー実行ファイルがなく、実ブラウザーでのWebM encode／再生、codec対応、音声映像同期は検証できなかったため、追試項目として残す。

`.arvb`暗号化は未実装。既存案では鍵の所有者、生成／保存、復旧、失効／rotation、最終コンテナ形式が決まっていない。ユーザー要件に従い、独立した`.arvproj`とWebM機能は実装し、暗号化された`.arvb`部分のみ保留した。

## WebM出力方式

- Visual Editorのプレビューと同じBlueprint、Feature Timeline、`renderEditorFrame`を使用して一時Canvasへ描画する。別Rendererは作っていない。
- 動画captureには`HTMLCanvasElement.captureStream(fps)`と標準`MediaRecorder`を使う。ブラウザーが対応するMIME typeを返す必要がある。VP9、次にVP8を優先し、音声ありではOpusを優先する。利用可能なfallbackは実行時に確認する。
- 音声あり出力では、利用者が選択したローカル音源だけをWeb Audioでdecodeし、`MediaStreamAudioDestinationNode`を経由してCanvas video trackと合成する。素材はAPIや外部サービスへ送らない。
- 音声ありの場合は`AudioContext.currentTime`、無音の場合は`performance.now()`を出力時計にする。最後のframeは`timeline.durationMs`で評価する。音源の長さはTimelineと出力1 frame以内の差で一致する必要がある。
- 設定は24/30/60 FPS、1x/2x解像度。出力時間上限10分、canvas辺の上限4096 pixel、総画素数16,777,216、音源32 MiB、出力512 MiB。キャンセル可能であり、track、source node、animation frame、AudioContextを解放する。
- 本方式はリアルタイムcaptureである。ブラウザースケジューリングでframeが欠落／重複する可能性があり、codec出力は非可逆である。`renderEditorFrame`の決定論的評価は、エンコードbyte列、正確なframe cadence、再生画素の一致を保証しない。UI負荷や実duration／codec動作は実ブラウザーで確認する必要がある。
- APIの対応可否を実行時に検出し、MediaRecorder、Canvas captureStream、Web Audio、decode、録画の非対応／失敗を表示する。ブラウザー／codec対応は環境に依存する。Chromiumの説明はWebM muxer／codecを示すが、このWSL環境に対応機能があることを示すものではない：[Chromium media muxers](https://chromium.googlesource.com/chromium/src/media/%2B/HEAD/muxers/README.md)。`captureStream`はlive captureであり、offlineの決定論的描画ではない：[MDN captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)。

## Project形式

`.arvproj`はversion付きJSON（`format: arvc-project`、`formatVersion: 1`）。Editor Blueprint v1、Pythonの付加項目を含むFeature Timeline v1、作成時刻、schema／renderer／解析version metadata、Blueprint seed、任意音源を含む。Blueprint内にdata URLとして保存されている背景画像も埋め込まれる。音源はファイル名、MIME type、SHA-256整合性情報とともにbase64で埋め込む。

- ファイル全体の上限は64 MiB、埋め込み音源は32 MiB。
- 読み込み時にはJSON、形式／version、schema／renderer version、既存validatorを使ったBlueprint／Timeline、要素数、seed一致、音源metadata／サイズ／hashを検証する。状態反映前に背景画像のdecodeにも成功しなければならない。
- 読み込みは段階的に行う。parse、validation、画像decodeがすべて成功してからstateを更新し、失敗時は現在の編集状態を保持する。
- `.arvproj`は平文であり、ローカル音源や画像dataを含むことがある。暗号化されておらず、`.arvb`の代替ではない。ローカルへdownloadし、media uploadはしない。
- Projectに音源を含め、復元後に利用できるようにする。読み込み時に音源解析やFeature Timeline生成は再実行しない。

## `.arvb`のセキュリティ判断

現行案だけから安全な実装を決めることはできない。機密性の目的と脅威モデル、利用者password方式かservice key方式か、鍵の生成／所有／保存／復旧、紛失・失効時の扱い、改ざん検知、header／version／key ID、nonceとkey rotation、平文および展開後サイズ上限、互換性／移行方式が未決定である。同梱・固定鍵や推測による暗号ラッパーは追加していない。AES-GCMは決定待ちの提案にとどまる。

## 検証

- Frontend：`npm test -- --run` — 5ファイル、24テスト成功（Project往復・validation、無音／音声あり出力mock、frame time、codec拒否、キャンセルcleanupを含む）。
- `npm run typecheck` — 成功。
- `npm run lint` — 成功。
- `npm run build` — 成功（Vite production bundleを生成）。
- Go：既存の`/tmp/arvc-go1273/go/bin/go`で`go test ./...`と`go vet ./...` — 成功。
- `git diff --check` — 成功。
- Python IslandとDemucsは変更なし。依存追加なし。API、音源upload、cloud操作、Gemini request、GitHub pushなし。
- ブラウザー実行ファイル（`chromium`、`chromium-browser`、`google-chrome`、`microsoft-edge`、`firefox`）は見つからなかった。実際の`.webm`生成・再生も行っていない。そのため音声trackの存在、計測した開始offset、終了／duration、frame drop、ブラウザーUIの応答性、利用者が見た視覚品質は**未確認**。芸術性の人手評価もmockでは実施できない。

## 変更ファイル

- `frontend/src/video-export.ts` — リアルタイムWebM captureとcleanup。
- `frontend/src/project-file.ts` — `.arvproj`のserialize、上限、検証、復元。
- `frontend/src/renderer.ts` — Project読込検証用に既存Feature Timeline validatorをexport（評価処理は変更なし）。
- `frontend/src/VisualEditor.tsx` — ローカル音源選択、出力操作／進捗／cancel、保存／読込UI。
- `frontend/src/project-file.test.ts`、`frontend/src/video-export.test.ts` — Projectとmedia APIのテスト。
- `CURRENT_TASK.md` — Step 6のみの作業契約。
- `docs/ARCHITECTURE.md`、`docs/BLUEPRINT_SPEC.md`、`docs/TEST_STRATEGY.md`、`docs/SECURITY.md`、`docs/ENVIRONMENT_SETUP.md`、`docs/CURRENT_STATE.md`、`docs/OPEN_ISSUES.md` — 実装形式、挙動、セキュリティ、検証状況。

## 次工程

1. 対応ブラウザーで手動確認する：無音／音声ありWebM、MIME／track一覧とduration、音声／映像の開始・終了比較、seek／再生、60 FPS／2x負荷、キャンセルとresource解放。
2. 暗号化コンテナ設計前に`.arvb`の目的、鍵ライフサイクル、復旧方式を決定する。
3. 未解決のFFmpeg security issue、Demucs weight licensing、Gemini upstream 503 issueを維持する。
