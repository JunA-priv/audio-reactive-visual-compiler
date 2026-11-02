# Step 7k-17 — 音声・解析結果を含むプロジェクト保存と再読み込み

**Status: partial — 実装・自動検証完了。実ブラウザでの保存・再読み込みは未確認。**

## 既存形式と責務

- `.arvproj`は64 MiB上限のJSONコンテナ v1。Blueprint、Feature Timeline、metadata、任意音源を含み、音源は最大32 MiBのBase64とSHA-256で保持する。
- Music Summaryは以前の`.arvproj` metadataに含まれていなかった。
- Cloud Envelope / Project Document v1はBlueprintとTimelineを持ち、音源は外部Asset参照で保持する。Music SummaryはCloudの既存保存範囲にない。
- ローカルEditorの`audioFile`は解析に使ったcrop WAV。Project読込後は既存audio URL effectがAudioElement用URLを作り、Previewの再生時計が音源と同期する。

## 実装

- `.arvproj v1`の`metadata.musicSummary`へMusic Summary v1を任意追加。既存v1 versionは維持し、Summaryを持たない旧v1、無音声v1も読込可能。
- ローカル保存にBlueprint、Timeline、Summary、解析済みcrop WAVを渡す。MP3全体の埋め込みや保存中の再解析は行わない。
- 読込時は既存Blueprint / Timeline / audio size / SHA-256検証に加え、Summaryの型・範囲、Timelineとのduration一致、audio byte size一致を検証する。Summary付き解析clipはRIFF/WAVE、PCM16 stereo、44.1kHz、chunk/byte length、durationを確認する。データ一式の検証と背景画像loadが済むまでEditor stateを更新しない。
- Summaryが復元されると既存のBlueprint再生成ボタンを利用可能にし、保存Timeline/Summaryを使うのでAudio Analyze APIは呼ばない。Preview音源は既存AudioElement経路から復元する。
- Summaryなし旧v1は読み込むが、Summaryを使うBlueprint再生成はできない。音声があればその旨と再生成には再解析が必要なことを状態表示する。
- Cloud v1はMusic Summaryを保持せず、変更していない。

## Maximum call stack size exceeded

`.arvproj`の10,584,044-byte 60秒PCM crop WAVを再読み込みするテストで再現（10,584,245 bytesは過去のmultipart HTTP Content-Lengthで、WAV本体のサイズではない）。`decodeBase64()`の全入力検証regex（4文字単位グループを文字列末尾まで繰り返す式）が約14 MiBのBase64でRangeErrorを起こした。JSON parseや`String.fromCharCode`のspreadが原因ではなかった。

ファイル上限とBase64上限を先に確認し、padding位置と各Base64文字をループで線形検証するよう修正。60秒PCM WAVを含む保存・再読込テストが通る。

## テスト

- `.arvproj v1`の音声なし・Summaryなし既存形式読み込み
- 60秒/44.1kHz/stereo/PCM16 crop WAV、Timeline、Summary、Blueprintの往復
- 音声再生・Seek・Stop、保存Summaryを利用したBlueprint再生成、Audio Analyze APIが再呼出しされないこと
- 不正/欠損Summary、Timeline duration mismatch、Summaryなしの音声、破損WAVの拒否
- SHA-256破損、version不一致、巨大ファイル、JSON破損、失敗時のEditor state保護を既存テストで維持
- `npm test -- --run`: **13 test files passed、157 tests passed**
- `npm run typecheck`: passed
- `npm run lint`: passed
- `npm run build`: passed
- `git diff --check`: passed

## 互換性・未確認

Blueprint / Timeline / Cloud v1、Audio Analyze API、解析アルゴリズム、Renderer / WebMに変更なし。`.arvproj`はversion 1の任意metadata加法拡張。旧v1ファイルは継続して読み込める。新規依存なし。

実ブラウザでのファイル保存・再読込、実MP3由来60秒clip、ブラウザのピークメモリは未確認。今回のテストはWAV byte countが実60秒PCM16 stereoと一致する合成データを使用。既存64 MiB Project / 32 MiB audio上限は維持しており、Base64 JSONは同サイズのWAVより大きくなる。

Cloud ProjectやSummaryなし旧v1ファイルではMusic Summaryを復元できないため、アプリの解析Summaryを必要とするBlueprint再生成には再解析が必要。Cloud側の保存範囲を変える作業は今回の対象外。

## 変更ファイル

- `frontend/src/project-file.ts`
- `frontend/src/project-file.test.ts`
- `frontend/src/VisualEditor.tsx`
- `frontend/src/visual-editor.test.tsx`
- `docs/BLUEPRINT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/TEST_STRATEGY.md`
- `docs/CURRENT_STATE.md`
- `CURRENT_TASK.md`
- `docs/reports/2026-11-02-step7k-17-project-audio-persistence.md`
