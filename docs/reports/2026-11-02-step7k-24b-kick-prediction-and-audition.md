# Step 7k-24b — Kick予測と候補試聴

**状態: 部分完了。** 実装と自動確認は完了しました。候補試聴とUI操作は実ブラウザーで検証していません。

## 候補試聴

試聴は選択候補の時刻から開始し、次に現れるより後の候補時刻で停止します。最後の候補はソースの終端まで再生します。停止位置を決める際、同時刻の候補はスキップしてゼロ長区間を避けます。区間をソースの範囲内に制限し、可能な場合は正の最小長を確保します。候補を切り替えると前の試聴を停止し、既存の音声要素を再利用します。試聴ではラベルを変更せず、通常再生や区間ループ再生とも分離されています。

## 暫定予測

ベースラインは既存の候補判定のみを使います。`accepted`は暫定Kick、それ以外の候補判定は暫定non-Kickとします。新しい閾値や信号特徴量は導入しません。提供された2,925候補では、**Kick予測138件**、**non-Kick予測2,787件**です。これは検出器由来の初期仕分け補助であり、精度の主張ではありません。候補集合にないKickは検出できません。

ローカルアノテーションの応答/保存経路では、`predictionMethod=detector_disposition_v1`、`predictedKick`、`reviewed`、`finalLabel`を持つ`candidatePredictions`を生成します。人の判断は既存の`candidateReviews`に保持され、予測より優先されます。セッションを読み込んだだけで既存の保存済みアノテーションを書き換えることはありません。予測メタデータは既存の明示的な保存経路でのみ永続化されます。アノテーションスキーマのバージョンは変更していません。予測情報のない古いアノテーションも読み込めます。

予測は評価器や区間完了ルールを変更しません。評価入力に使うのは、人による候補レビューと確認済みKickオンセットラベルだけです。推定値だけで区間を完了扱いにしたり、TP/FP/FN、Precision、Recall、F1に加えたりすることはできません。候補がないKickは引き続き手動アノテーションが必要です。

## 互換性と対象範囲

候補フィクスチャ、保存済みアノテーションファイル、検出器、Demucs、評価器の契約、製品版Editor、API、Timeline、Blueprint、Project、Cloudは変更していません。依存関係の追加や外部への通信も行っていません。

## 検証

- Python Islandテスト: **60件成功**。
- Nodeアノテーション操作テスト: **12件成功**。
- `mypy --strict src`: 成功。
- 変更したPythonファイルのRuff: 成功。
- アノテーションUIモジュールの構文確認: 成功。
- `git diff --check`: 成功。
- 実ブラウザーでの試聴/UI動作: **未検証**。部分完了の状態を維持します。

## 変更ファイル

- `python-island/src/python_island/kick_annotation_server.py` — レビュー上の正解や評価を変更せず、予測メタデータを別途生成。
- `python-island/tools/kick-annotator/annotation-controls.mjs` — 候補の試聴範囲とレビュー情報の同期。
- `python-island/tools/kick-annotator/index.html` — 暫定/レビュー済み状態と次候補の試聴UI。
- `python-island/tests/test_kick_annotation_server.py` — 予測の分離と人手ラベルの保持。
- `python-island/tests/test_kick_annotator_controls.mjs` — 試聴境界とラベル状態の動作。
- `python-island/tests/test_kick_evaluation.py` — 予測が評価上の正解として扱われないこと。
- `python-island/README.md`, `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`, `docs/OPEN_ISSUES.md`, `docs/TEST_STRATEGY.md` — 使用方法と状態の文書。

## 残作業

アコースティックドラムの精度を測るには、完全な区間を人が試聴し、ラベルを確定する必要があります。試聴の切り替え、停止タイミング、再生操作の実ブラウザー検証も未完了です。
