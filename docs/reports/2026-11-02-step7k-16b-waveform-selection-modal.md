# Step 7k-16b — 波形付き音声範囲選択モーダル

**Status: partial — 実装と自動検証は完了。実ブラウザでの波形描画・操作・試聴は未確認。**

## 実装内容

- `/app`で音源を選ぶとWeb Audio APIでデコードする。デコード中は音源パネルに状態を表示し、失敗時はモーダルを開かず、形式確認・別音源選択を促す。デコード成功後に範囲選択ダイアログを開く。
- 全音源のPCMを最大1,600点のピーク列へ間引き、波形Canvasへ描画する。CanvasのCSSサイズとdevicePixelRatioに合わせ、ResizeObserverとwindow resizeで追従する。選択範囲、開始/終了ハンドル、再生位置を重ねて表示する。
- 波形上の開始・終了ハンドル移動、選択区間のドラッグ移動、区間内クリックでの試聴位置移動、外側クリックでのSeekを実装。開始/終了数値はキーボード操作用range入力からも調整できる。
- 最大60秒、音源duration、0秒、0.01秒の最低長に沿って範囲をclampする。選択時間・開始・終了・音源全長を表示する。
- モーダル内のAudioElementで選択範囲を再生し、Pause、Seek、区間終端停止に対応。Escapeとキャンセルで閉じ、閉じる時に再生を止める。Object URLは既存のcleanup effectで解放する。モーダルではフォーカスを設定し、Tab移動をダイアログ内に収める。
- 確定操作は既存`trimAudioToWav`、44.1kHz stereo PCM16 WAV、Audio Analyze API、Timeline/Summary/crop WAVのEditor反映を再利用する。API・認証・Quota・Timelineの時間原点・Renderer / Project契約は変更していない。

## テスト

- 追加・更新したテストで、波形peak集約、無音・短い波形、60秒境界とduration clamp、開始/終了/全区間drag、クリックSeek、試聴・終端停止、キーボード範囲操作、Escape、デコード失敗、モーダルキャンセルとObject URL解放、既存WAV crop/API/Editor反映を確認。
- `npm test -- --run`: **13 test files passed、152 tests passed**
- `npm run typecheck`: passed
- `npm run lint`: passed
- `npm run build`: passed
- `git diff --check`: passed

## 変更ファイル

- `frontend/src/AudioRangeSelectionModal.tsx`
- `frontend/src/AudioRangeSelectionModal.test.tsx`
- `frontend/src/VisualEditor.tsx`
- `frontend/src/audio-analysis.ts`
- `frontend/src/audio-analysis.test.ts`
- `frontend/src/visual-editor.test.tsx`
- `frontend/src/style.css`
- `docs/reports/2026-11-02-step7k-16b-waveform-selection-modal.md`
- `docs/CURRENT_STATE.md`
- `CURRENT_TASK.md`

## 互換性・未確認事項

Backend / API / Auth / DB / Python、Blueprint / Timeline / Project / Cloud v1、既存20 Effect / 7 Audio Source、Renderer / WebM Exportに変更なし。新規依存関係なし。

実ブラウザでの実音源デコード、Canvas波形のHiDPI表示、マウス/タッチ操作、AudioElementの実再生と停止位置、フォーカス挙動は未確認。実ブラウザ受け入れまではpartialとする。
