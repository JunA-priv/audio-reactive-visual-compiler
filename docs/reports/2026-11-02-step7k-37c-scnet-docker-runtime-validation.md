# Step 7k-37c — SCNet Docker runtime検証

**状態: 部分完了。通常のWSL2 Docker環境での実行待ちです。** このworkspaceからDockerへ接続できず、イメージ/コンテナの調査や認証付きテストの起動を行えませんでした。Docker権限は変更しておらず、sudoも使用していません。タスク記述中の値はユーザー提供値であり、ここでは再測定していません。

## Workspaceでの確認

読み取り専用の`docker ps`、`docker image inspect arvc-scnet:step37`、`docker inspect arvc-scnet-step37`、`docker info`はいずれも次のエラーで失敗します。

```text
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
```

コンテナの起動、停止、削除はしていません。環境変数や認証情報も読み取っていません。

## ここで実行したテスト

- `pytest -q tests/test_scnet_separation.py -k checkpoint`: **5件成功、4件除外**。欠落/サイズ/hashの失敗経路を確認するもので、イメージは対象外です。
- 対象を絞ったGo Audio Analysisのtimeout/cancellation/auth-rejection/temp-cleanupテスト: **成功**。コンテナ内の子プロセス停止を立証するものではありません。
- 認証あり/なしのHTTPリクエストは送信していません。

## WSL2で実行するコマンド

環境変数を表示せず既存リソースを調べます。`arvc-scnet-step37`は起動したままにしてください。

```sh
docker ps --filter name=arvc-scnet-step37 --format '{{.Names}} {{.Image}} {{.Status}} {{.Ports}}'
docker image inspect arvc-scnet:step37 --format 'size={{.Size}} id={{.Id}}'
docker inspect arvc-scnet-step37 --format 'status={{.State.Status}} user={{.Config.User}} memory={{.HostConfig.Memory}} quota={{.HostConfig.CpuQuota}} period={{.HostConfig.CpuPeriod}}'
```

Go統合fixtureと同じ決定論的な合成60秒WAVを、新しい排他的パスに作成します（既存ファイルがある場合は上書きせず失敗します）。

```sh
ARVC_37C_WAV="/tmp/arvc-step7k-37c-60s-$(id -u).wav"
python3 - "$ARVC_37C_WAV" <<'PY'
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
print("60-second fixture ready: 10,584,044 bytes")
PY
```

Auth validatorが受け付けるのは`http://127.0.0.1:54321/auth/v1`のみです。通常のWSL2 Docker Engineではhost networkingを使い、loopback issuer/JWKSをそのまま有効にします。テストAPI自体も別portでhost loopbackのみにbindします。`host.docker.internal`に変更したり、auth検証を弱めたりしないでください。host networkingが使えない場合はDocker Desktop設定を変更せず中止します。

```sh
docker inspect arvc-scnet-step37c >/dev/null 2>&1 && { echo 'test name exists; choose a new name'; exit 1; }
ss -ltn '( sport = :18081 )'
docker run --detach --name arvc-scnet-step37c --network host \
  --cpus=2 --memory=4294967296 --memory-swap=4294967296 \
  --env PORT= --env API_ADDR=127.0.0.1:18081 \
  --env AUDIO_ANALYSIS_ENABLED=true --env AUDIO_ANALYSIS_THREADS=2 \
  --env SUPABASE_URL=http://127.0.0.1:54321 \
  --env SUPABASE_ISSUER=http://127.0.0.1:54321/auth/v1 \
  arvc-scnet:step37
curl --fail http://127.0.0.1:18081/healthz
```

既存の認可済みローカルSupabaseセッションから期限切れでないJWTを、echoせず入力します。Analyze routeにはservice-role keyもanon keyも不要です。tokenは現在のshell変数に保持してcurlへpipeし、argvやファイルには置きません。

```sh
read -r -s -p 'Existing local Supabase access token: ' ARVC_LOCAL_TEST_JWT; printf '\n'
test -n "$ARVC_LOCAL_TEST_JWT"
```

tokenなしおよび不正tokenのPOSTはいずれも401を返す必要があります。

```sh
curl --silent --output /dev/null --write-out '%{http_code}\n' --form "audio=@$ARVC_37C_WAV;type=audio/wav" http://127.0.0.1:18081/api/v1/audio/analyze
curl --silent --output /dev/null --write-out '%{http_code}\n' --header 'Authorization: Bearer invalid' --form "audio=@$ARVC_37C_WAV;type=audio/wav" http://127.0.0.1:18081/api/v1/audio/analyze
```

別terminalで、1回目と2回目の認証済みリクエスト中に連続サンプリングします。

```sh
docker stats --format 'cpu={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}' arvc-scnet-step37c
```

2回実行し、レスポンスを別々に保存・計測します。Bash process substitutionを使い、JWTを引数/ファイルに保存しません。

```sh
/usr/bin/time -f 'first elapsed=%e s maxrss=%M KiB' -o /tmp/arvc-step7k-37c-first.time curl --fail --silent --show-error --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") --form "audio=@$ARVC_37C_WAV;type=audio/wav" --output /tmp/arvc-step7k-37c-first.json http://127.0.0.1:18081/api/v1/audio/analyze
/usr/bin/time -f 'second elapsed=%e s maxrss=%M KiB' -o /tmp/arvc-step7k-37c-second.time curl --fail --silent --show-error --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") --form "audio=@$ARVC_37C_WAV;type=audio/wav" --output /tmp/arvc-step7k-37c-second.json http://127.0.0.1:18081/api/v1/audio/analyze
cat /tmp/arvc-step7k-37c-first.time /tmp/arvc-step7k-37c-second.time
```

Timeline/summaryと数値を検証し、その後cgroup high-water mark、一時ファイル、プロセスを取得します。

```sh
python3 - /tmp/arvc-step7k-37c-first.json /tmp/arvc-step7k-37c-second.json <<'PY'
import json, math, sys

def check_finite(value):
    if isinstance(value, float):
        assert math.isfinite(value)
    elif isinstance(value, dict):
        for item in value.values(): check_finite(item)
    elif isinstance(value, list):
        for item in value: check_finite(item)

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as source:
        result = json.load(source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    timeline = result["featureTimeline"]
    assert result["musicSummary"]["analysis"]["model"] == "scnet_standard"
    assert timeline["schemaVersion"] == 1 and timeline["durationMs"] == 60_000
    assert timeline["sampleRateHz"] == 44_100
    for name in ("bassEnvelope", "drumEnergy", "vocalsEnvelope", "otherEnvelope", "musicEnergy"):
        assert len(timeline[name]) == 6_000, (name, len(timeline[name]))
    check_finite(result)
    print(f"{path}: SCNet, Timeline v1, 60s/6000 points, finite JSON")
PY
docker exec arvc-scnet-step37c sh -c 'for f in /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/memory.max_usage_in_bytes /sys/fs/cgroup/cpu.stat; do if [ -r "$f" ]; then echo "--- $f"; cat "$f"; fi; done; du -sk /tmp; find /tmp -maxdepth 1 -type d -name "arvc-audio-analysis-*" -print'
docker top arvc-scnet-step37c -eo pid,ppid,comm
```

クライアントキャンセルには、別terminalからclient timeoutを10秒にした認証済みリクエストをもう1件開始します。60秒解析はまだ実行中のはずです。curl timeout後にPythonが終了し、リクエスト一時ディレクトリが消えることを確認します。

```sh
curl --max-time 10 --silent --show-error \
  --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") \
  --form "audio=@$ARVC_37C_WAV;type=audio/wav" \
  --output /tmp/arvc-step7k-37c-canceled.json \
  http://127.0.0.1:18081/api/v1/audio/analyze || test "$?" -eq 28
```

このリクエストの実行中に最初のterminalから`docker top arvc-scnet-step37c -eo pid,ppid,comm`を確認し、Pythonが起動したことを確かめます。timeout後にプロセスと一時ディレクトリを再確認します。最後に新規テストコンテナのみを停止し、exit/OOM確認用に残します。

```sh
docker stop --time 10 arvc-scnet-step37c
docker inspect arvc-scnet-step37c --format 'status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}'
```

## 未検証事項

イメージ/コンテナ調査、health、Auth/JWKS到達性、JWTの401/200、60秒SCNetレスポンス、初回/warm時間、Docker CPU、cgroupピークメモリ/OOM、`/tmp` cleanup、子プロセスキャンセル、停止状態はWSL2での実行待ちです。2 vCPU / 4 GiBへの適合性は未確認です。ここでは既存コンテナ、Supabase service、Docker設定を変更していません。デプロイやpushも行っていません。
