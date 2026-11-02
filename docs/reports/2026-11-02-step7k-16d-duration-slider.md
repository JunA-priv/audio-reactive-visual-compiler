# Step 7k-16d — 範囲選択の秒数スライダー統合

**Status: partial — 実装と自動検証は完了。実ブラウザでの操作確認は未実施。**

## 変更内容

- 開始位置・終了位置の2本の補助スライダーを削除。
- 波形の直下に「選択する長さ」スライダーを1本追加し、現在の範囲長を秒で表示。開始秒・終了秒・選択秒数の既存表示は維持。
- スライダー最小値は`min(0.01秒, 音源残り時間)`、最大値は`min(60秒, 音源残り時間)`。初期値は現在の選択区間長。
- スライダー変更時は開始位置を保持し、終了位置を`start + length`へ更新。値は範囲内でclampする。波形の端点/区間操作で範囲が変わるとcontrolled stateを通じてスライダー値・範囲長表示も更新。
- スライダー処理は時間位置やAudioElementのPlay/Pauseを変更しない。
- Step 7k-16cの左右ハンドル、新規範囲drag、区間移動、クリックSeek、選択範囲試聴、最大60秒制約を維持。

## 検証

- 初期長、開始位置固定、終了位置更新、最大60秒、音源残り時間、0.005秒音源、波形操作との双方向同期、Play/Pause/currentTime非干渉を検証。
- 既存WAV crop / Audio Analyze / Editor反映テストを維持。
- `npm test -- --run`: **13 test files passed、154 tests passed**
- `npm run typecheck`: passed
- `npm run lint`: passed
- `npm run build`: passed
- `git diff --check`: passed

## 互換性・未確認

WAV切り出し仕様、Audio Analyze API、Blueprint / Timeline / Project / Cloud v1、Renderer / WebMに変更なし。新規依存関係なし。

実ブラウザでの波形・range inputの見た目、ポインター操作、実音源試聴は未確認のためpartial。

## 変更ファイル

- `frontend/src/AudioRangeSelectionModal.tsx`
- `frontend/src/AudioRangeSelectionModal.test.tsx`
- `frontend/src/visual-editor.test.tsx`
- `frontend/src/style.css`
- `docs/reports/2026-11-02-step7k-16d-duration-slider.md`
- `docs/CURRENT_STATE.md`
- `CURRENT_TASK.md`
