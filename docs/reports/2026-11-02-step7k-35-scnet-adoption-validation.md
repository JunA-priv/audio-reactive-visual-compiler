# Step 7k-35 — SCNet採用判断に必要な最小追加検証

調査日：2026-11-02  
Status：**partial — 同一マシンのCPU/RSS計測、CSV修正、既存Rendererコマンド評価を完了。対象60秒の人手確定Kick区間とSnare正解ラベル、ブラウザ画素評価が未完了のため、最終採用判断は保留。現行Demucsを維持する。**

## 1. 検証範囲

Step 7k-34で残った性能の同一条件比較、`features.csv`の欠落、既存Effectへ渡るRenderer commandの差、既存Kick annotationの対象区間適合を調査した。追加のSCNet推論は既存demo3の低音量末尾6.05秒だけ実行した。demo4の60秒ベンチマークでは各モデルを3つの新規プロセスで測定し、既存の33d比較成果物を変更・上書きしていない。低音量推論出力とベンチStemはすべて`/tmp`に保存し、Gitへ追加していない。

本番Demucs、Go API、Frontend、Timeline/Blueprint契約、特徴抽出器、本番依存関係は変更していない。デプロイ/GCP操作、外部音源取得・送信、GitHub pushも行っていない。

## 2. 実行条件

| 項目 | 共通条件または実測値 |
|---|---|
| 評価音源・区間 | `demo-assets/source/audio-reactive-silent-demo4.mp3`、43.14–103.14秒、60秒 |
| 入力信号 | ローカルデコードした同一float32、44.1kHz、stereo、2,646,000 framesのPCM配列を両separatorへ入力 |
| マシン | 同一Linuxホスト上で連続実行、CPUのみ、CUDA無効 |
| スレッド | PyTorch intra-op 2 / inter-op 1。OMP/MKL/OpenBLASも2スレッドに制限 |
| 繰返し | モデルごとに独立した3プロセス。各プロセスで初回1回、その後warm 2回。実行順を交互化 |
| SCNet | Python 3.12.11 / NumPy 1.26.4 / PyTorch 2.8.0+cu128（CUDA不可視）/ Accelerate 0.32.1。公式commit `5d95bf96b19c3eede63248d171efeca8e3abb948`、checkpoint 42,434,545 bytes / SHA-256 `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`。公式Seperator CPU経路、seed 0 |
| Demucs | Python 3.14.10 / NumPy 2.3.4 / PyTorch 2.14.1+cpu / Demucs 4.1.0。既存htdemucs checkpoint/config、CPU。`apply_model(shifts=0, split=True, overlap=.25, num_workers=0)` |

同じホスト・入力・デバイス・thread数は揃えた。隔離環境を維持するためPython/NumPy/PyTorchと推論ラッパーのバージョン・内部chunk設定は揃っていない。従って計測値はこの構成の実測であり、モデル実装だけの因果比較とは扱わない。SCNetの公式SeperatorとDemucsのproduction相当`apply_model`は分割・overlap動作も異なる。

## 3. CPU・メモリ比較

時間の範囲は3プロセス（warmは6回）の最小〜最大、中央値は中央値。CPU timeはworker processの`time.process_time()`で、そのプロセス内のCPU累積を含む。Peak RSSは各worker自身の`RUSAGE_SELF`最大値で、親や子のRSSを足した値ではない。推論は`num_workers=0`で子workerなし。SCNetのorigin/commit確認に短命git子プロセスを使うが、そのCPU/RSSはworker値に含めない。親の総wallにはその待ち時間が含まれる。どちらもPython interpreter startupより後からworker timerを開始し、初回推論を含む総worker wallと親wallを区別した。

| 指標 | Demucs htdemucs | SCNet standard |
|---|---:|---:|
| model load（3プロセス中央値） | 0.399 s（0.368–0.401） | 0.261 s（0.253–0.300） |
| 初回推論 wall | 45.74 s（44.84–47.13） | 52.27 s（51.37–54.46） |
| 初回推論 CPU | 92.67 s（90.80–95.18） | 105.57 s（103.56–109.76） |
| warm推論 wall（6回） | 47.95 s（44.83–54.32） | 52.18 s（50.86–54.39） |
| warm推論 CPU（1 inferenceあたり、6回） | 97.06 s（90.74–109.19） | 105.82 s（103.01–110.24） |
| worker総wall（load + 3推論 + stem書出し）中央値 | 142.99 s（138.42–157.56） | 159.62 s（157.62–159.96） |
| 親から見た総wall中央値 | 143.90 s（139.30–158.56） | 160.89 s（158.58–161.00） |
| Peak RSS（worker process）中央値 | 1,417.75 MiB（1,362.48–1,441.12） | 2,149.09 MiB（2,146.40–2,198.62） |
| モデルweight/checkpoint file | 84,141,911 bytes | 42,434,545 bytes |
| 4 stem出力サイズ | 各10,584,044 bytes、合計42,336,176 bytes | 同左 |

SCNetのwarm wall中央値はDemucsより約8.8%大きく、Peak RSS中央値は約51.6%大きい。weight fileは小さいが、実行時RSSは小さくならなかった。3 trialの同一モデルstemはPCM16出力で相互に同一だった。各workerの総処理はmodel load、3 inference、4 PCM16 WAV書出しを含み、MP3 decodeは共通の配列を事前生成したため除外。

別途、torch import後に隔離モデルのload範囲だけを計ったcold process 3回では、SCNet中央値0.218s（0.209–0.279）、Demucs 0.514s（0.509–2.471）だった。Demucs初回値は初回プロセス/ファイルcache影響が大きいため、モデルload優位の根拠にはしない。モデルロードだけのPeak RSSも推論時Peak RSSと比較しない。

測定資料は`/tmp/arvc-scnet-step35-benchmark/all-results.json`、`load-results.json`。これらはローカル作業記録でGit成果物ではない。

## 4. features.csv欠落の修正

既存CSVはheader + Off Kick/Snareの2行（173 bytes）で、Gate 3種と5系列の記録を欠いていた。既存の先頭8 event列の意味・順序を維持し、追加列はeventのoffset p90/max、match rate、mean、MAE、正規化MAE、Pearson、peak-time delta、comparison statusとした。CSVはGateごとにKick/Snare 2行と、Bass Envelope / Drum Energy / Vocals Envelope / Other Envelope / Music Energy 5行を出すため、常に28 data rowsとなる。seriesは同じ時間点・同じ長さであることを検証し、欠落・空・不整列・非有限値を成功値として扱わない。ゼロ分母や相関未定義は空欄とstatus/JSON nullで表す。

`comparison.json`に`featureSeriesComparisons`を加え、CSVと同じ比較関数の数値を保持する実装にした。PoCテストで全Gate/系列、CSV round-trip、イベント照合とJSON値一致、空・欠落・不整列・異常値を検証。既存33d成果物は不変。別に既存Demucs/SCNetのstemを使って再出力したCSVは28行（3,511 bytes）で、各Gate×7 recordが存在する。イベント値は元`comparison.json`と照合でき、feature数値は回帰テストでJSON/CSV共通比較結果の一致を検証した。

## 5. Timeline / Effect評価

既存Feature extractorで同一のDemucs/SCNet stemからTimelineを作り、既存Frontendの`evaluateEditorFrame`をVite SSR経由で呼び出した。600ms区間を100msごとに標本化し、実ブラウザCanvas画素ではなく描画commandを比較した。`newEditorBlueprint`の既定spectrum-bars + ink-diffusionは`music.energy`およびmix spectrum由来で、601 sample frameすべてcommandが一致した。これは当該sourceが両モデルで共通であるためで、stem由来Effectの一致を意味しない。

既存`initialEditorBlueprint` Effect設定を同一にして評価したところ、Bass Envelope差はwaveform-barsのcommand opacity総和MAE 3.019 / area総和MAE 4,231.9、oscilloscope opacity MAE 0.0975、radial-bars opacity総和MAE 5.002（最大27.232）、glow-brightness opacity総和MAE 0.140 / shadowBlur総和MAE 3.75に現れた。Kickイベントを使うpulse-scaleではMiddleのopacity MAE 0.0775、最大差0.907（イベント時刻差を反映）。

優先4特徴の影響を切り分けるため、既存Glow Effectと既存パラメータを使い、両Timelineに同じsourceを指定する感度評価も行った。Blueprint/Effect実装は変更していない。500ms間隔でのGlow command差は以下。

| source | opacity総和MAE | shadowBlur総和MAE | 読み取り |
|---|---:|---:|---|
| Bass Envelope | 0.133 | 3.582 | 中程度。Bass反応の強さ・ピーク同期が変わる |
| Drum Energy | 0.0176 | 0.382 | 小さいcommand差。イベントEffectは別途Kick/Snare差が残る |
| Vocals Envelope | 0.307 | 6.897 | 最大。ボーカル連動Opacity/glowが明確に変わる可能性 |
| Other Envelope | 0.0231 | 1.128 | 小さいcommand差 |

無音/低音量区間はdemo4内に十分な候補がなかった。demo3末尾に100ms RMS <0.001の連続1.6秒（16窓）を確認し、既存Demucs stemを再利用してSCNetを6.0535秒分離した。低音量窓で各featureのDemucs mean/maxはBass 0.000548/0.005071、Drum 0.000316/0.000543、Vocals 0.08349/0.13073、Other 0.001214/0.003992。SCNetはBass 0.000369/0.001975、Drum 0.000260/0.002011、Vocals 0.05558/0.07572、Other 0.000972/0.004655。Vocals envelopeは静かなmixでも残る。これは抽出器のclip内正規化を含む系列値であり、音量比や聴感上の誤反応そのものではない。

ローカル環境にChrome/Chromium/Firefox/Canvas raster backendがなく、実ブラウザ視覚確認・画素差分はできなかった。SSR時にVite HMR websocket bindがsandboxで拒否された警告が出たがcommand評価は完了。手動確認用には同一区間・同じBlueprint・同じEffect値のDemucs/SCNet Previewを並べ、特にVocals連動のOpacity/Glow、Bass連動のピークタイミング、低音量demo3末尾の常時反応を見る必要がある。目視成功とは扱わない。

## 6. Kick / Snare正解ラベル評価

注釈ファイル`demo-assets/generated/demo4-kick-evaluation/kick-annotations.json`はsource/stem/candidateの各hashが現在のファイルと一致した。target 43.14–103.14秒内にはcandidate review 512件（confirmed 322、rejected 183、ambiguous 7）がある。しかし、完全に再生済みで評価対象にできる`intervals`は0–12.02msの1件だけで、その外は区間完了として登録されていない。よってこのtarget区間のcandidate review状態を完成済みtruthとして採点せず、±80msのPrecision/Recall/F1やTP/FP/FNは算出しない。未確定7件も残る。`candidatePredictions`は自動推定であり正解には使用しない。

この注釈にはSnare正例がない。既存UIはKick候補をレビューし、候補外Kick/negativeを追加できるが、Snareの正解ラベル作成・一括確定機能は確認できず、今回その機能を追加していない。DemucsとSCNetの±80msイベント一致表は記述統計のままであり、accuracyではない。

次の人手作業は既存annotation UIで60秒区間43140–103140msを作り、全区間再生済みにし、7 ambiguousを解決し、候補外Kickをレビューして保存すること。自動candidate predictionsを正解に採用しない。Snareは今回のUI範囲外で正解ラベルがなく、Snare precision/recallには別途既存の承認されたlabeling手段が必要。sandboxでは過去と同様loopback bindが許されず、実ブラウザUIの操作実施は不可だった。詳細な既存UI背景は[Step 7k-24](2026-11-02-step7k-24-kick-annotation-tool.md)と[Step 7k-24a](2026-11-02-step7k-24a-annotation-ui-fixes.md)を参照。

## 7. 技術判断・Cloud Run

| 観点 | 今回の結果 |
|---|---|
| 4 Stem動作適合 | 確認済み（Step 34、今回のfresh benchmarkでもPCM16 4 stem出力） |
| Timeline接続 | 既存Feature extractor入力として動作。契約変更なし |
| Kick/Snare精度 | 未完了。demo4対象区間の完了truthがなく、Snare labelsなし |
| Envelope/Energy | 混在。Drum/Other近似、Bassに時間/強度差、Vocals command差が最大 |
| 視覚効果 | Renderer command評価のみ。実ブラウザ画素確認なし |
| CPU | この構成ではSCNet warm wall中央値が約9%長い |
| Peak RSS | SCNet中央値2.10GiB、Demucs 1.38GiB。SCNetは約52%大きい |
| Cloud Run 2 vCPU / 4GiB | 単一process実測は4GiB以内だが、SCNetが上限の約52%を使う。API/runtime/decode/concurrency余白を含むCloud適合は未確認 |
| 公開/商用利用 | 未解決。SCNet code/checkpointのMIT説明だけでMUSDB18-HQ由来重みの商用利用・配布権を決められない。評価source audioの権利も別途unknown |

**技術採用判定：判定保留。** 同条件に近いCPU試験ではSCNetに速度・メモリ上の利点は見えず、Vocals反応も大きく変わった。一方、正解ラベル評価と実ブラウザの視覚評価が未完で、置換後の検出/演出品質を確定できないため、カテゴリ判定は保留とする。これらが完了するまでDemucs htdemucsを維持し、SCNetへ移行しない。

ライセンスの公開可否は技術判定とは別に**保留**。採用時の最小変更候補はPoC separator adapter / model selection境界だけで、今回productionへ変更を加えていない。

## 8. 未完了事項と次工程

1. 既存Kick annotation UIでdemo4の60秒区間を人手で完了し、候補外Kickを含む正解データを確定する。±80msで両モデルのGate別TP/FP/FN、Precision/Recall/F1と時刻誤差を算出する。
2. Snareラベルは利用可能な既存ラベリング手段が確認できていないため、承認済みの既存手段で人手正解データを用意してから評価する。推測ラベルは作らない。
3. Demucs/SCNetの同一Blueprint Previewをブラウザで並べ、人がVocals/Bass/低音量末尾の変化を確認する。必要なら同じ範囲を既存Preview出力で保存し、人手視覚確認する。
4. 複数音源の代表性とCloud Runでの実負荷適合を確認する場合は、別途承認された範囲で再測定する。
5. MUSDB18-HQ/checkpoint/source audioの公開・商用条件を権利確認し、技術判定から独立に記録する。

今回完了したCPU測定、CSV修正と自動検証、特徴量/Renderer command調査は再実施不要。完了条件のうち人手label確定と実ブラウザ評価が残るため、全体はpartial。

## 9. 検証コマンド

- PoC `python -m unittest test_compare.py`：12 tests passed。
- Python Island `pytest -q -m 'not integration'`：76 passed、1 deselected、11 subtests passed。既存`integration` markが未登録というwarningが1件。
- `mypy --strict src`：9 source files、issueなし。
- Ruff変更対象 `tools/scnet-poc/compare.py test_compare.py`：成功。
- Ruff全体 `src tests tools/scnet-poc`：既存E501 14件。`src/python_island/features.py` 1、`pipeline.py` 4、`tests/test_features.py` 9。PoC変更ファイル由来の違反は0。
- PoC `compare.py` / `test_compare.py`：`py_compile`成功。
- `git diff --check`：成功。
- demo4 CSV：28行。8 event rowのcount/match/offsetは既存comparison.jsonと一致。
- demo3低音量CSV：28行。20 series rowsは既存Stemから再抽出したfeature seriesを独立計算した値と一致。
