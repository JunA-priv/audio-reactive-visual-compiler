# Step 7k-22 — アコースティックKick検出の定量評価

**状態：一部完了。** ローカル評価toolと回帰確認を実装しました。label付きアコースティックドラム録音がないため、アコースティック音源でのprecision/recall、時刻精度、実音源を用いたgate ablationは未測定です。本番detectorは変更していません。

## Asset調査

repositoryとローカルprojectを検索し、`demo-assets/stems/demo1..demo3`に既存のDemo drum stemが3つ見つかりました。source文書ではユーザー作成Suno demo trackとされ、アコースティックドラム録音とは説明されていません。手作業のKick onset labelやlabel付きSnare/Tom/Bass negative eventも見つかりませんでした。既存Step 7k-11b比較にも曲のground truthはありません。そのため、これらのstemを採点せず、アコースティック評価dataとも記しませんでした。

外部音声のdownload/送信はしていません。model/weightもdownloadしていません。既存synthetic fixtureは評価処理の動作確認だけに使いました。

## 評価tool

`python-island/src/python_island/kick_evaluation.py`とpackage command `kick-evaluation`を追加しました。ローカルJSON manifestを受け取り、Demucs混合`drums` stemへの相対path、mono/stereo PCM16 44.1kHz WAV、手作業でlabelした`kickOnsetsMs`、provenance（`sourceType`、`license`）、任意の分類済み`negativeEvents`を指定します。CLIはDemucsを実行しません。他のWAV encoding/sample rateは明示的に拒否し、resamplerやdependencyは追加していません。

toolは録音ごと、および集計で以下を報告します。

- 既定で境界を含む±80msを使った、時刻順の1対1 onset matching。窓幅は`--tolerance-ms`で変更可能。
- TP/FP/FN、Precision/Recall/F1、match pair、未match timestamp、onset誤差の符号付き/絶対値summary。
- FPが手動annotationしたnegative eventと重なる場合だけ分類別FP件数を算出。それ以外は`unlabeled`。
- candidate score、low-band threshold、sub/body比、80ms decay、local maximum、120ms mergeの判定、各見逃しlabelに最も近い棄却候補。
- 6種類のoffline単独gate ablation：adaptive score、low-band floor、local maximum、sub/body ratio、decay、merge interval。

診断実装は現行detector式をローカルで再現し、結果を報告する前にbaseline event timestampが`features.detect_kicks()`と一致することをassertします。公開Timeline/API出力は拡張していません。本番`features.py` detectorも変更していません。

実行例とmanifest形式は`python-island/README.md`に記載しました。

## 評価結果

既存synthetic Kick波形に合わせた2 hitのPCM signalでtoolを試しました。±80ms評価はTP=2、FP=0、FN=0、Precision=1.0、Recall=1.0、F1=1.0で、両検出とも10ms早めでした。これはsynthetic dataによるtool smoke testであり、アコースティック精度の結果ではありません。単独gate ablationはこのfixtureの出力を変えませんでしたが、アコースティックrecallを制限するgateの特定にはなりません。

前回Step 7k-11bのsynthetic suiteが、より広いlabel付きdetector評価として唯一残っています（報告された10 TP / 0 FP / 0 FNは合成caseに限られます）。同reportのDemo件数を実曲のprecision/recallやアコースティックドラムの根拠として扱うことはできません。

## Frontend Bindingとの切り分け

`kick.events`経路は`kickEvents`と対応する`kickEventStrengths`を読み込みます（strengthのない旧Timelineでは1.0を使います）。Rendererはevent strengthを、最低60msまたはBindingの`releaseMs`で減衰させます。次に`evaluateBinding()`が`threshold`でgateし、Attack/Releaseを適用してBinding `strength`を乗算します。Event Effectも`boundFeature()`を使い、threshold以下は0になります。

event strength 0.2がthreshold 0.1では表示され、threshold 0.2/0.25では0となり、Binding strengthを0.9から0.45へ変えると半減することを確認するrenderer回帰testを追加しました。既存testではevent後の減衰を確認します。これにより、detector event自体がない場合と検出済みeventがBindingで弱められる場合を区別できます。browser pixelや主観的な視認性は測定しません。曲にBindingされた既定EffectはKick応答の証拠ではなく、`kick.events`に設定したEffectだけが該当します。

## 推奨する次の作業

許可されたacoustic kit setに手動Kick onset labelと分類済み低周波negativeを付けてtoolを実行するまで、detectorは変更しません。弱/強hit、異なるKick調律/減衰、Kick+Snare/Tom重複、negativeのみの区間を含めます。少なくとも1録音はtuningから除外してhold-outにします。baselineと各単独gate ablationを録音別/集計指標および時刻誤差分布で比較します。その後に限りgateの最小調整が必要か判断します。synthetic Snare/Tom/Bass、double-Kick回帰を維持し、Timeline v1 fieldも保持します。

視覚応答が弱いと報告された場合、検出が原因と判断する前に同timestampのevent有無/strengthとBinding出力を確認します。

## Testと確認

- Python全suite：**40 test成功**。
- Python `mypy --strict src`：成功。
- 新しいevaluatorとtestに対するRuff：成功。
- 既存E501行長違反を除外した`src tests`全体へのRuff：成功。
- Python tree全体への既定Ruffは、未変更の`cli.py`、`features.py`、`pipeline.py`、`tests/test_features.py`に既存E501違反を報告します。新しいevaluator/testにE501はありません。
- Frontend：**160 test成功**。typecheck、lint、buildも成功。
- `git diff --check`：成功。

`mypy --strict src tests`は、`tests/test_features.py`、`tests/test_audio.py`、`tests/conftest.py`、`tests/test_demucs_integration.py`、`tests/test_cli.py`にあるannotation不足/TypedDictの既存errorを30件報告します。新evaluator test由来のerrorはありません。evaluator sourceはstrict mypyを通過しました。既存testは削除/skip/無効化していません。

## 変更ファイル

- `python-island/src/python_island/kick_evaluation.py`：offline matching、gate診断、ablation、manifest WAV reader、CLI。
- `python-island/tests/test_kick_evaluation.py`：matching境界/重複、baseline一致、決定的評価、manifest、mergeのtest。
- `python-island/pyproject.toml`：ローカルCLI entry point。
- `python-island/README.md`：manifestとローカル利用手順。
- `frontend/src/editor-renderer.test.ts`：Binding threshold/strength応答の回帰test。
- `docs/TEST_STRATEGY.md`、`docs/OPEN_ISSUES.md`、`docs/CURRENT_STATE.md`：評価toolと実data上の未解決制約。
- `CURRENT_TASK.md`：Step 7k-22状況概要。
- 本report。

detector algorithm、Timeline v1、Audio Analyze API、Blueprint/Project/Cloud contract、Demucs model/weights、database、authentication、dependencyは変更していません。Hosted operationや外部APIは使っていません。実アコースティック音源でのprecision/recallとbrowserでの視覚応答は未確認です。
