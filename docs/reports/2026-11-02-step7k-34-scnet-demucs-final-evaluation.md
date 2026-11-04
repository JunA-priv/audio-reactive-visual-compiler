# Step 7k-34 — SCNet / Demucs実測結果の統合評価

調査日：2026-11-02  
Status：**partial — 60秒・demo4の実測データを統合。置換を支持する根拠はなく、技術採用は判定保留（現行Demucsを維持）。**

## 1. 結論

公式SCNet標準モデルは、指定checkpointを安全に読み込み、4 Stemを60秒・44.1kHz stereoで出力し、既存Feature extractorによるTimeline生成まで動作した。実行は決定論的に再現し、ファイル形式とTimelineの入出力適合は確認できた。

ただし、1曲の60秒区間だけのモデル間比較である。確定Kick正解ラベルはなく、検出数の一致は検出精度ではない。特にVocals EnvelopeはDemucsとの相関が低く、視覚効果の反応が変わる可能性がある。SCNetの初回/warm時間とPeak RSSは今回のローカル計測上Demucsの既存60秒測定より大きいが、実行環境・測定条件が一致しないため性能の優劣を断定できない。無音評価区間もなかった。

このため「Demucsの代替として推奨できるか」の技術判定は**判定保留**。現時点での本番置換は**推奨しない**。品質を含めた採用判定に必要な複数曲・人手確認ラベル・同一条件benchmark・無音区間/Timeline視覚評価が不足する。ライセンス上の公開可能性も別途未解決である。

## 2. 実行環境・評価条件

| 項目 | 実測・確認 |
|---|---|
| SCNet source | `starrytong/SCNet` commit `5d95bf96b19c3eede63248d171efeca8e3abb948` |
| checkpoint | 42,434,545 bytes / SHA-256 `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5` |
| Python / NumPy / PyTorch / Accelerate | 3.12.11 / 1.26.4 / 2.8.0+cu128 / 0.32.1 |
| 推論 device / threads / seed | CPU / 2 / 0 |
| 入力 | `demo-assets/source/audio-reactive-silent-demo4.mp3`、SHA-256 `4d818bb03aa231cdc1ecfaa1d1e03bb8e2bc6dc09d72478c045231291a80f043` |
| 入力区間 | 43.14–103.14秒、60.000秒、44.1kHz stereo、2,646,000 frames |
| Demucs stems | 既存`demo-assets/stems/demo4-kick-evaluation/`を再利用、再分離なし |
| SCNet stems / JSON / CSV | `/tmp/arvc-scnet-demo4-33d/`。Git管理対象外 |

PoC検証では固定checkpoint hash/sizeを照合し、`weights_only=True`で読み込み、372 Tensor entriesを`strict=True`でロードした。origin大小文字修正後、originを通過してこの実測が完了している。比較時のコード・安全検証の詳細は[Step 7k-33d報告](2026-11-02-step7k-33d-scnet-measured-comparison.md)を参照。

## 3. 成果物の整合性と4 Stem

`comparison.json`はJSONとして全体をparseでき、区間・source hash・SCNet commit/checkpoint・実行条件・モデル計時・両モデルのstem統計・4 Gate Modeのイベント照合・正解ラベル欠如理由を持つ。実行エラー記録はJSONにはなく、4 Stemと後続特徴抽出が完了している。別途stderr/logは保存されていないため、エラー履歴全般を証明するものではない。

| 検査 | Demucs | SCNet |
|---|---:|---:|
| WAV | PCM16 | PCM16 |
| Sample rate / channels | 44,100 Hz / 2 | 44,100 Hz / 2 |
| Frames / duration | 2,646,000 / 60.000 s（比較区間へcrop） | 2,646,000 / 60.000 s |
| Stem set | drums / bass / vocals / other | drums / bass / vocals / other |
| NaN / Inf | なし（読込後の有限値検証通過） | なし（読込後の有限値検証通過） |
| PCM16 clipping samples | 全stem 0 | 全stem 0 |
| 20ms完全無音window | 全stem 0 | 全stem 0 |

8 WAVはいずれも44.1kHz stereo、PCM16、60秒で、stemとmixtureのframe数は一致する。比較用timelineは各6,000点（10ms hop）で、区間内相対時刻を用いる。既存extractorへの接続は完了した。SCNetの再合成 residual RMSは0.001659（mix RMS比1.304%、peak 0.112514）、Demucsは0.003643（2.863%、peak 0.037026）。SCNetのRMS residualは小さいがpeak residualは大きい。どちらも再合成誤差だけではstem分離品質を順位付けできない。

`features.csv`は存在するものの173 bytes・headerとOffのKick/Snareの計2行だけで、Soft/Middle/Hardおよび5系列の行を欠く。`comparison.json`のGate別照合は全て存在するため、イベント評価はJSONから行った。CSVを完全なものとして扱わず、series比較は既存stemを同じextractorへ通して再計算した。今回、/tmpの比較成果物自体は修正していない。

## 4. Kick / Snare（±80ms）

「一致率」は`matched / max(Demucs件数, SCNet件数)`と定義する。括弧内は参考としてJaccard `matched / (Demucs + SCNet - matched)`。一対一照合の既定±80msを維持した。Demucsは比較対象であり正解データではない。

| Gate | Event | Demucs | SCNet | 一致 | Demucsのみ | SCNetのみ | 一致率（Jaccard） | Δ時刻中央値 / p90 / 最大 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Off | Kick | 316 | 301 | 275 | 41 | 26 | 87.0% (80.4%) | 0 / 20 / 70ms |
| Soft | Kick | 230 | 222 | 203 | 27 | 19 | 88.3% (81.5%) | 0 / 0 / 70ms |
| Middle | Kick | 137 | 127 | 115 | 22 | 12 | 83.9% (77.2%) | 0 / 0 / 70ms |
| Hard | Kick | 39 | 34 | 23 | 16 | 11 | 59.0% (46.0%) | 0 / 0 / 60ms |
| Off | Snare | 104 | 102 | 94 | 10 | 8 | 90.4% (83.9%) | 0 / 20 / 60ms |
| Soft | Snare | 104 | 102 | 94 | 10 | 8 | 90.4% (83.9%) | 0 / 20 / 60ms |
| Middle | Snare | 104 | 102 | 94 | 10 | 8 | 90.4% (83.9%) | 0 / 20 / 60ms |
| Hard | Snare | 104 | 102 | 94 | 10 | 8 | 90.4% (83.9%) | 0 / 20 / 60ms |

強い一致は二つのモデルが似たイベントを出したことを示すだけで、正しい検出を保証しない。Hard Kickではモデル間一致率が下がり、検出数も39対34へ減る。GateをまたいでSnareの集合は変わらず、Kick Gateの効果はKick検出候補に限定されている。人手ラベルは`kick-annotations.json`に0–12.02msの「Kickなし」区間が1件だけで、対象60秒を評価できない。既存評価結果もTP/FP/FN=0/null precision/recall/F1である。従ってPrecision/Recall/F1は算出しない。

## 5. Envelope / Energy

欠落していた系列値は、既存Demucs stemと/tmpのSCNet stemをPython Islandの同じ`extract_features`で再抽出した。各系列6,000点を比較。正規化差分は`MAE / Demucs系列平均絶対値`、ピーク位置は区間内の系列最大点の時刻差で定義する。

| Feature | Pearson r | MAE | 正規化MAE | 平均値 Demucs → SCNet | 最大点の時刻差 |
|---|---:|---:|---:|---:|---:|
| Bass Envelope | 0.897 | 0.1020 | 20.5% | 0.4977 → 0.4970 | +2.72s |
| Drum Energy | 0.997 | 0.0119 | 4.3% | 0.2777 → 0.2774 | +1.35s |
| Vocals Envelope | 0.405 | 0.1916 | 43.8% | 0.4379 → 0.5691 | +1.71s |
| Other Envelope | 0.922 | 0.0309 | 3.9% | 0.7898 → 0.7998 | 0ms |
| Music Energy | 1.000 | 0.0000 | 0.0% | 0.6536 → 0.6536 | 0ms |

BassとOtherの全体的な強弱・時間変化はかなり似ており、Music Energyはstemに依存しないmix由来なので完全一致する。Drum Energyも非常に近いが全体最大点は1.35秒ずれており、個別イベント位置の同期を意味しない。Vocals Envelopeは相関が弱く平均値も上がっているため、ボーカル反応でOpacity、色、規模を動かすEffectはDemucsと見た目が変わる可能性が高い。Bassのピークは2.72秒ずれており、ピーク同期の演出に差が出る可能性がある。Otherは差が小さく、大域ピークも同時刻。

無音テストとしてmixを100ms窓で測りRMS < 0.001を検索したが、該当窓は**0**。そのため無音中の不要反応は評価できていない。相関や差分は特徴量系列の比較で、描画結果そのものの視覚品質ではない。実ブラウザでのEffect画素確認も未実施。

## 6. CPU・メモリ・モデルサイズ

| 測定 | SCNet 60秒実測 | Demucs既存参考値 | 比較上の制約 |
|---|---:|---:|---|
| Model load | 4.13s | 未計測 | 同条件の値なし |
| 初回推論 wall / CPU | 53.56s / 103.31s | separator単体値なし | SCNetが2 thread。Demucs値は別報告の処理 |
| warm推論 wall / CPU | 48.91s / 98.98s | separator単体値なし | 実行環境・設定を統一していない |
| 全体処理 / CPU | 未計測 | 33.781s / CPU未記録 | Demucs値は別の60秒合成fixture。比較対象の43.14s cropではない |
| Demucs分離段階 | — | 31.610s | 合成fixtureでの過去測定 |
| Peak RSS | 2,424.7 MiB | 1,283.8 MiB | 異なる測定実行。単純な同条件比ではない |
| Model file size | checkpoint 42,434,545 bytes | 対応する実weight file値なし | Demucs checkpointサイズ未比較 |
| Python environment directory | 6,922,480,479 bytes | 対応値なし | venv全体のdisk bytesでcontainer image sizeではない |
| Repeatability | 2回のStem間max abs delta 0.0 | — | seed 0で同じprocess内比較 |

SCNet 60秒区間のwarm推論は約49秒、CPU累積約99秒、Peak RSSは約2.37GiB。先行Demucs参考値より時間・RSSが大きく見えるが、入力、環境、thread数、process計測の条件が揃っていないので性能劣位の確定値とはしない。少なくともこの一回の実測でSCNetが速いという主張は支持されない。

## 7. Cloud Run 2 vCPU / 4 GiBへの影響

SCNetの実測Peak RSS 2,424.7 MiBは4GiBより約1,671MiB少ない（約59%を消費）。ただしローカルprocess RSSとCloud Run container使用量は同じでなく、追加のAPI runtime、decode、複数request、allocator差を含めたCloud実測もない。2 vCPUに対してSCNetのthread設定は2だが、CPU累積時間がwallの約2倍になっており、連続・並列requestやcold startを含む適合性は未確認。

専用venvは約6.92GBであり配布イメージへの組込みサイズの代替測定ではない。checkpoint自体は約42.4MB。Cloud Runへのdeployや費用推定は行っていない。実採用前に最小imageの容量、起動時load、メモリ余白、request concurrency=1での60秒処理時間を対象CPU/RAM構成で計測し、4GiB OOM余裕を確認する必要がある。

## 8. Timeline適合・公開ライセンス

- **技術接続：** 同一既存Feature extractorから5系列・4 Gate Mode・Kick/Snareイベントを生成でき、60秒clipの10ms系列がそろった。Timeline生成経路への技術適合は確認。正式なProduct API/Frontendでの利用・表示確認やTimeline schemaを含む成果物の独立検査は未実施。
- **分離品質：** residualとstem統計は形式・有限値の健全性検査であり、正解分離との距離や漏れを測定していない。音源一曲で聴取比較・人手判定もない。
- **SCNetライセンス：** 公式コードLICENSEと作者のcheckpointに関するMIT説明は既報にある。一方でMUSDB18-HQの学術利用制限が学習済み重み・商用推論・出力物にどう適用されるかは未解決。
- **評価音源：** source licenseはJSON上`unknown; local evaluation only`。公開サンプルや商用処理への利用可否を確定しない。
- **公開判断：保留。** コードMIT表示だけでcheckpoint・学習データ・音源・配布物の公開権を確定できない。根拠は[Step 7k-33報告](2026-11-02-step7k-33-scnet-poc-evaluation.md)のライセンス節とその参照先。

## 9. 採否の内訳

| 観点 | 判定 |
|---|---|
| 4 Stem動作適合 | **確認** — 4 stem、PCM16/44.1kHz/stereo/60s、finite/no clipping、特徴抽出完了 |
| Kick/Snare品質 | **判定保留** — モデル間照合のみ。対象区間の人手truthなし |
| Envelope / Energy品質 | **混在** — Drum/Other/Musicは近い。Bassは差あり。Vocalsは顕著に異なる |
| CPU性能 | **判定保留** — SCNet測定あり。Demucsと同一条件比較でない。SCNet自体は60s warm約49s |
| メモリ | **判定保留** — SCNet 2,424.7MiBは測定済み。Cloud測定なし |
| Timeline v1 | **生成経路適合確認** — 5 series/Events。Product全経路・視覚受け入れ未確認 |
| 公開・商用ライセンス | **未解決** — dataset/checkpoint/source audio条件の確認が必要 |
| Demucs代替の技術採否 | **判定保留**。現時点で本番置換は**推奨しない** |

SCNet採用を再検討する場合の最小変更範囲は、独立評価の完了後にPython Islandのseparator選択/adapterだけを変更し、既存4-stem PCM16出力・Feature extractor・Timeline v1を維持すること。本番コード・依存・APIは本作業では変更していない。

## 10. 追加検証と変更範囲

採用判断を進める最低条件：

1. 複数の代表音源で同一clip・同一machine/thread/runtimeのDemucs/SCNet wall/CPU/RSS/起動比較。
2. 対象区間に対応する人手Kick/Snareラベルを十分な長さで作成し、±80ms条件で両モデルを別々に評価。Demucsをtruthにしない。
3. 無音・低音量区間を含む音源でfalse responseを比較し、Preview/WebM相当のEffectを人手で視覚確認。
4. Vocals/Bass等の差が演出に与える影響を実利用Blueprintで確認。
5. MUSDB18-HQ/checkpoint/source音源の商用推論・公開・再配布の権利を個別に確認。
6. Cloud Run相当2 vCPU/4GiBで実運用負荷を含むmemory/cold-start/latency確認（許可を得た別作業で実施）。

本Stepは既存JSON/CSV/stemsを読む評価と、既存stemsからの特徴量再計算、報告書更新だけを実施した。再推論、Stem/JSON/CSV修正、production Demucs/Python Island dependencies/Go/Frontend/Timeline仕様変更、deploy/GCP操作、GitHub pushは行っていない。
