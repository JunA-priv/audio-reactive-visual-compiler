# Step 7k-37c — Docker Desktop / WSL2のネットワーク経路調査

**結果: ソース/ネットワーク設定の変更なし。** 現在のloopback Supabase issuerを維持し、外部公開を避ける最小経路は、テストAPIコンテナをDocker Desktopのhost networkingに置き、APIをloopback bindのままとし、WSLからWindowsの`curl.exe`でリクエストする方法です。既定のNATモードではWSLネイティブの`curl`はWSL自身のloopbackを参照するため、Windows/Docker Desktopホストのlistenerに届かない理由を説明できます。

## 読み取り専用の観察結果

- Goの`resolveListenAddress`は`PORT`が空でない場合のみ`0.0.0.0:$PORT`にbindします。`PORT`が空なら`127.0.0.1:18081`を含むloopback `API_ADDR`のみ受け付けます。
- `authn.NewValidator`は`http://<loopback>/auth/v1`を要求し、JWT `iss`をその値と厳密に照合します。issuerに`/.well-known/jwks.json`を追加してJWKS URLを構成します。独立したJWKS endpoint設定はありません。
- 成功した読み取り専用の`docker inspect arvc-scnet-step37`では`network=bridge`、`status=running`、コンテナIP `172.17.0.2`でした。その後の`docker ps`は現在のsocket境界で拒否されたため、ユーザー報告のhost-network結果に関係するコンテナは特定できませんでした。コンテナは変更していません。

## ネットワーク動作と推奨

Dockerの資料によると、host networkingはDockerホストのnetwork namespaceを共有し、host/container間のTCPおよびUDP通信を可能にします。host-networkコンテナのサービスはホストから到達可能です。host modeではport publishingを無視します。Docker Desktopでは有効化した場合に4.34以降で対応しています。[Docker host network driver](https://docs.docker.com/engine/network/drivers/host/)および[Docker Desktop networking](https://docs.docker.com/desktop/features/networking/)。

Docker DesktopはLinux EngineをVM/backendの背後で実行します。別途Microsoftの資料によると、WSL2の既定NATモードではWindowsからWSLへlocalhostを転送しますが、WSLからWindows上のサーバーへ接続するにはWindows host IPを使います。mirrored modeではlocalhostの双方向通信が利用できます。[Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)。したがって報告された結果は整合しています。Docker Desktop/Windowsからは`localhost:18081`のhost-network serviceに届きますが、NAT modeのWSLからのLinux `curl http://127.0.0.1:18081`はWSL自身のloopbackを参照します。コンテナ自身のloopbackでhealthが通ることから、WSL loopbackにも到達できると推測しないでください。

**このローカルテストでの推奨:** 既存のhost-networkテストコンテナとAPI bindは変更しません。WSL shellからWSL interop経由でWindows clientを使います。

```sh
curl.exe --fail http://127.0.0.1:18081/healthz
```

TCP clientはWindows host contextで実行され、Docker Desktopが記載するhost-network localhost経路を使います。API bind、Docker/WSLネットワーク設定を変更せず、LAN interfaceへportを公開しません。Windows `curl.exe`からWSL filesystem内のWAVを読む必要がある場合は`wslpath -w "$ARVC_37C_WAV"`を使います。認証付きリクエストではJWTをcurlのstdin設定（`printf ... | curl.exe --config -`）で渡し、プロセスのコマンドラインやファイルには置きません。

まずhost-networkコンテナ自身から既存ローカルAuth JWKSに到達できることを、鍵ドキュメントを表示せず確認します。

```sh
docker exec arvc-scnet-step37c /app/python-island/.venv/bin/python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:54321/auth/v1/.well-known/jwks.json", timeout=4).status)'
```

期待値はHTTP 200です。続けてWindowsとWSLのclient経路を比較します。

```sh
curl.exe --fail --silent --show-error http://127.0.0.1:18081/healthz
curl --fail --silent --show-error http://127.0.0.1:18081/healthz
```

WSL NAT環境での期待結果は、Windows `curl.exe`がHTTP 200、Linux `curl`が失敗することです。JWKS probeが失敗した場合、コンテナのhost-network視点からWSL上のAuth endpointに到達できません。読み取り専用probeに成功するまではauth準備完了とは判断しません。issuer hostnameを変えたりSupabaseを変更したりしないでください。

## bridge + port mappingでは現状のauthを維持できない理由

port publishingによりbridgeコンテナの受信API portをDockerホストに公開できます。DockerはDockerホスト内限定にしたい公開portを`127.0.0.1`へbindするよう推奨しています。hostを指定しない場合は既定で全host interfaceで待ち受けます。[Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)および[Docker Desktop exposed ports](https://docs.docker.com/desktop/features/networking/)。

しかしbridge modeでは送信方向のJWKS経路が障害になります。bridgeコンテナ内の`127.0.0.1:54321`はコンテナ自身を指します。`SUPABASE_ISSUER`を`host.docker.internal`にすると既存のloopback限定validatorに拒否され、既存tokenの`iss`とも一致しません。`-p`は受信portのみを対応付け、コンテナloopbackをホストSupabaseへ転送しません。したがって現行実装ではbridge + port mappingだけで既存JWTを検証できません。署名issuerとJWKS取得URLを分離するにはアプリ設定/コードの変更が必要であり、この読み取り専用調査の範囲外です。

## 対象範囲と残るruntime作業

コンテナ、Docker Desktop設定、WSL設定、Supabase service、APIコード、JWT動作、firewallは変更していません。外部interfaceも公開していません。上記Windows-client health checkとコンテナからAuth JWKSへのprobeはこのサンドボックスでは実行できず、通常のWSL2 terminalでの実施が残っています。これらに成功後、既存のStep 7k-37c認可済み60秒リクエストとリソース測定を続けてください。この調査自体は推論実行やリソース測定の新たな結果を提供しません。
