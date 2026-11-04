# Step 7k-24 — アコースティックKickのアノテーションと評価

**状態: 部分完了。** ローカル専用のアノテーションUIと、完了区間を対象とする評価経路を実装しました。Pythonの自動検証は成功しましたが、この環境ではloopback socketのbindが拒否され、HTTPアプリを起動できませんでした。ブラウザー操作や人による音声レビューは行っていません。確認済みラベルや精度指標は作成していません。

## ツールとデータフロー

- リポジトリルートから`python-island/.venv/bin/python -m python_island.kick_annotation_server`で起動し、`http://127.0.0.1:8765/`を開きます。
- サーバーは`127.0.0.1`のみで待ち受けます。ソースMP3、`drums.wav`、変更していない`kick-candidates-unverified.json`、`feature-timeline.json`を読み込みます。再生にはローカルのdrumsステムを使います。波形は保存済みdrumsピーク系列に基づき、表示中のTimeline範囲だけを描画し、候補一覧を仮想化します。
- 再生、一時停止、停止、シーク、区間再生/ループ、波形ズームと横パンが可能です。Shiftドラッグでレビュー区間を作成します。検出器が採用した候補と棄却/統合した候補はマーカー表示を分け、各候補のscore、検出strength、不合格ゲートを確認できます。
- 候補ラベルは`confirmed`、`rejected`、`ambiguous`、`unverified`です。候補時刻にも候補以外の時刻にもKickラベルを追加できます。Snare/Tom/Bass/Other/Unknownの負イベントにも対応します。候補から±80ms以内に手動Kickを追加した場合、レビュー行の重複を避けるため、その候補にリンクします。
- アノテーションは`demo-assets/generated/demo4-kick-evaluation/kick-annotations.json`に別途保存します。スキーマにはv1、ソース/stem/候補のSHA-256値、区間、イベントラベル、メモを保存します。保存はアトミックです。ハッシュが一致しない場合、異なる音声に対してアノテーションを開くのではなく拒否します。

## 評価と区間ポリシー

評価対象は`complete`区間のみです。完了には、区間全体の再生、区間内すべての候補の分類、未解決のambiguousラベルがないこと、さらに確認済みKickラベルまたはKickなしの明示確認が必要です。区間は重複できません。また評価器は、既定の±80ms許容差を前提に、完了区間同士が160ms以上離れていることを要求します。

評価器は変更していない現行検出器を**drumsステム全体**に1回適用し、完了区間のコア部分のみを採点します。検出器はクリップ全体に対する適応パーセンタイルを使用するため、ステムを切り出しません。切り出すとその挙動が変わるためです。区間外でも設定許容差以内の検出は、区間内の正解イベントと照合できます。レビュー済みコアの外にある未照合検出はFPから除外されます。結果JSONには区間別および集計のTP/FP/FN、precision/recall/F1、オンセット誤差、ゲートによる見逃し、単一ゲートの除去比較、最も近いラベル付き負イベント分類が含まれます。完了区間ができるまでは指標を出しません。

従来のStep 7k-22の位置引数マニフェスト形式も引き続き利用できます。アノテーション評価は`--annotations`、`--source`、`--stem`、`--candidates`を使う追加CLIモードです。サーバーはこのモードを呼び出し、ローカルに`kick-evaluation-results.json`を書き込みます。

## 検証

- Python Island全テスト: **48件成功**。
- `mypy --strict src`: 成功。
- 変更したPythonソース/テストのRuff: 成功。
- NodeによるJavaScript構文確認: 成功。
- 候補fixtureの整合性: サーバー起動時にソースハッシュを確認。候補レコード2,925件、波形ピークレコード9,498件が想定入力数です。
- 実HTTP/APIスモークテストは実行できませんでした。サンドボックスが`ThreadingHTTPServer`のloopback bindを`PermissionError: [Errno 1] Operation not permitted`で拒否しました。
- Chromium/Chrome/Firefox実行ファイルがありませんでした。ブラウザーUI、音声再生/シーク/ループ、画面描画、ポインター操作は未検証です。
- 人による試聴やラベル付けはありません。既存候補はすべて未検証のままで、ベースラインprecision/recall/F1も計算していません。
- `git diff --check`: 最終検証を参照。製品Frontend、検出器、Demucs、Timeline/API、Blueprint、Project、Cloud、DB、Auth、Editorのファイルは変更していません。

## 変更ファイル

- `python-island/src/python_island/kick_annotation_server.py` — loopback限定のローカルHTTPアプリ、アセットハッシュの紐付け、アノテーション検証、アトミック永続化。
- `python-island/tools/kick-annotator/index.html` — 単独で動作する日本語の波形/候補レビューUI。
- `python-island/src/python_island/kick_evaluation.py` — 任意指定のアノテーションCLIと完了区間評価。従来のマニフェストモードも維持。
- `python-island/tests/test_kick_annotation_server.py`, `python-island/tests/test_kick_evaluation.py` — スキーマ、ハッシュ不一致、永続化、完了判定、区間境界、ベースラインのテスト。
- `python-island/pyproject.toml`, `python-island/README.md` — ローカルコマンドと利用手順。
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TEST_STRATEGY.md` — 状態と評価手順のメモ。

## 残作業

loopback bindが許可されるホストでUIを起動し、代表的な区間を人が試聴してください。レビュー対象区間の全候補に加えて、見逃したKickや既知の負例をラベル付けします。完全にレビューした区間のみcompleteにしてから、ベースライン評価器を実行してください。メディアやラベルを配布する前にソースのライセンスを確認してください。このタスクでは未検証候補ファイルとソース/stemアセットを変更していません。
