# Step 7k-37 — SCNet Cloud Runコンテナのbuildとローカル検証

**状態: 部分完了。** コンテナ定義とローカル運用手順を用意し、既存Go-to-Python統合経路でホスト上の60秒CPU解析に成功しました。workspaceから`/var/run/docker.sock`にアクセスできずDockerイメージをbuild・起動できなかったため、イメージ固有のhealth、リソース、停止テストは未実施です。GCPへのデプロイやregistryへのpushは試みていません。

**Step 7k-37a追記:** checkpointがBuildKitのsecretサイズ上限を超えるため、初期実装に記載したBuildKit secretによる転送を置き換えました。現在のDockerfileとbuild手順では、同じサイズ/SHA-256検証を行う専用の読み取り専用Named Build Contextを使います。[Step 7k-37a](2026-11-02-step7k-37a-scnet-checkpoint-build-context.md)を参照してください。

## 1. 対象範囲と実装

Go 1.27.3でGo APIをbuildし、Python 3.14.10 CPU上にlock済みPython Island runtimeを導入するmulti-stageルート`Dockerfile`を追加しました。runtimeにはFFmpeg/ffprobe、Python Island CLI、Go APIを1つのイメージに含めます。コンテナentrypointはGoであり、引き続き子プロセスとしてPython Islandを呼び出します。独立したPythonサーバーやキューは追加していません。

イメージはUID/GID 10001で動作します。Python Islandとffprobeの絶対パス、テンポラリ領域として`/tmp`、ローカルコンテナ利用向け`PORT=8080`、`AUDIO_ANALYSIS_THREADS=2`を設定します。`PORT`指定時、Goサーバーは`0.0.0.0:$PORT`でbindします。未指定時は既存のローカル限定loopback bindを維持します。`AUDIO_ANALYSIS_THREADS`はGoプロセスで設定可能で、コンテナ外では既存値の4スレッドを既定とします。値は1〜16の範囲で検証します。

基本Python installでは`demucs-dev`を明示的に除外します。Demucsコードはリポジトリに残しますが、このイメージ設定にはパッケージも重みも含みません。音声解析は既定で無効のままです。有効化には既存のSupabase issuer/auth設定が引き続き必要で、既存の保護されたAudio Analyzeルートも変更していません。Step 7k-32レビューで特定されたfixtureモードと未認証ルートは引き続きリリース条件です。レビューが解決するまで、このイメージを公開してはいけません。

## 2. Checkpoint処理とbuild context

checkpointはDocker build contextからコピーせず、`--secret id=scnet_checkpoint`としてBuildKitに渡します。build工程で正確に42,434,545 bytesとSHA-256 `f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`を検証し、`/opt/models/scnet-standard-f8aff3bc.th`へ読み取り専用で配置します。runtimeでは`ARVC_SCNET_CHECKPOINT`をそのファイルに向けます。既存のPython runtime検証も有効で、起動時ダウンロードはありません。`.dockerignore`でローカルcache、出力、メディア、モデル重み拡張子を除外します。

既存のignore対象PoC checkpointを個別に確認し、SHA-256が一致し、`stat`で42,434,545 bytesと報告されました。オフライン推論に必要なため、このcheckpointはbuild後イメージに含まれますが、Gitやソースbuild contextには追加していません。Dockerイメージ/registry配布は今回の対象外です。

## 3. ローカルbuildとDocker runtimeの結果

Docker CLI（29.9.2）がインストールされ、Buildxもあります。最初のbuild試行では読み取り専用の`/home/raric/.docker`パスでBuildxを初期化できませんでした。タスク専用の`DOCKER_CONFIG=/tmp/arvc-docker-step37`で再試行するとdaemon確認まで進み、次のエラーで失敗しました。

```text
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
```

Docker権限やdaemon設定は変更していません。そのためDockerイメージbuild、イメージサイズ確認、コンテナ起動、`/healthz`、コンテナ内FFmpeg/version、Docker health/resource測定、コンテナ一時ファイル確認、コンテナ停止/キャンセル動作を実行できませんでした。イメージサイズ、cold start、コンテナCPU、メモリは明示的に未測定です。

## 4. ホスト統合確認（Docker測定ではない）

既存の`TestAnalyzeThroughLocalPythonIslandCPU`統合テストを、60秒の合成44.1kHzステレオPCM16入力と既存のローカルSCNet checkpointで実行しました。Go Audio Analysis handlerとPython Island CLIを通り、HTTP 200、長さ60,000ms、Timeline 6,000点を返しました。このホスト環境でhandlerログのリクエスト時間は約40.14秒、テスト実行時間は40.28秒でした。テスト用認可middlewareはテスト限定であり、アプリの認証変更や迂回ではありません。これはコンテナ測定ではなく、コンテナRSS/CPUのサンプルも取得していません。

既存Goテストではタイムアウト/キャンセル応答とリクエスト単位の一時ディレクトリ後処理も確認します。本番コードは`CommandContext`を使い、キャンセル時にPython子プロセスグループを停止し、deferされた`RemoveAll`でリクエスト作業ディレクトリを削除します。Dockerがないため、コンテナのSIGTERM動作は未検証です。

Step 7k-36のホストCLIスモーク実行では、WSL2/Python 3.14/PyTorch 2.14.1 CPUで分離55.468秒、プロセスピークRSS 1,438.1MiBを測定しました。この結果はコンテナの2-vCPU/4-GiBリソーステストの代わりにはならず、現在のDocker実測値としては報告しません。

## 5. 検証

- SCNet CPU統合を含むPython Island全テスト: **76件成功**（上流PyTorchの矩形窓警告2件）。
- Go `./cmd/server`および`./internal/audioanalysis`テスト: 成功。
- Go `go vet ./cmd/server ./internal/audioanalysis`: 成功。
- 既存の60秒Go-to-Python SCNet統合テスト: 上記のとおり成功。
- `mypy --strict src`: ソース17ファイル、問題なし。
- 変更したPython実装/テストのRuff: 成功。Ruff全体の`src tests`では`features.py`、`pipeline.py`、`tests/test_features.py`に既存のE501違反が14件あります。Step 7k-37のPython変更で新たに生じたものではありません。
- `uv lock --locked --offline`、Go formatting、`git diff --check`: 成功。
- Go全体の`go test ./...`も試しましたが、無関係な`internal/service`の`httptest.NewServer`テストが、サンドボックスでlocalhost socket bindが禁止されているためpanicしました（`listen tcp6 [::1]:0: socket: operation not permitted`）。対象を絞ったserverとaudio-analysisテストは成功しました。
- Docker build: Docker socketの権限拒否によりDockerfile実行前に阻止。

## 6. 運用とセキュリティに関する注意

`docs/CLOUD_RUN_LOCAL_CONTAINER.md`にはBuildKit secretを使うbuild、ローカル起動、health check、認可済みAnalyze設定、測定手順を記載しています。secretをbuild argsやイメージ設定に含めず、Hosted auth/database値はruntimeで渡す設計です。build時に現行Debian Bookworm package indexからFFmpegを導入しますが、イメージをbuildできなかったため、解決されたFFmpeg/ffprobeの正確なversionとpatch状態は測定できていません。リリース前にversionを記録し、最新のbase/package indexで再buildしてください。

提案中のCloud Run割り当ては引き続き2 vCPU / 4 GiB、concurrency 1、min instances 0、max instances 1です。適合性は立証されていません。Go、Python、FFmpeg、checkpoint/model buffer、`/tmp`を含め、認可済み60秒リクエスト全体のコンテナメモリを測定する必要があります。Cloud Runデプロイ前にDocker上で起動遅延、CPU quota動作、リクエストtimeout整合性、一時ストレージもテストしてください。月額¥1,000目標はbuild済みイメージや実利用量に対して再評価していません。

## 7. 次に行う最小作業

Docker daemon利用権限のあるマシンで記載のBuildKit buildを実行し、次にイメージを`--cpus=2 --memory=4g --memory-swap=4g`で起動します。60秒リクエストにはローカルで認可された有効なJWTと既存Auth issuerを使います。イメージサイズ、起動/checkpoint検証時間、解析中の`docker stats`、前後の`/tmp`使用量、レスポンスのTimeline schema/model、キャンセル後のプロセス/コンテナ停止を記録してください。Hosted公開前にStep 7k-32の公開ルート/authとfrontend-to-API routingの問題を解決してください。
