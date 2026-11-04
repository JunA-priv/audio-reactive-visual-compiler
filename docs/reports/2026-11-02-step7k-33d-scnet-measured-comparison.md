# Step 7k-33d — SCNet公式checkpointによる実測評価

調査日：2026-11-02  
Status：**partial — 公式checkpointの整合性とモデル構造互換性を確認し、PoCの安全ロード経路を更新。Python 3.12依存の取得がDNS制約でできず、実推論・Demucs比較は未完了。**

## 1. 結果要約

作業ブランチは`feature/scnet-poc`。ユーザー提示の公式Google Drive再取得確認に対し、workspace内のcheckpoint実体を再計算した結果は同じSHA-256とbyte数だった。公式SCNet checkoutのoriginとcommitも指定値に一致した。

現行PyTorch環境で`weights_only=True`を指定してcheckpointを読み、公式configから生成したSCNetへ372 state entriesを`strict=True`でロードし、全key一致を確認した。PoCは固定期待hashを更新し、明示safe loadから公式`Seperator.separate_music_file`を利用する構成にした。checkpoint検証は維持している。

専用Python 3.12.11 venvは存在するが、requirementsのoffline解決に失敗し、外部indexもDNS解決できなかった。PoCの実推論を開始していないため4 Stem、Demucsとの特徴量差、CPU時間、Peak RSSは**未測定**。技術的実用性は**判定保留**とし、本番Demucsの置き換えは推奨しない。

## 2. モデルとcheckpoint

| 項目 | 実測・確認 |
|---|---|
| 公式SCNet origin | `https://github.com/starrytong/SCNet.git` |
| 公式SCNet commit | `5d95bf96b19c3eede63248d171efeca8e3abb948` |
| checkpoint path | `python-island/tools/scnet-poc/external/checkpoints/checkpoint.th` |
| byte size | 42,434,545 |
| SHA-256 | `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5` |
| 公式取得由来 | Step 7k-33dのユーザー指示でGoogle Drive公式配布物の再取得と同一性確認済み。実ファイルのdigest/sizeも指示値と一致。固定commitの[公式README](https://github.com/starrytong/SCNet/blob/5d95bf96b19c3eede63248d171efeca8e3abb948/README.md)は標準checkpointのGoogle Drive配布先を案内 |
| 第三者カードとの違い | `audiojs/scnet`の`1bc0d1…` / 42,434,986 bytesとは異なる。現行PoCはユーザーが確認した公式再取得値を固定値に採用 |

公式配布元への再接続・再取得はこの実行環境では行っていない。接続不能のため、公式取得の証跡はユーザーから提示された確認を根拠とし、ローカルファイルのSHA-256/sizeを独立に再検算した。

## 3. 安全ロード・構造互換性

公式`scnet.utils.load_model`は`torch.load`に`weights_only`を明記しないため、PoC側からその初期化関数を呼ばないようにした。PoCではSHA/size検証後に`torch.load(..., map_location="cpu", weights_only=True)`を明示し、`best_state`がtensor mappingであることを検査する。`module.` prefix処理は公式ローダー同様に行い、`load_state_dict(strict=True)`後に公式`Seperator.separate_music_file`をCPUで利用する。公式checkoutのソースファイル自体は変更していない。

互換性検査は既存Python Island環境のPyTorch `2.14.1+cpu`、Python 3.14で行った。checkpointは`best_state`のみを持ち、372個のTensor entryを含む。指定commitの`conf/config.yaml`から生成したSCNetに全key一致でロードできた。これはモデル構造・checkpoint形式の確認であり、PoC指定のPyTorch 2.8.0 / Python 3.12.11実行検証や音響品質検証ではない。

## 4. 実行環境と制約

- PoC専用環境：Python 3.12.11 `.venv`を作成済み。
- `requirements.txt`のoffline導入：失敗。最初に`accelerate==0.32.1`がuv cacheにないと報告。
- indexからの取得：`pypi.org`名前解決失敗。前Stepと同じDNS制約。
- Python Islandの本番依存・`pyproject.toml`・`uv.lock`は変更していない。
- Python 3.14 / PyTorch 2.14.1はcheckpoint構造互換性のテスト用途に限り、PoC推論環境として代用していない。
- 入力音源の送信、GCP操作、デプロイ、課金、GitHub pushなし。

## 5. 推論・Demucs比較

比較予定入力は`demo-assets/source/audio-reactive-silent-demo4.mp3`の43.14〜103.14秒。Demucs参照は既存`demo-assets/stems/demo4-kick-evaluation/{drums,bass,vocals,other}.wav`を使い、上書きしない。

| 指標 | SCNet結果 | Demucsとの比較 |
|---|---|---|
| drums / bass / vocals / other Stem | 未生成 | 未実施 |
| SR / channels / frames / time origin | 未測定 | — |
| Peak / RMS / clipping / NaN / Inf / 再合成残差 | 未測定 | — |
| Kick/Snare、Gate Off/Soft/Middle/Hard | 未測定 | 未実施 |
| Bass Envelope / Drum Energy / Vocals Envelope / Other Envelope / Music Energy | 未測定 | 未実施 |
| Precision / Recall / F1 | 未算出 | 確定人手ラベルなし |
| CSV / JSON | 今回の比較データなし | — |

## 6. 性能・実用性判定

| 指標 | 結果 |
|---|---|
| Model load time | 未測定 |
| 初回 / warm 60秒推論 | 未測定 |
| Wall time / CPU time | 未測定 |
| Peak RSS | 未測定 |
| checkpoint size | 42,434,545 bytes |
| 依存環境サイズ | 未確定（インストール未完） |
| 再実行差分 | 未測定 |
| 技術的実用性 | **判定保留** |
| 本番移行 | **推奨しない**。4 Stem/Timeline/特徴量/性能比較を完了後に再判断 |

安全ロード可能であること、state_dictが一致することだけでは音源分離品質、Timeline v1接続、Kick/Snare検出品質、Cloud Run 2 vCPU / 4 GiB適合性を証明しない。ライセンス・公開可否はStep 7k-33の別ゲートとして未解決のまま維持する。

## 7. 検証結果

| 検証 | 結果 |
|---|---|
| PoC単体テスト | 7 passed |
| Python Island tests (`not integration`) | 64 passed, 1 deselected |
| mypy | 成功、9 source files |
| Ruff（変更PoCファイル） | 成功 |
| `py_compile` | 成功 |
| 比較CLI `--help` | 成功 |
| 安全checkpoint load + strict state load | 成功。PyTorch 2.14.1+cpu / Python 3.14 |
| SCNet実推論 / 4 Stem | 未実施。Python 3.12依存の取得不可 |
| 比較JSON/CSV | 未生成 |
| `git diff --check` | 成功 |

## 8. 通常WSL2で続行する最小手順

ネットワーク利用可能な通常WSL2でリポジトリrootから実行する。音源はローカルのまま処理し、結果は`/tmp`へ出力する。

```sh
cd python-island/tools/scnet-poc
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python \
  --index-url https://download.pytorch.org/whl/cpu \
  --extra-index-url https://pypi.org/simple \
  -r requirements.txt
cd ../../..
python-island/tools/scnet-poc/.venv/bin/python \
  python-island/tools/scnet-poc/compare.py \
  --source demo-assets/source/audio-reactive-silent-demo4.mp3 \
  --demucs-stems demo-assets/stems/demo4-kick-evaluation \
  --scnet-repo python-island/tools/scnet-poc/external/SCNet \
  --checkpoint python-island/tools/scnet-poc/external/checkpoints/checkpoint.th \
  --config python-island/tools/scnet-poc/external/SCNet/conf/config.yaml \
  --output-dir /tmp/arvc-scnet-demo4-33d \
  --start-seconds 43.14 --duration-seconds 60 --threads 2
```

推論前にPoCは必ず固定SHA-256とbyte sizeを再検証する。依存導入後に生成される`comparison.json`と`features.csv`および4 Stemを使って性能・Timeline適合を判定し、本報告を更新する。

## 10. origin表記差の修正（2026-11-02）

実測比較の再開時、公式checkoutのorigin `https://github.com/starrytong/scnet.git` が`Unexpected SCNet source origin`として拒否された。原因は検証時にHTTPS URL全体を小文字化した後、`.git`なしのURLだけと比較しており、`.git`付き表記を許可していなかったこと。

PoCはGitHubホスト、所有者`starrytong`、リポジトリ`SCNet`をそれぞれ大文字・小文字を無視して照合する。HTTPS形式では`.git`接尾辞と末尾スラッシュを許可し、SSH形式の`git@github.com:owner/repo.git`も引き続き許可する。スキーム、ホスト、完全一致する所有者・リポジトリを検査し、別リポジトリ、余分なパス、偽装ホスト、HTTP、userinfo付きURLは拒否する。

checkpointの固定SHA-256・byte size検証、Git commitの記録、`weights_only=True`、tensor mapping検査、`strict=True`のstate loadは変更していない。

| 検証 | 結果 |
|---|---|
| PoC単体テスト | 9 passed（大小文字・HTTPS/SSH表記差と不正URLを追加） |
| Ruff（変更PoCファイル） | 成功 |
| `py_compile` | 成功 |
| `git diff --check` | 成功 |
| 推論・Demucs実測 | 未実施。依存環境制約は継続 |

## 9. 変更ファイル

- `python-island/tools/scnet-poc/compare.py`：確認済みSHA/sizeへ固定、PyTorch safe weights-onlyロードとstrict state loadを追加。
- `python-island/tools/scnet-poc/README.md`：確定済みcheckout/checkpointのpinと実際の配置先を反映。
- 本報告書：実測不能理由、互換性確認、続行手順を記録。

本番Demucs、Python Island依存、Go API、Frontend、Timeline/Blueprint契約に変更なし。外部ソース、checkpoint、仮想環境は`.gitignore`でGit管理対象外。
