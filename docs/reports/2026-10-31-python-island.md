# Step 4 Python Island 実装報告

日付：2026-10-31  
状態：**partial**

## 結果

ローカルMP3/WAV入力からCPU Demucs htdemucsの4 Stemを分離し、Kick推定、Bass Envelope、Drum Energy、Music Summary、解析metadataをJSON出力するPython Islandを追加した。音源は外部送信せず、Renderer/Visual Editor/既存Frontend契約を変更していない。

Feature Timelineの必須互換部分は既存Frontendの`durationMs`、`bassEnvelope: {timeMs, value}[]`、`kickEvents: number[]`（ms）を保持する。付加項目として`kickEventStrengths`、`drumEnergy`、`featureHopMs`、正規化説明、`schemaVersion: 1`、`analysisVersion`等を出力する。Kick強度はKick時刻配列と同じ順序の別配列で、0..1の正規化値。連続値はStemごとのRMSを算出し、各feature内の全区間の95 percentileで除して0..1へclampする。時間基準は44.1kHz decode後の音源先頭からの整数ms、10ms hop（100Hz）。Frontend必須フィールドの形と単位は互換だが、正式Project/API schemaは未確定のためPython追加フィールドを正式契約とは扱わない。

Music Summaryにはduration、入力形式/codec/rate/channels/bytes、htdemucsとCPU利用、各Stem RMS、Kick推定件数、feature rateのみを記載。ジャンル/曲構造/感情などは推測しない。

## 実行環境と固定版

| 構成 | 採用/実測 |
|---|---|
| OS | Ubuntu 24.04.3 LTS on WSL2, x86_64 |
| Python | 3.14.10, project-local Astral python-build-standalone release 20261026; archive SHA256検証済み |
| uv | 0.8.12; `pyproject.toml`でrequired-version固定 |
| PyTorch | 2.14.1+cpu; CUDA unavailable、CPU only |
| Demucs | 4.1.0 |
| NumPy | 2.3.4 |
| Dev tools | pytest 9.0.3, Ruff 0.14.4, mypy 1.18.2, pip-audit 2.9.0 |
| FFmpeg / ffprobe | 6.1.1-3ubuntu5（system package、下記の未解決security制約あり） |

Python packageは`python-island/uv.lock`で61 packagesを固定し、独立した`.venv`で管理する。CPU Torch専用indexを指定し、torchaudioや音声特徴抽出libraryは追加していない。再現環境は`python-island/scripts/setup.sh`と`docs/ENVIRONMENT_SETUP.md`を参照。

pip-auditは照会可能なPyPI dependenciesについて既知脆弱性0件。local project自体と`torch 2.14.1+cpu`はPyPI audit serviceから照会できず、Torchは公式PyTorch advisoryを別途確認した。既知advisoryで2.14.1に該当するものは確認されなかった。Frontend `npm audit`は0件。これは未知脆弱性がないことを保証しない。

## Demucsモデル

- 使用model: `htdemucs`、4 outputs: drums / bass / vocals / other。
- 既存cacheのcheckpointは84,141,911 bytes、SHA256 `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`。Demucs配布URLは`https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th`。
- この作業ではmodel fileを新規downloadしていない。cache上のcheckpoint hashを検証し、設定YAMLは固定Demucs packageから一時repoに組み立てて使用。実行時のモデルconfig/weight network fetchは行わない。
- upstream maintainer説明ではDemucs codeのMIT licenseにweightsは含まれず、weightsはscientific purposesにのみ提供とされる。今回の合成音源によるローカル技術検証と、商用/公開利用の許諾は区別する。商用/公開利用前に適法なmodel licenseが必要。

## 実測

### 短尺実モデル結合テスト

2秒のローカル合成WAVをCPU htdemucsで2回分離。drums/bass/vocals/otherのshapeとfinite値を確認し、同一実行環境の2回のstem配列が完全一致した。Timeline生成にも成功。pytest integration test: 1 passed、9.69秒。外部の音源は使っていない。

### 4分性能確認

権利問題のない手元生成の4分、44.1kHz stereo PCM WAV（42,336,078 bytes、単純sine合成）を処理した。音楽品質・分離品質を評価する素材ではない。

| 計測 | 結果 |
|---|---:|
| CPU | AMD Ryzen 7 7735HS, 8 cores / 16 logical CPUs |
| PyTorch threads / device | 4 / CPU |
| 入力長 | 240.0秒 |
| Decode | 1.149秒 |
| Demucs separation | 119.223秒 |
| Feature extraction | 2.000秒 |
| Total | 122.798秒 |
| Peak process RSS | 1,698.7 MiB |
| Timeline JSON | 3,345,717 bytes |
| Music Summary JSON | 595 bytes |
| Metadata JSON | 1,416 bytes |
| 全出力 | 3,347,728 bytes |

合成sineでestimated kickは0件。これはKick精度の評価ではない。計測時metadataの初版ではmetadata自身のoutputBytesが古い長さを記録したが、生成側の自己サイズ収束処理とCLIテストを追加して修正した。上表のサイズは実ファイル`stat`値。

## 検証結果

- Python：Ruff成功、mypy成功、unit／CLI test **12件成功**、integration test **1件成功**。
- Frontend回帰: `npm ci --ignore-scripts` successful、`npm audit` 0 vulnerabilities、Vitest **14 passed**、Type Check passed、ESLint passed、Vite production build passed。
- `uv lock --check`成功。
- Python testsはWAV/MP3、space入りpath、壊れたファイル、拡張子/形式不一致、無音、長さ/サイズguard、feature抽出/有限範囲/JSON、CLI成功/失敗/上書き防止を含む。
- Real-browser/GUI操作、実画素の評価、4分より長い素材、権利確認済み音楽での品質評価は未実施。

## 未解決事項と判定

**partial**。コード・テスト・実モデル動作は完了したが、依存セキュリティと権利面に未解決事項があるため全要件を完了扱いにしない。

1. **FFmpeg:** 実測system版`6.1.1-3ubuntu5`はUbuntu 24.04の複数security noticesで修正が案内され、該当修正版はUbuntu Pro ESM packageとして示される。apt candidateも同じ未修正版で、この環境で更新できなかった。Ubuntuのsecurity noticeは特定のcrafted mediaによるDoS/code execution等を示す。一般の非信頼音源を処理する導入先としては承認できない。修正版保守パッケージ又は署名検証済みの限定FFmpeg buildを別工程で選定し、版を固定する必要がある。合成WAVでの開発・試験結果は残すが、外部ユーザーの入力へ推奨しない。
2. **Model license:** Demucs maintainerはmodel weightsはMITではなくscientific purposesのみと説明している。商用・公開・一般利用の扱いは確認未了。
3. **Public contract:** Frontend editor timelineへの互換性は確認したが、Project/API正式schema、Feature Timelineのversion policyは決定されていない。
4. **Limits:** 最大4分は本作業の初期性能対象。512MiBは既存仕様ではなく、ローカル処理の実装guardとして設定した暫定値。

対象外変更、cloud操作、push、deployは実施していない。次工程前にFFmpeg更新方法とmodel weightの利用許諾を解決し、正式Project/API timeline schemaを確定する。

## 参照一次資料

- [Python 3.14.10 release](https://www.python.org/downloads/release/python-31410/)
- [python-build-standalone 20261026](https://github.com/astral-sh/python-build-standalone/releases/tag/20261026)
- [PyTorch versions](https://pytorch.org/get-started/previous-versions/)
- [PyTorch security advisory](https://github.com/pytorch/pytorch/security/advisories/GHSA-63cw-57p8-fm3p)
- [Demucs 4.1.0](https://pypi.org/project/demucs/4.1.0/)
- [Demucs maintainer weight-license explanation](https://github.com/facebookresearch/demucs/issues/327)
- [Ubuntu USN-8671-1 FFmpeg vulnerabilities](https://ubuntu.com/security/notices/USN-8671-1)
- [Ubuntu USN-8716-1 FFmpeg vulnerabilities](https://ubuntu.com/security/notices/USN-8716-1)
- [Ubuntu USN-8915-1 FFmpeg vulnerabilities](https://ubuntu.com/security/notices/USN-8915-1)
