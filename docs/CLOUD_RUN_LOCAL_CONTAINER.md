# SCNet Go/Pythonコンテナ（ローカル専用）

このイメージにはGo APIとPython Islandをまとめています。GoはPID 1として起動し、解析時に既存のPython Island CLIを子プロセスとして実行します。既定値はSCNet、CPU専用PyTorch、推論スレッド2本、`/usr/bin/ffprobe`、`/opt/models/scnet-standard-f8aff3bc.th`です。`demucs-dev`追加パッケージやDemucsの重みは含みません。`PORT`を指定するとホスト環境向けのアドレスにbindします。`PORT`がなければ、ローカル開発用にloopbackだけで待ち受けます。

## 検証済みチェックポイントを使ったビルド

Docker BuildKitが必要です。チェックポイントは通常のリポジトリコンテキストとは分けた専用named build contextとして渡します（`.dockerignore`によって通常コンテキストからモデルファイルは除外されます）。Dockerfileは読み取り専用でmountし、固定のサイズとSHA-256を検証します。両方の検査に成功した後に限り、実行イメージへ読み取り専用でインストールします。生成イメージにはチェックポイントが含まれるため、このローカル専用作業の一部としてレジストリへpushしないでください。

現在のGit対象外PoCチェックポイントは、ファイルの存在を確認してから次のように渡せます。

```sh
sha256sum python-island/tools/scnet-poc/external/checkpoints/checkpoint.th
stat -c '%s bytes' python-island/tools/scnet-poc/external/checkpoints/checkpoint.th
docker buildx build --load \
  --build-context scnet_weights=python-island/tools/scnet-poc/external/checkpoints \
  --tag arvc-scnet-local:step7k-37 .
```

期待するhashは`f8aff3bc8dd816aad392800d9d69519add719a2fbd22550af6f8cb2138d25ff5`、サイズは`42434545` bytesです。ファイルがない場合や値が一致しない場合、ビルドは失敗します。アプリも解析時に既存の検証を行い、起動時にチェックポイントをダウンロードすることはありません。

ローカルnamed contextのディレクトリはGit対象外です。named contextとBuildKitキャッシュはアクセス制御されたストレージに置いてください。最終キャッシュレイヤーにはモデルが含まれ、ビルダーが中間データやキャッシュ情報を保持する場合があります。ビルドキャッシュを公開または共有レジストリへexportしないでください。後にCloud Run用としてイメージを配布する場合は、デプロイIDと承認済み運用担当者だけがアクセスできる非公開Artifact Registryを使い、イメージタグとビルドキャッシュに明示的な保持ポリシーを設定してください。イメージやキャッシュにアクセスできる者は、チェックポイントにもアクセスできます。

## ローカル起動とhealth check

```sh
docker run --rm --name arvc-scnet-local \
  --cpus=2 --memory=4g --memory-swap=4g \
  --publish 127.0.0.1:8080:8080 \
  arvc-scnet-local:step7k-37
curl --fail http://127.0.0.1:8080/healthz
```

この起動方法では、リポジトリにある既存のローカル既定モードを使います。明示設定がなければ音声解析は無効です。認証保護された音声解析リクエストを使うには、mode 600のenvファイルを`--env-file`で渡し、`AUDIO_ANALYSIS_ENABLED=true`と既存のSupabase issuer/URL/anon key設定を指定します。従来どおり、有効な認可済みJWTを使ってください。テスト専用経路や未認証の解析経路は追加せず、秘密情報をDocker build引数に渡したりイメージへ焼き込んだりしないでください。このイメージはHosted Auth/JWT/CORS/DB接続先を設定しません。

ローカルで停止するにはCtrl-Cまたは`docker stop --time 10 arvc-scnet-local`を使います。既存APIのrequest contextは、リクエストのキャンセルまたはtimeout時にPython子プロセスグループを停止します。リクエスト単位の一時ディレクトリは、ハンドラーがどのように終了しても削除されます。Docker daemonを使う統合試験で、Docker stopとgraceful shutdownの動作を確認してください。現在のworkspaceからはDocker socketへのアクセスが拒否され、この挙動を測定できませんでした。

## Dockerが使える場合のローカル計測

実際に使ったイメージとコマンドの計測値を記録してください。Cloud Runの計測値として扱わないでください。

### テスト用コンテナから既存のローカルSupabase Authを使う

現在のGo validatorが許可するローカルissuerは`http://127.0.0.1:54321/auth/v1`だけです。bridge network上のコンテナから自分自身の`127.0.0.1`を使ってホストのSupabaseへ接続することはできず、既存validatorは`host.docker.internal`も拒否します。WSL2 Docker Engineでは、分離したテストコンテナにhost networkingを使い、`PORT`を空にして`API_ADDR=127.0.0.1:<未使用ポート>`を指定します。ホストとnetwork namespaceは共有しますが、テストAPIの待受はloopbackのままです。host networkingが利用できない場合、Docker Desktop設定を変えたり認証検証を弱めたりせず、network制約を記録して停止してください。

Docker Desktopのhost-network listenerはWindowsホスト側のnetwork経路に公開されます。WSL2の既定NATでは、WSL内で実行するLinuxの`curl 127.0.0.1:<port>`はWSL自身のloopbackへ接続します。WindowsとWSLのlocalhostが双方向になるのはmirrored networkingの場合だけです。コンテナ内のAPIがhealthyでもWSLのcurlが失敗する場合は、WSL shellからWindows clientを使って確認します：`curl.exe --fail http://127.0.0.1:<port>/healthz`。この境界を回避するためにコンテナのbindを広げたり全interfaceへpublishしたりしないでください。現在のvalidatorはJWT issuerとJWKS取得URLを結び付け、loopback issuerだけを許可するため、bridgeとport mappingでもAuthのJWKS経路は解決しません。詳しくは[Step 7k-37c network investigation](reports/2026-11-02-step7k-37c-docker-desktop-network-investigation.md)を参照してください。

既存の`arvc-scnet-step37`コンテナは起動したままにしてください。別のテスト名とportを使い、`--cpus=2 --memory=4g --memory-swap=4g`も指定します。音声解析では、`AUDIO_ANALYSIS_ENABLED=true`、`AUDIO_ANALYSIS_THREADS=2`、2つのloopback Supabase URLを設定します。このrouteは実際のローカルJWTをAuth JWKSで検証します。テストコンテナへservice-role keyやanon keyを渡す必要はありません。

```sh
docker image inspect arvc-scnet-local:step7k-37 --format '{{.Size}}'
docker run --detach --name arvc-scnet-local \
  --cpus=2 --memory=4g --memory-swap=4g \
  --env-file /secure/local-arvc-container.env \
  --publish 127.0.0.1:8080:8080 arvc-scnet-local:step7k-37
```

別のterminalで、認可済み60秒Analyze requestの所要時間と、処理中のusageを計測します。

```sh
/usr/bin/time -v curl --fail --silent --show-error \
  --header "Authorization: Bearer $ARVC_LOCAL_TEST_JWT" \
  --form 'audio=@/secure/authorized-60s-clip.wav;type=audio/wav' \
  --output /tmp/arvc-analysis-response.json \
  http://127.0.0.1:8080/api/v1/audio/analyze
docker stats --no-stream arvc-scnet-local
docker exec arvc-scnet-local sh -c 'du -sh /tmp; find /tmp -maxdepth 1 -type d -name "arvc-audio-analysis-*" -print'
docker stop --time 10 arvc-scnet-local
```

JWTを表示しないshell quotingを使ってください。推論中に3つ目のterminalから`docker stats`を繰り返し実行します。リクエスト後の1回の計測だけではコンテナのpeak memoryを確認できません。Goの応答にTimeline `schemaVersion: 1`が含まれ、summaryのmodelが`scnet_standard`であることを確認します。完了後またはキャンセル後に`find`がrequest directoryを返さないことも確認してください。起動・readinessに関するログは確認してかまいませんが、音声、checkpointの内容、認証情報を記録してはいけません。

## Cloud Run設定のメモ（未デプロイ）

候補値はvCPU 2、memory 4 GiB、concurrency 1、最小instance 0、最大instance 1です。Cloud Runは`PORT`を設定し、serverは`0.0.0.0:$PORT`でbindします。この割り当てでは`AUDIO_ANALYSIS_THREADS=2`を設定してください。`/healthz`を使う明示的なstartup probeを設定し、request timeoutは既存のAPI解析timeout 600秒より長くしてください。ローカルイメージの既定`BLUEPRINT_MODE=fixture`をHosted環境向けのsecurity approvalと見なしてはいけません。Step 7k-32のroute authenticationとPages-to-API routingは、引き続きrelease reviewが必要です。未解決事項が片付くまでserviceを公開しないでください。

ローカルイメージサイズ、cold start、認可済み実API request、コンテナmemory/CPU、一時storage、stop動作は、workspaceからDocker daemonへアクセスできるまで未計測です。Cloud RunのCPU割り当て、cold start、scaling、課金、network動作には別途承認済みdeployment検証が必要です。[Step 7k-32 architecture/cost validation](reports/2026-11-02-step7k-32-gcp-architecture-cost-validation.md)を参照してください。
