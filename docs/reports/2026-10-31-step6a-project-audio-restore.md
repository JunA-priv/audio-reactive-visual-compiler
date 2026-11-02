# Step 6a — Project復元後の音声欠落

日付：2026-10-31  
状態：**完了**（ローカル実装と自動回帰テスト）。ブラウザーでの再確認は別途必要。

## 調査結果

1. `.arvproj` v1に音源が含まれるのは、`serializeProject`へ`audioFile`がnull以外で渡された場合。UIは現在の音源Fileをserializerへ渡していた。
2. 復元処理は埋め込み音源のmetadata、base64 byte列、サイズ、SHA-256を検証し、保存されたファイル名とMIME typeで`File`を作成していた。既存project-fileテストではbyte列の往復と、SHA-256破損時の拒否を検証済み。
3. `loadProjectSelected`は`restored.audioFile`をEditor stateへ正しく反映していた。
4. 音声トラック選択は独立して`exportWithAudio=false`（Silent）で初期化され、Project読込時に更新されていなかった。そのためEditor上では復元Fileが表示されても、`startVideoExport`は`exportWithAudio`がtrueのときだけFileを渡すため、実際には`audioFile: null`を渡していた。
5. 音声モード選択時、`exportWebM`はWeb AudioでFileをdecodeし、sourceを`MediaStreamAudioDestinationNode`へ接続して、Canvas video trackと音声trackを合成する。この不具合の原因は別のencoder経路にはなかった。

## 修正

Projectの復元に成功した際、音源Fileがあれば音声あり出力を選び、音源がなければSilentを選ぶようにした。既存のProject検証がすべて成功した後に、復元Fileと合わせてstateへ反映する。`.arvproj`形式／versionとexporterは変更していない。

## 回帰確認

- 音源を含むProjectの保存・復元、byte内容の一致、SHA-256検証：成功。
- 音源なしProjectの保存・復元：成功。復元後の`audioFile`はnull。
- Visual Editor結合確認：復元音源により「音声を含める」が選択され、Export WebM操作で復元した名前付き`File`が既存の`exportWebM`へ渡ることをmock encoderで確認。
- 不正Project読み込み時、既存Region／Editor状態を保持：成功。
- 既存exporterの音声テストで、mock AudioContextのsource開始、音声／映像stream合成経路、cleanupを確認。
- `npm test -- --run`：5ファイル、27テスト成功。
- `npm run typecheck`、`npm run lint`、`npm run build`：成功。
- `git diff --check`：成功。

## 制約

追加回帰テストはEditor stateとexporterへ渡す引数を確認するもので、実ブラウザーでのencodeは行わない。ユーザーからは修正前の通常音声ありWebM生成・再生成功が報告されていたが、この作業環境では修正後に復元Projectからの音声再生を再実施していない。ブラウザーで復元後の音源付きProjectを再出力し、音声track、開始／終了同期、期待durationを確認する。

Project schema、Renderer／encoder、依存、Go API、Python Islandに変更なし。Gemini request、upload、cloud操作、pushなし。
