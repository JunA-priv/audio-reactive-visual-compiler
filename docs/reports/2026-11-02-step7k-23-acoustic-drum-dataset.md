# Step 7k-23 — アコースティックドラムKick評価データセット

**状態: 部分完了。** 既存のローカルDemucsパイプラインでソースをデコードし、音源分離しました。ステムの整合性、検出器由来の候補タイムスタンプ、ゲート診断、候補レビュー用ファイルを用意しました。この環境では音声を試聴できず、ソースのライセンスも未記録です。Kick候補はすべて`unverified`のままで、正解データのマニフェストやPrecision/Recall/F1の結果は作成していません。

## 入力と出所

- Input: `demo-assets/source/audio-reactive-silent-demo4.mp3`
- ファイルサイズ: 4,584,493 bytes。SHA-256 `4d818bb03aa231cdc1ecfaa1d1e03bb8e2bc6dc09d72478c045231291a80f043`.
- `ffprobe`の結果: MP3、48,000Hz、ステレオ、ストリーム/コンテナ上の長さは189.984秒。
- Python Islandのデコード時間は189.960秒（44.1kHzで8,377,236フレーム）です。Demucsステムも同じフレーム数で、デコードしたソースの先頭から始まります。24msの差はMP3メタデータ上の長さとデコード後のサンプル長の差であり、ステムにオフセットは加えていません。
- ソースREADMEにはこのファイルの説明もライセンスもありません。ライセンスは`unknown`として記録しています。タスクの入力に従ってソース種別を`acoustic`としましたが、試聴による独立確認はできていません。
- 元のMP3は変更していません。外部データのダウンロードやアップロードも行っていません。

## 音源分離とステム検証

既存のPython Island CLIを1回実行しました。現在固定されているDemucs経路を再利用し、同じ推論からTimeline、Summary、メタデータ、4つのステムを生成します。

- モデル: `htdemucs` 4.1.0、CPU、4スレッド、shifts 0、overlap 0.25、決定論的アルゴリズム有効。
- チェックポイントは既にキャッシュされており、既存のSHA-256先頭部分による検証に合格しました。メタデータ上のSHA-256全体は `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`.
- `uv run --locked`は共有の読み取り専用uvキャッシュにアクセスできなかったため、依存関係を追加・変更せず、同じ既存CLIを`python-island/.venv`から直接実行しました。
- 分離時間は89.974秒、パイプライン全体は96.835秒、ピークRSSは1,644.5 MiB。
- 4ステムすべてPCM16ステレオWAVで、44,100Hz、8,377,236フレーム、189.960秒、各33,508,988 bytesです。
- 全ステムのサンプルは有限値で、フルスケールのクリッピングはありません。Peak/RMS: drums 0.614197 / 0.078153、bass 0.307312 / 0.045901、other 0.459625 / 0.090776、vocals 0.012695 / 0.000294。

Generated stems:

- `demo-assets/stems/demo4-kick-evaluation/drums.wav`
- `demo-assets/stems/demo4-kick-evaluation/bass.wav`
- `demo-assets/stems/demo4-kick-evaluation/vocals.wav`
- `demo-assets/stems/demo4-kick-evaluation/other.wav`

既存のPython Islandは`demo-assets/generated/demo4-kick-evaluation/`に`feature-timeline.json`、`music-summary.json`、`analysis-metadata.json`も出力しました。Summaryには推定Kickイベント138件が記録されています。これは検出器の出力であり、ラベル付け済み件数ではありません。

## 候補レビュー用データ

ローカル専用ファイル`demo-assets/generated/demo4-kick-evaluation/kick-candidates-unverified.json`（1,958,422 bytes）を作成しました。次の情報を記録しています。

- ソースハッシュ、ソース種別の申告、ライセンス不明、ステムパス、時間範囲0–189,960ms、音声レビュー未実施の状態。
- スコアが正の局所最大候補フレーム2,925件。すべて`labelClass: candidate`および`reviewStatus: unverified`。
- 各候補について、現在の検出器の判定、採用時のstrength、score、低域エネルギー、sub/body比、80ms減衰比、ゲート結果。
- 現在の検出器が採用したイベント138件、および現行条件の少なくとも1つで棄却または統合された候補2,787件。
- 確認済みKickラベル、ネガティブラベル、曖昧ラベルはありません。人による音声レビューを実施していないため、意図的に空です。

候補抽出は検出器に基づくため、自己選択バイアスがあります。この検出器のスコアで局所最大値にならない音響イベントは候補から漏れる可能性があります。候補ファイルに`kickOnsetsMs`キーはなく、Step 7k-22の評価マニフェストでもありません。未検証候補が正解ラベルとして渡されるのを防ぐため、評価マニフェストは作成していません。

## ベースラインとゲート診断

保存済みPCM16の`drums.wav`で検出器出力を再計算しました。138件すべてのイベント時刻がパイプラインのTimelineと完全一致します。Strength配列は整列しており、値の差は最大0.000032です。パイプラインのTimelineは量子化前のDemucs配列から抽出され、その後PCM16ステムを書き出して読み直したために生じた差です。候補ファイルに保存されたstrengthは、WAVを再読込した評価結果と一致します。これは整合性確認であり、正解データに対する精度ではありません。

ラベルが未検証のため、Step 7k-22評価CLIは**実行していません**。TP/FP/FN、Precision、Recall、F1、オンセット精度、見逃したKick数、Snare/Tom/Bassの誤検出数は得られていません。

診断確認用として、現在の候補トレースにはスコアが正の局所ピークが2,925件ありました。それらのピークにおける、重複を含むゲート不合格件数は次のとおりです。

| ゲート | 不合格となった候補ピーク数 |
|---|---:|
| Adaptive score threshold | 2,117 |
| Low-band floor | 1,474 |
| Sub/body ratio ≥ 0.70 | 2,082 |
| 80ms decay ≤ 0.50 | 1,649 |
| 120ms merge suppression | 30 |

件数には重複があるため、ユニークな候補数として合算してはいけません。レビュー対象は局所最大値のみなので、構造上、局所最大ゲートの不合格数は0です。ゲートを1つずつ無効化した場合の出力イベント数は、ベースライン138、適応閾値無効281、低域下限無効144、局所最大ゲート無効307、sub/body比無効484、減衰ゲート無効171、120ms統合無効168でした。これは候補出力数の変化だけであり、精度や改善の測定値では**ありません**。

検出イベントのstrength分布は、最小0.0433、中央値0.0992、p90 0.3893、最大1.0でした。138件中69件のstrengthは0.1以下です。共通Binding閾値0.1を使うKick連動Effectでは、これらのイベント単体のstrengthは閾値を超えません。これは検出漏れとは別に応答を弱める可能性がありますが、画面やブラウザーでの結果ではありません。現在既定のSpectrum BarsとInk DiffusionのBindingは`music.energy`を使用するため、Kick応答の検証にはなりません。

## 評価ラベルと次の作業

この実行環境では音声を聴けなかったため、候補を`confirmed`、`rejected`、`ambiguous`のいずれにも変更していません。Snare/Tom/Bassの負イベントラベルもありません。ソースの権利は不明のままです。権利が確認されるまでは生成メディアをローカルに保持し、公開・配布しないでください。

人によるレビューの次の手順:

1. ローカルのdrumsステムをソースと合わせて試聴し、時刻付き候補一覧を確認します。静かな区間と大きな音の区間から層化抽出してレビューし、採用済み138件だけでなくゲートで棄却された候補も含めます。
2. レビューした各イベントを`confirmed`、`rejected`、`ambiguous`のいずれかにし、識別できるSnare/Tom/Bassの負例ラベルも追加します。出所情報とレビュー記録を保持します。
3. オンセットの確認済みラベルができてから、確認済みKickのタイムスタンプを含むStep 7k-22互換の別マニフェストを作り、±80ms照合でベースラインを実行します。
4. 未レビュー候補は分けて保持します。レビューでソースがアコースティックでないと確認された場合、または権利を確認できない場合は、アコースティックデータセットに使用しません。

## 互換性、テスト、変更ファイル

検出条件、Demucsモデル/重み、Timeline v1、Audio Analyze API、Frontend Binding、Blueprint/Project/Cloud契約、データベース、認証、依存関係は変更していません。Demo1〜demo3の出力も変更していません。新しいステム/生成ファイルは既存リポジトリの`demo-assets`ルールで無視され、ローカルにのみ残ります。

- Python Island全テスト: **40件成功**。既存の`integration`マーカーに対する`PytestUnknownMarkWarning`が1件ありました。このタスクではコード/テストを変更していません。
- `mypy --strict src`、Ruff（`src tests --ignore E501`）、`git diff --check`: 成功。
- 既存の`htdemucs` CLIは正常終了し、以前の出力を上書きせず、対象専用の新しい出力ディレクトリに書き込みました。
- 4つすべてのステムでWAVの整合性、形式、有限値、ピーク、長さの確認に成功。
- 候補ファイルのJSON解析、タイムスタンプの一意性・順序・範囲、採用件数とstrengthの整列、イベント時刻とTimelineの完全一致、strength量子化差を確認。
- `git diff --check`: 成功。

追跡対象で変更した文書: このレポート、`CURRENT_STATE.md`、`OPEN_ISSUES.md`、`TEST_STRATEGY.md`、`CURRENT_TASK.md`、およびアセット管理メモの`demo-assets/source/README.md`、`demo-assets/stems/README.md`、`demo-assets/generated/README.md`。新規のローカル無視データ: WAVステム4本、Python IslandのTimeline/Summary/メタデータ、`kick-candidates-unverified.json`。
