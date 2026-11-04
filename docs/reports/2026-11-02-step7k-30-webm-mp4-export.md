# Step 7k-30 — WebM / MP4動画エクスポート

**状態: 部分完了。** MP4の選択と書き出しは、既存のCanvas/MediaRecorderレンダラーおよび音声ミックス経路を共有します。Frontendの自動検証は成功しました。この環境にはブラウザーも自動化ランタイムもないため、実際のH.264/AAC対応、MP4の生成・再生、音声同期は未検証です。

## 既存のWebM経路

`frontend/src/video-export.ts` selects a supported WebM MIME type, captures the export Canvas using `captureStream(fps)`, and renders each frame through `renderEditorFrame`. When audio is included, it decodes the selected local file into Web Audio, connects the source to a `MediaStreamAudioDestinationNode`,し、フレームクロックには `AudioContext.currentTime` を使います。Recorderがチャンクを出力し、EditorがBlobをダウンロードします。Canvas/音声トラックとAudioContextは `finally` で解放します。この共通経路を両形式で使います。

## MP4の実装

- 無音MP4の候補では明示的に `video/mp4;codecs="avc1.…"` (H.264/AVC).
- 音声付きMP4の候補では明示的に `video/mp4;codecs="avc1.…,mp4a.40.2"` (H.264/AVC + AAC LC).
- `MediaRecorder.isTypeSupported()` は無音と音声付きの各モードで個別に確認します。基本MP4 MIMEやAAC以外の音声形式は受け付けません。
- 停止時には実際のRecorder MIMEが選択したコンテナと必須コーデックを示すこと、Blobが空でなく宣言MIMEと一致することを確認します。さらにMP4ではファイル先頭にISO BMFFの`ftyp`ボックスがある場合に限り、`.mp4`ダウンロード用に返します。
- 非対応の組み合わせではExportセレクターのMP4を無効にし、MP4選択後に音声モードを変更した場合も書き出しを無効にします。MP4エラー時にWebMへフォールバックしません。
- 既定値は引き続きWebMです。ファイル名には検証済みの選択形式に応じて`.webm`または`.mp4`を使います。

録画開始失敗、録画中エラー、停止時例外、空出力、Recorder MIME不一致、MP4コンテナシグネチャ不一致はエラーとして通知します。`finally`処理では、重複のないすべてのMediaStreamトラックを停止し、音声ソースを切断・停止してAudioContextを閉じます。

## 互換性と変更ファイル

Preview/Export共通の`renderEditorFrame`、Canvasキャプチャ間隔、音声クロック、ローカル音声デコード、FPS/解像度の選択、WebM MIME選択、Blueprint/Timeline/Projectの契約、Renderer、保存形式は変更していません。依存関係、サーバーエンコーダー、FFmpeg変換、API、データベース、認証にも変更はありません。

- `frontend/src/video-export.ts` — MP4 MIMEの選択・検証と共通書き出し経路。既存の`exportWebM`も引き続き利用可能です。
- `frontend/src/VisualEditor.tsx` — WebM/MP4セレクター、コーデック対応状態、形式別の呼び出しと拡張子。
- `frontend/src/video-export.test.ts` — 対応可否、音声モード、MP4 MIME/コンテナ、Recorder失敗、後処理のテスト。
- `frontend/src/visual-editor.test.tsx` — 既定形式、対応状況に応じた選択、エクスポーター呼び出し。
- `docs/ARCHITECTURE.md`, `docs/TEST_STRATEGY.md`, `docs/CURRENT_STATE.md`, `CURRENT_TASK.md` — 書き出し契約、自動テスト範囲、状態。

## 検証

- Frontend full suite: **177 tests passed** (13 files).
- `npm run typecheck`: 成功。
- `npm run lint`: 成功。
- `npm run build`: 成功。
- `git diff --check`: 成功。
- MP4モックテストで、要求するH.264/AAC MIME、音声あり/なしのトラック構成、コンテナシグネチャ判定、MP4を装ったWebMデータの拒否を確認しました。
- 環境内にChrome/Chromium/Firefox実行ファイルおよびPlaywright/Puppeteerランタイムはありませんでした。lockfileにある任意のブラウザーアダプターもブラウザーテスト用ランタイムとして導入・設定されていません。

## 残る受け入れ確認

MediaRecorder対応ブラウザーで無音MP4と音声付きMP4を試し、`ffprobe`でMP4コンテナ、H.264映像、（有効時の）AAC音声、長さ、再生を確認してください。同じTimeline/Effectと音声クロックをWebMとも比較してください。モックテストで検証できるのは選択・検証ロジックであり、実際のエンコーダー対応、MP4データ、画質、音声映像同期ではありません。
