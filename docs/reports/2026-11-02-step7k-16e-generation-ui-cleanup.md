# Step 7k-16e — エフェクト生成UIの重複解消

**Status: partial — UI整理と自動検証は完了。実ブラウザでの受け入れは未確認。**

## 調査結果

Audio Analyze成功時の`analyzeSelectedAudio()`は、crop音声、Timeline、Music Summaryを状態へ保存し、初期BlueprintをEditorに設定する。Blueprint生成APIはこの処理内では呼び出さない。

生成は既存の`loadBlueprintFixture()`が別途担当する。認証済みセッションで`POST /api/v1/blueprints/generate`へ解析SummaryとTimelineを渡し、応答Blueprintを`validateBlueprint()`で検証してからEditor stateへ反映する。失敗時は既存の`apiStatus`へエラーを表示し、ボタンから再試行できる。このため「解析後の自動生成」とはなっておらず、生成操作は依然必要。

## 変更

- 独立していた「3 · エフェクトを生成」セクションを削除。
- 生成ボタン、前提条件、生成ステータスを音源・解析セクションへ集約し、操作を一箇所にした。
- 解析完了後に生成ボタンが利用可能となる条件、同じ生成API・Blueprint検証・Editor適用処理を維持。
- 解析成功だけでは生成APIが呼ばれないことをテストで明示。
- 制作手順を「1 · 音源選択」「2 · 範囲選択・解析」「3 · エフェクト編集」「4 · プレビュー」「5 · 書き出し」の5段階に変更。
- ローカルEditorの既存「サンプル設定を読み込む」動線も音源セクション内に維持。

## テスト・検証

- `npm test -- --run`: 13 test files passed、154 tests passed。
- `npm run typecheck`: passed。
- `npm run lint`: passed。
- `npm run build`: passed。
- `git diff --check`: passed。
- 既存テストで解析後の別個のBlueprint生成要求、生成結果のEditor反映、Preview再生/Pause/Seekを確認。ワークフロー表示テストを5段階へ更新。

## 互換性と未確認事項

生成API、認証、Blueprint validation、Timeline入力、Project読み込み、Blueprint / Timeline / Project / Cloud v1、Renderer / WebMに変更なし。新規依存なし。

実ブラウザでの配置・操作・失敗時再試行の視認確認は未実施。API生成失敗時の状態表示処理は既存のまま維持し、この変更で新しい失敗経路は追加していない。

## 変更ファイル

- `frontend/src/VisualEditor.tsx`
- `frontend/src/style.css`
- `frontend/src/visual-editor.test.tsx`
- `CURRENT_TASK.md`
- `docs/CURRENT_STATE.md`
- `docs/reports/2026-11-02-step7k-16e-generation-ui-cleanup.md`
