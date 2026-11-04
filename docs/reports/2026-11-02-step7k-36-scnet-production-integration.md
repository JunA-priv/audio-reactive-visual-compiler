# Step 7k-36 — SCNetの実行環境統合

**状態: ローカル実装と検証は完了。** Python Islandの既定エンジンをSCNet standardにしました。Demucsは任意の開発用依存関係とCLIでの明示的なengine選択を通じてのみ利用できます。デプロイ、GCP操作、GitHubへのpushは行っていません。Cloud Run検証は別途デプロイ前の作業です。

## 1. 対象範囲と判断根拠

ユーザー承認済みのengine移行を実装し、Go APIのリクエスト/レスポンス形式、Timeline v1、Blueprint、Frontend、Feature Extractor、本番用特徴量アルゴリズムは変更していません。`analysis.model`の既定値は`scnet_standard`となり、開発実行では`htdemucs`を報告する場合があります。アノテーションスキーマや学習パイプラインは追加していません。Step 7k-35の既存CPU比較と特徴量品質の結果は元の環境で得た測定値として維持し、新しい統合実行で置き換えていません。

## 2. データフロー

この変更前は、Go音声解析handlerがPython Island CLIを呼び出し、分離経路でDemucs htdemucsを読み込んで4つのstemを既存Feature Extractorに渡し、Timeline v1を出力していました。

現在は同じGo呼び出しがengine上書きなしでPython Island CLIに届くため、dispatcherがSCNet standardを選択します。検証済みのSCNet drums、bass、vocals、other配列は、変更されていないFeature Extractor、Timeline v1シリアライズ、Goレスポンスを通ります。任意のDemucsパッケージがインストールされている場合のみCLIで`--engine htdemucs`を選べます。Go APIはこの開発用選択肢を公開も設定もしません。

## 3. 実装内容

- SCNet commit `5d95bf96b19c3eede63248d171efeca8e3abb948`から推論に必要な最小限のvendoredコードを追加し、上流ライセンスと出所情報も含めました。ローカル推論adapterはCPUを明示的に使い、Accelerateによるデバイス自動選択には依存しません。
- SCNetモデル設定と正規ダイジェストを固定しました。loaderはcheckpointの正確なサイズ（42,434,545 bytes）とSHA-256（`f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`）を確認し、`torch.load(weights_only=True)`を使い、tensor形式のstate項目を要求して`strict=True`でロードします。checkpoint欠落や不一致時は明示的に失敗します。自動ダウンロードは行いません。`ARVC_SCNET_CHECKPOINT`でローカルパスを明示的に上書きできます。
- 既定のseparatorは名前付きstemを正確に4つ出力します。既存の出力変換、有限値/長さ検証、空でない出力先への上書き拒否を維持しています。推論設定はCPUを使い、今回の統合経路では2スレッド、決定論的seed 0、上流の分割推論（`segment=20`、`overlap=0.5`、`shifts=0`）です。
- Demucs実装は別モジュールに維持し、必要時に遅延importします。Demucsを基本runtime依存関係から外し、任意の`demucs-dev` extraとして残しました。通常経路で自動ダウンロードされません。
- 疑似ラベルスキーマの拡張は不要でした。解析メタデータにソースモデル/バージョン/checkpointを記録し、既存のKick検出出力は推定値と明示します。Demucs由来のラベル/特徴量は疑似データのままで、`human_verified`にはしません。学習や自動学習コードは追加していません。
- Go検証は既存JSONフィールドと型を変えずに、既知の解析モデル識別子2種類を受け付けます。任意のモデル名は許可しません。

## 4. 互換性と統合実行の測定

Pythonパイプラインは引き続きTimeline schema version 1を44.1kHzで返し、既存feature名とイベント項目を維持します。`demo-assets/source/audio-reactive-silent-demo4.mp3`から切り出した60秒音声を統合CLIで処理し、専用の`/tmp`ディレクトリのみへ書き込みました。入力は44.1kHzステレオ、2,646,000フレームです。実行により各10,584,044 bytesのステレオPCM16 stemを4つ生成し、有限値かつクリッピングなしでした。feature timelineにはbass-envelope点が6,000個含まれ、summaryは`scnet_standard`を識別しました。メタデータには固定commit/config/checkpoint、CPU、`weights_only=true`、strict state loadingを記録しました。

ローカルWSL2、Python 3.14 / PyTorch 2.14.1 CPU、2スレッドでの測定値: 分離55.468秒、feature抽出1.944秒、合計57.946秒、プロセスのピークRSS 1,438.1 MiB。これは統合スモーク測定であり、Demucs比較ではありません。Step 7k-35の独立したPython 3.12/PyTorch 2.8測定（SCNet warm 52.18秒、ピークRSS 2,149MiB、Demucs warm 47.95秒、1,418MiB）と同条件の性能として比較してはいけません。

## 5. テストと確認

- 統合テストを含むPython Island全テスト: **76件成功**。実際の小規模CPU SCNetテストでは上流PyTorchのSTFT/ISTFT矩形窓に関する想定警告が出ましたが、テストは成功しました。
- SCNet PoC `test_compare.py`: **12件成功**（PoC仮想環境のPythonで実行）。
- `mypy --strict src`: **ソース17ファイル、問題なし**。
- 変更したPython実装とテストに対するRuff: 成功。
- Ruff全体の`src tests`では既存の`features.py`、`pipeline.py`、`tests/test_features.py`にE501行長違反が14件報告されました。変更ファイルに限定したRuffでは新規違反はありません。
- `compileall`、`uv lock --locked --offline`、`git diff --check`: 成功。
- `GOCACHE`を`/tmp`に指定した`go test ./internal/audioanalysis`と`go vet ./internal/audioanalysis`: 成功。
- 上記の60秒CLI統合出力を検証。

## 6. 変更ファイル

- Python Islandのseparator振り分け、SCNet adapter/vendorコード、Demucs開発adapter、CLI、pipelineメタデータ/既定値。
- standard既定値、任意のDemucs経路指定、固定model/config/checkpoint検証、失敗経路、4 stem、Timeline互換性のPythonテスト。
- Python依存関係manifest/lock: SCNet runtime依存を基本に、Demucsを任意の開発extraに追加。
- Go音声解析summary検証テストと許可モデル識別子のみ。wire形式は不変。
- 起動/開発/runtime文書、生成物/stemのREADME案内。
- `.gitignore`でローカルSCNet checkpointアーティファクトを除外。モデル重み、ソース音声、生成stemはGitに追加していません。

## 7. Cloud Runと未完了の運用確認

ローカル60秒処理はCPU 2スレッドでピークRSS約1.4GiBを使用しました。Step 7k-35の独立SCNetベンチマークのピークは約2.1GiBでした。このローカル測定から、解析プロセス1つなら提案中の2 vCPU / 4GiBインスタンスに収まる可能性はありますが、コンテナ適合性を立証するものではありません。デプロイ前にモデルを含む実イメージ/runtime、cold startとcheckpoint検証、FFmpegデコード、Go/APIとPythonプロセス合算のメモリ、CPU quota/スロットリング、並列数1でのリクエストタイムアウトを測定してください。デプロイ成果物内のcheckpoint配置とchecksum検証も確認します。Cloud Runへのデプロイはしていません。

残るリスクは今回のローカル統合を妨げるものではなく、運用面のものです。固定checkpointを明示的に配置する必要があり、上流モデルは既知のSTFT/ISTFT警告を出します。またローカル統合はPython 3.14、従来のPoCベンチマークはPython 3.12で実施しました。実コンテナ、ブラウザー、Cloud Runでの実行経路は未検証です。この開発判断では権利関係を解決済みとして扱うようユーザーから指示されていますが、公開/デプロイは今回の対象外です。
