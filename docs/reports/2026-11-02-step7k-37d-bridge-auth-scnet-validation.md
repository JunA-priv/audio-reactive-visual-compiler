# Step 7k-37d — Docker bridgeでの認証付きSCNet検証

**状態: 完了 — ユーザーの通常WSL2実行報告に基づきます。** 認証付きSCNet解析、リソース制限、クライアントキャンセル時のプロセス/一時ファイルcleanupはすべて成功しました。Codexのworkspaceから`/var/run/docker.sock`にアクセスできなかったため、以下のローカルDocker実行情報はユーザー報告によるものです。Cloud Runデプロイや本番測定を主張するものではありません。

## WSL2最終結果 — 2026-11-03（ユーザー報告）

既存の`arvc-scnet-step37e`は、既存のローカルSupabase JWTを使った60秒リクエスト2件を受け付け、両方ともHTTP 200でした。1件目は62.49秒、2件目は57.43秒でした。どちらも`scnet_standard`を示し、duration 60,000ms、sample rate 44,100Hz、各連続feature系列6,000点のTimeline v1を生成しました。JSONは有効でNaN/Infはありません。2 vCPU / 4 GiB環境でのピークメモリは1,847,947,264 bytesで、OOMは報告されませんでした。解析完了後、リクエスト一時ディレクトリは残っていませんでした。

続いてPython Island PID `1805267`が稼働し、リクエスト入力が`/tmp/arvc-audio-analysis-4225982304/clip.wav`であることを確認した状態でキャンセルを検証しました。clientはcurl終了コード28を返しました。キャンセル後、該当解析Pythonプロセスと一時ディレクトリは消え、Go APIとAuth relayは稼働を継続し、`/healthz`はHTTP 200を返しました。検証スクリプトの最終結果はPASSでした。この報告にJWTや認証情報は含めていません。

このworkspaceの読み取り専用`docker ps --filter name=arvc-scnet-step37e`は再び`permission denied while trying to connect to the Docker API`で失敗しました。tokenを読み取らず、リクエストも送らず、既存コンテナも変更・停止していません。

## キャンセル観察方法の診断

Goはhandler contextをHTTPリクエスト（`context.WithTimeout(r.Context(), ...)`）に結び付け、`exec.CommandContext`でPython Islandを起動します。独立したprocess groupを設定し、キャンセル時にはgroup全体に`SIGKILL`を送るよう上書きしています（`Kill(-pid, SIGKILL)`）。deferされた`os.RemoveAll(workDir)`はrunner終了後にリクエストディレクトリをcleanupします。既存Goテストはfake runnerを使ってrequest-contextキャンセルと一時ディレクトリcleanupを確認しますが、実Docker子プロセスの終了を立証するものではありません。

以前のruntime helperは`docker top -eo comm`から`python`または`python-island`という名前のプロセスを検索していました。検証専用Auth relay自体も`/usr/local/bin/python /tmp/scnet_auth_loopback_relay.py`で起動するため、この広い条件ではrelayと解析子プロセスを区別できず、stderrも抑制されていました。これは観察方法の不備であり、以前の確認がPython Islandの起動/終了の証拠にならなかった理由です。本番実装の不具合は立証されていません。

改訂helperは`docker top -eo pid,ppid,args`からリクエスト固有CLI引数（`/tmp/arvc-audio-analysis-…/clip.wav`または`--output-dir`）を照合し、プロセス状態を記録します。curl終了コード28を必須とし、該当子プロセスとリクエストディレクトリが消えるまで待機してから、`/healthz`とコンテナ稼働状態を確認します。ユーザー報告によると、このキャンセル専用手順は上記PID/inputとPASS結果で完了しました。

対象を絞ったGoテスト`TestAnalyzeRequestCancellationCleansTemporaryDirectory`、`TestAnalyzeClientCancellationDuringUploadIsNotReportedAsInvalidAudio`、`TestAnalyzeTimeoutCleansTemporaryDirectory`は一時`/tmp` Go build cacheを使って成功しました。これらはfake runnerを使うため、Dockerでのprocess group終了を証明するものではありません。

キャンセルのみの手順では、exportされていない`ARVC_LOCAL_TEST_JWT`を保持した通常のWSL2 Bashで次のコマンドを使用しました。成功済みの初回/warm推論を再実行せず、コンテナを稼働状態に保ちます。

```bash
source scripts/run_step7k_37d_validation.sh
arvc_step7k_37d_cancel_only
```

既定では`/tmp/arvc-step7k-37d-60s-$(id -u).wav`の既存WAVを使い、または`ARVC_37D_WAV`に既存ファイルパスを指定できます。コンテナ停止/削除、Docker/Supabase設定変更、tokenのログ/成果物への書き込みは行いません。process snapshotとcurlの一般的なtimeout診断情報をmode 0700の`/tmp/arvc-step7k-37d-cancel.*`ディレクトリに保持します。合格には、curlが28で終了する前にリクエスト固有Python CLIプロセスを観測すること、終了後に該当プロセスと`arvc-audio-analysis-*`ディレクトリが存在しないこと、コンテナ稼働中にhealthがHTTP 200であることが必要です。

## 調査結果と設定

API既存の`authn.NewValidator`はローカルloopback issuer `http://127.0.0.1:54321/auth/v1`との完全一致を要求し、`/.well-known/jwks.json`を追加してJWKS URLを導出し、tokenのissuer/audience/role/expiry/subjectを検証します。JWKS hostを別設定する機能はありません。したがってbridgeコンテナから`host.docker.internal:54321`へ到達可能という観察だけでは、validatorが使うloopback JWKS URLへの到達性は確保できません。

提案するテスト専用設定ではissuerとvalidatorを変更しません。新APIコンテナはWSL loopback `127.0.0.1:18084`のみでport公開し、`PORT=8080`で動かし、コンテナ内で`scripts/scnet_auth_loopback_relay.py`を起動します。relayはAPIコンテナのnetwork namespace内で`127.0.0.1:54321`のみをbindし、TCP byteを`host.docker.internal:54321`へ転送します。request/response byteをログ出力せず、JWT/HTTP dataも変更しません。relay用portは公開しません。これはローカルテスト用の回避策であり、本番設計ではありません。

Go APIソースによると、空でない`PORT`は`0.0.0.0:$PORT`でlistenします。`AUDIO_ANALYSIS_ENABLED=true`により既存validatorを初期化し、`/api/v1/audio/analyze`を保護します。既存の`/healthz` routeは設計上、未認証のままです。アプリケーションやSupabase設定は変更していません。

## Workspaceでの実行

Read-only `docker ps` failed with:

```text
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
```

権限昇格、sudo、コンテナ操作、Docker Desktop設定変更、Supabase操作は試みていません。既存の`arvc-scnet-step37`、`step37c`、`step37d`は変更していません。daemonにアクセスできないため、それらの現在状態、`step37e`/portの空き、image/checkpoint状態、ユーザー提供リソース制限をここで再確認できませんでした。

## WSL2での実行手順

既存Docker daemonがある通常のWSL2 terminalで実行します。名前またはportが使用中なら停止し、既存リソースを置き換えないでください。WSL loopback外へは公開しません。

```sh
docker ps --format '{{.Names}} {{.Ports}}'
docker image inspect arvc-scnet:step37 --format 'size={{.Size}} id={{.Id}}'
docker inspect arvc-scnet-step37 arvc-scnet-step37c arvc-scnet-step37d \
  --format '{{.Name}} status={{.State.Status}}'
if docker inspect arvc-scnet-step37e >/dev/null 2>&1; then
  echo 'arvc-scnet-step37e already exists; choose a new unused name'; exit 1
fi
if ss -ltn '( sport = :18084 )' | tail -n +2 | grep -q .; then
  echo 'port 18084 is occupied; choose a new unused loopback port'; exit 1
fi
```

隔離APIコンテナを起動します（コンテナ作成はこの検証に限り許可されています）。

```sh
docker run --detach --name arvc-scnet-step37e --network bridge \
  --cpus=2 --memory=4294967296 --memory-swap=4294967296 \
  --publish 127.0.0.1:18084:8080 \
  --env PORT=8080 \
  --env AUDIO_ANALYSIS_ENABLED=true \
  --env AUDIO_ANALYSIS_THREADS=2 \
  --env SUPABASE_URL=http://127.0.0.1:54321 \
  --env SUPABASE_ISSUER=http://127.0.0.1:54321/auth/v1 \
  arvc-scnet:step37
curl --fail http://127.0.0.1:18084/healthz
```

relayはこのコンテナ内にのみ配置して起動します。scriptのendpoint固定は意図したもので、tokenやpayloadのログ出力はありません。`docker cp`は使い捨て検証コンテナにscriptを1つ書き込みます。イメージやイメージlayer内のrepo状態には書き込みません。

```sh
docker cp scripts/scnet_auth_loopback_relay.py arvc-scnet-step37e:/tmp/scnet_auth_loopback_relay.py
docker exec -d arvc-scnet-step37e /usr/local/bin/python /tmp/scnet_auth_loopback_relay.py
```

応答本文を表示・保存せず、実際のJWKS endpointをprobeします。200以外ならrelay/auth設定失敗として扱い、tokenを要求する前に検証を中止してください。

```sh
docker exec arvc-scnet-step37e /usr/local/bin/python -c \
  'import urllib.request; r=urllib.request.urlopen("http://127.0.0.1:54321/auth/v1/.well-known/jwks.json", timeout=5); print("JWKS HTTP", r.status); r.close()'
docker exec arvc-scnet-step37e sh -c 'test ! -e /tmp/arvc-scnet-auth-relay.error && kill -0 "$(cat /tmp/arvc-scnet-auth-relay.pid)"'
```

upstream接続に失敗すると、relayは一般的な文言`upstream connection failed`のみを`/tmp/arvc-scnet-auth-relay.error`に書いて非ゼロ終了します。上記readiness probe/checkも失敗します。request/response内容は書き込みません。

既存Go統合fixtureと同様の決定論的合成fixtureを一意な排他パスに作成します。既存ファイルを上書きしないでください。

```sh
ARVC_37D_WAV="/tmp/arvc-step7k-37d-60s-$(id -u).wav"
python3 - "$ARVC_37D_WAV" <<'PY'
import array, os, sys, wave
path = sys.argv[1]
frames = 60 * 44_100
period = array.array("h")
for frame in range(200):
    sample = int(6_000 * (frame % 200 - 100) / 100)
    period.extend((sample, sample))
samples = period * (frames // 200)
if sys.byteorder != "little": samples.byteswap()
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "wb") as output:
    with wave.open(output, "wb") as wav:
        wav.setnchannels(2); wav.setsampwidth(2); wav.setframerate(44_100)
        wav.writeframes(samples.tobytes())
assert os.stat(path).st_size == 10_584_044
print("synthetic 60-second WAV ready; bytes=10584044")
PY
```

未認証リクエストと形式不正なBearerリクエストはいずれも401を返す必要があります。成功リクエスト用に既存の期限切れでないローカルSupabase access tokenを同じBash shellで非表示入力します。Process substitutionによりcurlの引数や応答ファイルに含まれません。shell tracingを有効化したり変数を表示したりしないでください。

```sh
curl -sS -o /dev/null -w 'no-token HTTP %{http_code}\n' \
  -F "audio=@$ARVC_37D_WAV;type=audio/wav" \
  http://127.0.0.1:18084/api/v1/audio/analyze
curl -sS -o /dev/null -w 'invalid-token HTTP %{http_code}\n' \
  -H 'Authorization: Bearer invalid' \
  -F "audio=@$ARVC_37D_WAV;type=audio/wav" \
  http://127.0.0.1:18084/api/v1/audio/analyze
read -r -s -p 'Existing local Supabase access token: ' ARVC_LOCAL_TEST_JWT; printf '\n'
test -n "$ARVC_LOCAL_TEST_JWT"
```

各リクエストの前後でcgroup値を記録し、別terminalでリクエスト中の`docker stats`を連続サンプリングします。高水位指標は`memory.peak`であり、`docker stats`サンプルだけではピーク値になりません。まずv2ファイルを確認し、なければv1を確認します。

```sh
docker exec arvc-scnet-step37e sh -c 'cat /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat 2>/dev/null || true; du -sk /tmp; find /tmp -maxdepth 1 -type d -name "arvc-audio-analysis-*" -print'
docker stats --format 'cpu={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}' arvc-scnet-step37e
```

1回目と2回目の認証済み解析を別々に実施し、応答はGit管理外に保存します。次のコマンドはtokenをcurl引数に含めず、各リクエストを計測します。

```sh
ARVC_37D_FIRST_JSON="$(mktemp /tmp/arvc-step7k-37d-first.XXXXXX.json)"
ARVC_37D_SECOND_JSON="$(mktemp /tmp/arvc-step7k-37d-second.XXXXXX.json)"
/usr/bin/time -f 'first elapsed=%e s curl_maxrss=%M KiB' curl --fail --silent --show-error \
  --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") \
  --form "audio=@$ARVC_37D_WAV;type=audio/wav" --output "$ARVC_37D_FIRST_JSON" \
  http://127.0.0.1:18084/api/v1/audio/analyze
/usr/bin/time -f 'second elapsed=%e s curl_maxrss=%M KiB' curl --fail --silent --show-error \
  --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") \
  --form "audio=@$ARVC_37D_WAV;type=audio/wav" --output "$ARVC_37D_SECOND_JSON" \
  http://127.0.0.1:18084/api/v1/audio/analyze
```

レスポンス形式と数値が有限であることを検証します。

```sh
python3 - "$ARVC_37D_FIRST_JSON" "$ARVC_37D_SECOND_JSON" <<'PY'
import json, math, sys

def check(value):
    if isinstance(value, float): assert math.isfinite(value)
    elif isinstance(value, dict):
        for item in value.values(): check(item)
    elif isinstance(value, list):
        for item in value: check(item)

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as source:
        result = json.load(source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    timeline = result["featureTimeline"]
    assert result["musicSummary"]["analysis"]["model"] == "scnet_standard"
    assert timeline["schemaVersion"] == 1 and timeline["durationMs"] == 60_000
    assert timeline["sampleRateHz"] == 44_100
    for field in ("bassEnvelope", "drumEnergy", "vocalsEnvelope", "otherEnvelope", "musicEnergy"):
        assert len(timeline[field]) == 6_000, (field, len(timeline[field]))
    check(result)
    print(f"{path}: SCNet, Timeline v1, 60s/6000 points, finite JSON")
PY
```

上記のようにリクエストごとの経過時間を計測し、cgroup `cpu.stat`、`memory.peak`、`memory.events`、`/tmp`内容、前後の`docker top`も記録します。有効なtokenでのリクエストがHTTP 200以外、または応答assertionを満たさない場合、このステップは失敗です。`curl_maxrss`はcurl自身のRSSのみで、コンテナ/プロセスのピーク値ではありません。

元の1行キャンセル確認は、Python IslandとPython Auth relayを区別できないため廃止しました。このキャンセル専用追加確認では稼働中テストコンテナを停止しないでください。上記2026-11-03続編にあるプロセス引数を識別する`arvc_step7k_37d_cancel_only`手順を使い、コンテナとrelayを稼働状態に保ちます。

## 結果と残作業

| 確認項目 | 結果 |
|---|---|
| Docker bridge, JWKS, unauthenticated/invalid JWT | Passed in normal WSL2; user-reported |
| Valid JWT, two SCNet 60-second requests | HTTP 200 × 2; 62.49 s / 57.43 s; required Timeline/JSON checks passed; user-reported |
| Peak memory / OOM | 1,847,947,264 bytes; 2 vCPU / 4 GiB; no OOM; user-reported |
| Temp cleanup after completed requests | No request directory remained; user-reported |
| Client cancellation / child process | Python Island PID 1805267 observed on `/tmp/arvc-audio-analysis-4225982304/clip.wav`; curl 28; process and temp directory disappeared; user-reported |
| API and Auth relay after cancellation | Both remained running; health HTTP 200; script PASS; user-reported |
| Existing container/Supabase/API | No changes made as part of this documentation update |

通常WSL2 runtime報告に基づき、Step 7k-37dは**完了**です。これはローカルDocker検証のみであり、Cloud Run本番測定を意味しません。本番API/JWT契約は変更していません。relayは検証専用のままで、イメージには追加しません。
