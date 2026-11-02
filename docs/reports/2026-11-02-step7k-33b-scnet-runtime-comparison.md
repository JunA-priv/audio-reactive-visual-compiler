# Step 7k-33b — SCNet公式モデル取得・実測比較

調査日：2026-11-02
Status：**partial — DNS/WSL interopで取得不能。SCNetの実推論・Demucs比較は未実施。**

## 1. 結果要約

Step 7k-33の既存PoCと隔離requirementsを再利用した。公式ソース・標準checkpointを取得できず、checkpointハッシュ検証、依存環境構築、分離、特徴量比較、CPU/RSS計測へ進めなかった。ネットワーク・DNS・WSL設定を変更せず、外部音源送信やクラウド操作も行っていない。

SCNetの出力・性能を推測せず、実用性は**判定保留**とする。前工程のDemucsローカル計測値は参考値のままで、SCNetとの比較結果ではない。Step 7k-33のPoC仕様・テストとライセンス上の未解決事項は[前報告](2026-11-02-step7k-33-scnet-poc-evaluation.md)を参照。

## 2. DNS・ネットワーク切り分け

実行環境はWSL2 Linux（kernel `6.6.87.2-microsoft-standard-WSL2`）。`/etc/resolv.conf`はWSL自動生成で、nameserverは`10.255.255.254`。設定変更はしていない。

| 確認 | コマンド / 対象 | 結果 |
|---|---|---|
| DNS | `getent ahosts github.com` | アドレス応答なし |
| DNS | `getent ahosts drive.google.com` | アドレス応答なし |
| DNS | `getent ahosts raw.githubusercontent.com` | アドレス応答なし |
| Git HTTPS | `git ls-remote https://github.com/starrytong/SCNet.git HEAD` | `Could not resolve host: github.com` |
| GitHub HTTPS | `curl -I --max-time 12 https://github.com/starrytong/SCNet` | curl error 6: `Could not resolve host: github.com` |
| checkpoint HTTPS | 公式READMEのDrive URLへ`curl -I --max-time 15` | curl error 6: `Could not resolve host: drive.google.com` |
| Windows側DNSの確認 | WSLから`powershell.exe ... Resolve-DnsName github.com` | interop起動自体が`UtilBindVsockAnyPort:307: socket failed 1`で失敗 |

そのため、この実行環境からはsandboxの外にある通常WSL/Windowsネットワークとの比較ができなかった。DNS・proxy・firewall・WSL interop設定は変更していない。接続失敗がCodex sandbox固有か、WSL/ホスト側にもあるかは**切り分け未完了**である。

## 3. 公式配布物

公式READMEは標準checkpointをGoogle Driveから提供し、SCNet-largeとconfigへのリンクを別に案内している。[SCNet公式README](https://github.com/starrytong/SCNet/blob/main/README.md)

- 公式ソースclone：未取得、commit SHA未確定
- SCNet標準checkpoint：未取得。実ファイルSHA-256/size未確認
- SCNet-large：未取得・未評価
- 公式config：未取得
- Python 3.12隔離環境：作成・依存インストールなし
- 既存PoCが期待する標準checkpointのSHA-256は第三者モデルカード由来。公式配布元ハッシュとの照合ができないため、PoCは未検証ファイルをロードしない状態を維持

公式repoおよびcheckpointは実行環境から取得していない。ブラウザで公開READMEの配布先を確認できても、これはローカル取得・SHA検証・モデル実行の代替とはみなしていない。

## 4. 分離・特徴量・性能比較

今回のSCNet出力はないため、以下はすべて未測定：

- 4 stem生成、形式・長さ・原点・波形統計、clipping/NaN/Inf
- stem再合成残差、楽器間漏れ、アーティファクト
- 既存`features.py`でのKick/Snare、Gate Mode別イベント、各Envelope
- model load、初回/warm 60秒推論、CPU時間、peak RSS、環境容量、再実行差分
- Cloud Run 2 vCPU / 4 GiBへの適合性

比較対象のDemucs出力は既存ローカルデータを保持し、新しい分離結果で上書きしていない。確認済み人手正解ラベルがないため、仮にイベント比較だけできてもPrecision/Recall/F1は算出しない。

## 5. PoC検証と変更範囲

既存PoCファイルの再実装・本番コード変更は行っていない。Step 7k-33で用意した比較CLIは公式repo origin/commitとcheckpoint SHA/sizeを要求し、4 stem検証後に既存特徴量処理へ渡す設計である。

- PoC単体テスト：7 passed（Step 7k-33で確認済み）
- Python Island全テスト：65 passed（Step 7k-33で確認済み）
- mypy / Ruff / `py_compile` / CLI `--help` / whitespace check：Step 7k-33で確認済み
- 今回はネットワーク阻害を確認し、未取得モデルでの推論を試みていない

この継続工程では成果物の比較データJSON/CSVは生成されていない。`compare.py`を実行していないため、SCNet実推論の成功として扱わない。

変更ファイル：この報告書のみ。PoC・本番Python Island・Go・Frontend・Timeline/Blueprint、Demucs出力、requirements/lockは変更なし。

## 6. 次に必要な最小操作

ネットワーク設定を変えずに進めるには、利用者が通常のWSL2またはWindows環境で以下を実行し、取得物をworkspaceから読める場所に置く必要がある。

1. 通常環境から公式SCNet repoをcloneし、`git rev-parse HEAD`と`LICENSE`を記録する。
2. 公式READMEのGoogle Driveリンクから標準checkpointを取得する。
3. ファイルのサイズとSHA-256を確認し、PoCの期待値と一致するか記録する。不一致ならPoCの検証を回避せず停止して調査する。
4. 取得commit・checkpointをworkspace内またはアクセス可能なローカルパスへ配置する（Git管理には追加しない）。
5. 既存READMEの手順で専用Python 3.12環境を作り、Demo4の全体または43.14–103.14秒を実行する。

環境にファイルを持ち込めない場合は、このPoC環境でDNS/WSL interopが復旧するまで待つ。Codexの権限昇格、sandbox無効化、proxy/firewall/DNS変更を行う必要はない。

## 7. 判定

4 stem、Timeline特徴量、CPU速度、メモリの実測がないため分類は**判定保留**。SCNetの本番採用・公開推論・重み配布を推奨する根拠はない。ライセンス面のMUSDB18-HQ由来の未解決事項も、性能評価とは独立した公開ゲートとして残る。
