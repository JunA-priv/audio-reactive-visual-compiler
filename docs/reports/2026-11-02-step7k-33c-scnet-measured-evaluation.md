# Step 7k-33c — SCNet実測比較・実用性判定

調査日：2026-11-02  
Status：**partial — checkpointの同一性を検証できず、安全条件に従って推論を停止。SCNet対Demucsの実測比較は未完了。**

## 1. 結果要約

指定ブランチ`feature/scnet-poc`で作業を開始した。公式SCNet checkoutのoriginとcommitは確定事項に一致した。一方、配置済みcheckpointの実サイズとSHA-256はPoCおよび第三者モデルカード由来の照合候補の双方と一致しなかった。公開検索でも実hashを特定できず、別モデル・別版か、転送破損かは確定できない。PoCの検証を無効化せず、checkpointをロードしなかった。

このため4 Stem生成、既存Demucsとの特徴量比較、CPU時間/RSS、再実行差分は未測定。技術的実用性は**判定保留**、本番移行は**推奨しない**。分離品質・Kick/Snare品質について優劣を主張しない。

## 2. 実行前確認

| 項目 | 実測 |
|---|---|
| 作業ブランチ | `feature/scnet-poc` |
| 開始時git status | `?? python-island/tools/scnet-poc/external/`のみ |
| SCNet origin | `https://github.com/starrytong/SCNet.git` |
| SCNet commit | `5d95bf96b19c3eede63248d171efeca8e3abb948`（指定値一致） |
| checkpoint path | `python-island/tools/scnet-poc/external/checkpoints/checkpoint.th` |
| checkpoint実サイズ | 42,434,545 bytes |
| checkpoint SHA-256 | `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5` |
| PoC/モデルカード照合値 | 42,434,986 bytes / `1bc0d1abb20bfdf966dcd07637bafd03e4bc13653d09ef18bc9b3e342eafe2aa` |
| 差 | サイズ -441 bytes、SHA-256不一致 |

`file`ではPyTorchが読めるzip archive形式、archive内に374 memberを確認した。ただし形式が読めることはモデル同一性や正常性の証明にならない。checkpointは公式READMEの標準名`checkpoint.th`で置かれていたが、その配置だけから取得元を確認できる記録はなかった。

期待hashは第三者の`audiojs/scnet`モデルカードが標準checkpointとして掲げる値で、SCNet公式READMEは同じDrive上の標準checkpointを案内する。実ファイルはどちらにも一致しない。現在の検索では実ファイルhashの公開記録を発見できず、このhashからモデル版・学習元・変換工程を特定できなかった。[公式SCNet README](https://github.com/starrytong/SCNet), [標準checkpointの照合記録](https://huggingface.co/audiojs/scnet)

## 3. 隔離実行環境

- Python 3.12.11を確認し、PoC専用`python-island/tools/scnet-poc/.venv`を作成した。
- `requirements.txt`によるインストールは`pypi.org`のDNS解決失敗で終了。PoC用venvへ必要な依存は導入されていない。
- 公式PyTorch推論は実行していない。既存Python Islandの本番依存・lockfileは変更していない。
- 一度システムPython 3.12でPoCテストを試したがNumPyがなく起動できなかった。その後、テストのみ既存Python Island環境で実行した。実推論環境として流用していない。
- 外部音源送信、GCP操作、デプロイ、課金、Git pushなし。

## 4. SCNet推論・Demucs比較

| 評価項目 | 結果 |
|---|---|
| SCNet 4 Stem（drums/bass/vocals/other） | 未実施。checkpoint検証不一致のためロードせず |
| sample rate / channels / frames / time origin | 未測定 |
| Peak / RMS / clipping / NaN / Inf | 未測定 |
| 再合成残差 | 未測定 |
| Demucsとのstem比較 | 未実施。既存Demucs出力は保持 |
| Kick/Snareイベント、Gate Off/Soft/Middle/Hard | 未測定 |
| Bass Envelope / Drum Energy / Vocals Envelope / Other Envelope / Music Energy | 未測定 |
| Precision / Recall / F1 | 未算出。人手確定ラベルなし |
| JSON/CSV実測データ | 生成なし |

データがないためSCNet stemがTimeline v1へ接続可能か確認できていない。Demucs stemをGround Truthとした品質評価は行っていない。

## 5. CPU・メモリ・コスト適合

| 指標 | SCNet実測 |
|---|---:|
| Model load | 未測定 |
| 初回 / warm推論（60秒） | 未測定 |
| 60秒総処理時間 / CPU time | 未測定 |
| Peak RSS | 未測定 |
| checkpoint / 依存環境サイズ | checkpointは上記実測値のみ。依存環境は未構築 |
| 再実行差分 | 未測定 |

Cloud Run 2 vCPU / 4 GiB適合性はローカル実測がないため評価できない。Cloud Run実測とは扱わない。月額1,000円以内の要件についても、SCNetの処理時間・イメージサイズが不明なので見込みを更新できない。

## 6. ライセンスと実用性判定

SCNetコードと重みのライセンス根拠、およびMUSDB由来重みに関する未解決事項はStep 7k-33報告の記載を維持する。今回のcheckpoint実体が期待された標準checkpointと同一か確認できないため、そのライセンス説明を本ファイルに適用できるかも未確認。公開・再配布の可否は技術的評価から独立して未解決である。

| 判断基準 | 判定 |
|---|---|
| 正常な4 Stem生成 | 未確認 |
| Timeline v1接続 | 未確認 |
| Kick/Snare特徴量生成 | 未確認 |
| 分離品質 | 未評価 |
| CPU時間・Peak RSS | 未測定 |
| Demucsとの差の説明 | 比較データなし |
| 技術的実用性 | **判定保留** |
| 本実装への移行 | **推奨しない**。比較完了後に再判断 |
| 公開・checkpoint配布 | **未承認・未解決** |

## 7. テスト・静的検査

| 検証 | 結果 |
|---|---|
| PoC単体テスト | 7 passed（Python Island既存venvでtest-only実行） |
| Python Island既存テスト | 64 passed, 1 deselected（`not integration`） |
| mypy | 成功、9 source files |
| Ruff | Python Island全体で既存E501 14件、今回のPoC変更なし |
| PoC実推論 / 4 Stem検査 | 未実施。checkpoint検証不一致 |
| 比較JSON/CSV | 未生成 |
| `git diff --check` | 成功 |

RuffをPython Island全体で実行し、既存E501 14件を確認した。内訳は`src/python_island/features.py:377`、`src/python_island/pipeline.py:28,80,81,111`、`tests/test_features.py:201,207,215,221,227,230,243,244,267`。今回のPoCファイルの違反は0件。

## 8. Git管理と変更範囲

`.gitignore`へ`python-island/tools/scnet-poc/external/`を追加し、公式checkoutおよびcheckpointをGit管理対象外にした。比較PoC、本番Demucs、Go API、Frontend、Timeline/Blueprint契約、production dependenciesは変更していない。生成音源やstemは作成していない。

## 9. 次に必要な最小操作

1. checkpointの取得元を記録できる形で確認し、公式README記載のGoogle Drive配布物を再取得する。
2. 再取得物のサイズ42,434,986 bytesとSHA-256 `1bc0d1…`をPoCを実行せずに確認する。不一致が続けば提供者・版・変換元を特定できるまで停止する。期待値の更新や検証回避はしない。
3. ネットワーク利用可能な環境でPoC専用Python 3.12依存を導入し、READMEの既存Demucs stemと同じ43.14–103.14秒区間を比較する。
4. 実測後にJSON/CSV、実用性、Cloud Run適合見込みを別途更新する。
