# Step 7k-33 — SCNet音源分離PoC・Demucs比較評価

調査日：2026-11-02
Status：**partial — 隔離PoCと評価手順を用意。SCNetの重み・公式コードを取得できず、推論比較は未実施。**

## 1. Executive Summary

SCNetは、公開されたコードと開発者の回答上ではMIT条件で利用可能と説明されている。一方、学習に使われたMUSDB18-HQは学術目的に限定して提供され、学習済み重みへのデータ条件の影響は未解決である。したがって、公開推論・重み再配布の許諾が確定したとは扱わない。[SCNet repository](https://github.com/starrytong/SCNet), [checkpoint license clarification](https://github.com/starrytong/SCNet/issues/35), [SigSep MUSDB18 terms](https://sigsep.github.io/datasets/musdb.html)

ローカル環境では外部ホストの名前解決に失敗し、公式コードとcheckpointを取得できなかった。既存のDemucs実測値をSCNetの値に読み替えず、品質・速度・メモリ・Timeline適合性の比較結果は未取得とした。

既存Python Islandを変更せず、公式PyTorch実装を使うPoC専用requirements、比較CLI、単体テスト、実行手順を追加した。checkpointのSHA-256とバイト数を検査してからモデルをロードする。現時点の推奨は「SCNet標準モデルを隔離環境で比較する次工程へ進む。ただし本番置換・公開推論は保留」である。

## 2. 既存実装と評価条件

Python Islandの現行処理は`pipeline.py`から`separation.py`のDemucs `htdemucs` CPU分離を呼び、`features.py`で4 stemからTimeline v1を生成する。PoCはこのseparatorを変更せず、既存の特徴量抽出関数を両方のstemへ適用する。

既存のDemo4基準はStep 7k-23で生成したローカル素材である。

| 項目 | 既存Demucs基準 |
|---|---:|
| 入力 | `demo-assets/source/audio-reactive-silent-demo4.mp3` |
| 長さ / 形式 | 189.960秒、44.1kHz、stereo |
| separator | htdemucs 4.1.0、CPU、4 threads |
| 分離時間 / pipeline全体 | 89.974秒 / 96.835秒 |
| peak RSS | 1,644.5 MiB |
| stem | drums / bass / vocals / other、44.1kHz stereo PCM16 |
| 正解ラベル | 人手確認済みKickラベルなし |

これらは過去のローカル測定値であり、Cloud Run 2 vCPU / 4 GiB上の実測値ではない。Step 7k-25のOff/Soft/Middle/Hardイベント数（994/647/395/138）も候補出力数であって精度指標ではない。

## 3. SCNetライセンス・取得情報

- SCNet公式リポジトリにはMIT LICENSEが掲載され、公式推論コードはPyTorch経路を提供する。[Repository](https://github.com/starrytong/SCNet)
- SCNet開発者はIssue #35で、SCNetおよびSCNet-largeの公開済み重みはソース同様MITであり、適切な帰属表示の下でcheckpointと変換形式を再配布できると回答している。[回答](https://github.com/starrytong/SCNet/issues/35)
- ただしSCNetはMUSDB18-HQで学習されている。SigSepの説明ではMUSDB18は学術目的に限りアクセス提供され、構成トラックには個別に異なる権利条件がある。これらの条件が派生重みに及ぶかは本調査だけでは決着できない。[Dataset terms](https://sigsep.github.io/datasets/musdb.html)
- SCNet論文はMUSDB18-HQで9.0 dB SDR、およびCPU推論時間がHT-Demucsの48%と報告するが、論文ベンチマークであり、このアプリの音源・CPUでの性能値ではない。[SCNet paper](https://arxiv.org/abs/2401.13276)
- 公式READMEが参照する標準checkpointについて、第三者audiojsのモデルカードはSHA-256 `1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa`、サイズ42,434,986 bytesを記録している。これは第三者が記録した照合候補で、公式配布元によるハッシュ公表ではない。[Model card](https://huggingface.co/audiojs/scnet)
- 公式SCNet-large重みは標準モデルの比較が成立してから検討する。PoCにlarge用の取得値や性能を推定していない。
- ONNX Runtime方式は不採用。第三者ONNXモデルカードには変換元checkpoint・変換実装・独自ライセンス表示があるが、公式PyTorch checkpointとの実測出力差を確認できていない。まず公式PyTorchを基準にする。PoC依存パッケージそれぞれの配布ライセンス監査も未実施。

### 取得試行

公式GitHubの`git ls-remote`を試したが、環境のDNSで`github.com`を解決できず失敗した。Google Drive checkpointも取得していない。モデル取得・音源アップロード・クラウド操作は行っていない。よってSCNetモデル版、実際のファイルハッシュ、コードcommitは未確認である。

## 4. PoC方式と実装

公式PyTorchを比較基準に選定した。ONNXを先行採用すると第三者変換とruntime差が混ざるため、最初の切り分けとして公式推論コードが適切である。PoC専用環境はPython 3.12を想定し、`python-island/pyproject.toml`および`uv.lock`は変更していない。

追加した`python-island/tools/scnet-poc/compare.py`は以下を行う。

- 公式SCNet Git checkoutのoriginとcommitを検証し、CPU separatorを呼び出す。
- checkpointの期待SHA-256とサイズをロード前に検証する。
- Demo4と既存Demucs stemを使い、同一全区間または同一区間（43.14〜103.14秒）で比較する。
- 4 stemのサンプルレート・ch数・長さ・NaN/Inf、peak/RMS、clipping、無音窓、再合成残差を記録する。
- PCM16 stemを同じ既存Feature抽出器に渡し、Kick Gate Mode 4種のTimeline統計、Kick/Snareイベント差分、envelope比較をJSON/CSVにする。
- 初回・warm推論時間、CPU時間、peak RSS、環境サイズ、固定seed再実行差分を記録する。
- accuracy指標は出力せず、人手確認済み正解データがないことを明記する。
- 出力先が既に非空の場合は上書きを拒否する。

このCLIは実行前の評価基盤であり、まだSCNetの推論成功やstem妥当性を証明していない。

## 5. 比較結果

| 評価項目 | SCNet | Demucs | 判定 |
|---|---|---|---|
| 4 stem生成 | 未実行 | 既存Demo4で生成済み | 比較不能 |
| stem形式・長さ・原点 | 未確認 | 189.960s、44.1kHz stereo PCM16 | SCNet未確認 |
| 再合成誤差・leakage・artifact | 未測定 | 本工程で未再評価 | 比較不能 |
| Kick/Snare・Envelope | 未測定 | 既存Timelineあり | 正解ラベルも不足 |
| model load / 60秒処理時間 | 未測定 | 過去に別条件の実測あり | 比較不能 |
| peak RSS / environment size | 未測定 | Demo4のpeak RSS 1,644.5 MiB | 比較不能 |
| deterministic repeat差 | 未測定 | — | 比較不能 |

生成されたPoC出力JSON/CSVはありません。SCNetとDemucsの波形差やイベント数の優劣を推測していません。

## 6. GCP 2 vCPU / 4 GiB・費用への影響

Step 7k-32の候補構成はCloud Run Service 2 vCPU / 4 GiBであり、Demucs側のローカルピークRSSは約1.61 GiBだった。これはSCNetのRSSやCPU適合性を保証しない。今回SCNetを実測できていないため、Cloud Run適合性は判定保留である。

標準checkpointの第三者記録サイズは約42.4MBだが、実際の公式ファイルと同一か未検証である。イメージ容量、Torch等の依存環境サイズ、cold-start、Artifact Registry費用への増減はPoC実測後に再計算する。SCNetに切り替えた場合の月額費用が下がるとは結論しない。

## 7. 互換性・変更範囲

本番Demucs separator、既存Python Island API、Go、Frontend、Timeline v1、Blueprint、Project/Cloud、Gate Mode、Kick/Snare判定式は変更していない。既存アプリ依存へ追加はなく、model weightsやaudio stemsをリポジトリに追加していない。

追加ファイル：

- `python-island/tools/scnet-poc/README.md`
- `python-island/tools/scnet-poc/requirements.txt`
- `python-island/tools/scnet-poc/compare.py`
- `python-island/tools/scnet-poc/test_compare.py`
- `docs/reports/2026-11-02-step7k-33-scnet-poc-evaluation.md`

## 8. テスト・静的検証

- Python Island全テスト：**65 passed**
- PoC単体テスト：**7 passed**
- `mypy --strict src`：成功
- PoC変更対象Ruff：成功
- 既存`src tests` Ruff（E501除外）：成功
- RuffをE501除外なしで既存全体に実行：既存の未変更ファイルに14件のE501があり失敗。今回追加したPoCファイル起因ではない。
- CLI `--help`、`py_compile`：成功
- 実SCNet推論：未実施（公式source/checkpoint取得不能）

## 9. 総合判定と次工程

SCNetのライセンス根拠はコードと重みの作者回答で前進したが、MUSDB18-HQ由来の権利上の不確実性は残る。品質・CPU速度・メモリ・Timeline適合性に必要な実測がないため、Demucs代替としての分類は**判定保留**。実用候補とは判定しない。本番切替は推奨しない。

次工程では、権利レビューでローカル評価と利用範囲を確認した後、隔離Python 3.12環境に公式ソースを固定commitで取得し、公式配布元のcheckpointを入手する。PoCが検証するSHAとサイズが一致した場合だけDemo4全体および60秒区間を実行し、stem・特徴量・CPU/RSS・再現性のJSON/CSVを保存する。正解ラベルが得られた音源だけ精度指標を算出する。SCNet-largeおよび第三者ONNXは標準モデルの結果と必要性を確認してから別途評価する。

この報告の次に必要なのはローカルの音源再生・候補聴取を含む品質評価とcheckpoint権利の判断であり、公開推論・デプロイではない。

## 14. Step 7k-33b 継続結果

2026-11-02の継続確認でも`github.com`と`drive.google.com`のDNS解決に失敗し、公式repo/checkpointを取得できなかった。Windows側DNSを調べるWSL interopも`UtilBindVsockAnyPort:307: socket failed 1`で起動できず、Codex sandboxと通常WSL2/host側のネットワーク差は未確認。設定変更やハッシュ検証回避は行っていない。SCNet実測は未実施のまま、性能・品質の判定を保留する。

詳細な接続確認、ユーザー側で必要な最小取得手順、今回のテスト状況は[Step 7k-33b報告](2026-11-02-step7k-33b-scnet-runtime-comparison.md)を参照。
