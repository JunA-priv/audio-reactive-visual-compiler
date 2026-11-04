#!/usr/bin/env bash
# Source this file in the normal WSL2 Bash that already holds
# ARVC_LOCAL_TEST_JWT as a non-exported shell variable, then call
# arvc_step7k_37d_validate (full run) or arvc_step7k_37d_cancel_only
# (cancellation-only; avoids repeating successful inference). Neither function
# prints or writes the token.

if [[ -z "${BASH_VERSION:-}" || "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'Source this file from Bash; do not execute it as a child process.' >&2
  exit 2
fi

arvc_step7k_37d_validate() {
  local container=arvc-scnet-step37e
  local api=http://127.0.0.1:18084
  local wav="${ARVC_37D_WAV:-/tmp/arvc-step7k-37d-60s-$(id -u).wav}"
  local outdir stats_pid i

  if [[ -z "${ARVC_LOCAL_TEST_JWT:-}" ]]; then
    echo 'ARVC_LOCAL_TEST_JWT is unset or empty in this Bash shell.' >&2
    return 2
  fi
  # Keep the bearer value in this shell only. curl receives it through a
  # process-substitution config stream, never as an argv item or environment.
  export -n ARVC_LOCAL_TEST_JWT

  if [[ ! -r "$wav" ]]; then
    echo "60-second fixture is not readable: $wav" >&2
    return 2
  fi
  if ! docker inspect "$container" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
    echo "Validation container is not running: $container" >&2
    return 2
  fi

  outdir="$(mktemp -d /tmp/arvc-step7k-37d-results.XXXXXX)" || return 2
  chmod 700 "$outdir"
  echo "Evidence directory: $outdir"
  docker inspect "$container" --format \
    'state={{.State.Status}} oom_killed={{.State.OOMKilled}} memory_limit={{.HostConfig.Memory}} nano_cpus={{.HostConfig.NanoCpus}} cpu_quota={{.HostConfig.CpuQuota}} cpu_period={{.HostConfig.CpuPeriod}} ports={{json .NetworkSettings.Ports}}' \
    >"$outdir/container.txt" || return 1
  grep -q 'memory_limit=4294967296' "$outdir/container.txt" || {
    echo 'Container memory limit is not 4 GiB; stopping validation.' >&2
    cat "$outdir/container.txt"
    return 1
  }
  if ! grep -Eq 'nano_cpus=2000000000|cpu_quota=200000 cpu_period=100000' "$outdir/container.txt"; then
    echo 'Container CPU limit is not confirmed as 2 vCPU; stopping validation.' >&2
    cat "$outdir/container.txt"
    return 1
  fi

  curl --fail --silent --show-error "$api/healthz" -o /dev/null || return 1
  docker exec "$container" /usr/local/bin/python -c \
    'import urllib.request; r=urllib.request.urlopen("http://127.0.0.1:54321/auth/v1/.well-known/jwks.json", timeout=5); print("JWKS HTTP", r.status); r.close()' || return 1
  docker exec "$container" sh -c \
    'test ! -e /tmp/arvc-scnet-auth-relay.error && kill -0 "$(cat /tmp/arvc-scnet-auth-relay.pid)"' || return 1

  local no_token invalid_token
  no_token="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
    -F "audio=@$wav;type=audio/wav" "$api/api/v1/audio/analyze")" || return 1
  invalid_token="$(curl --silent --show-error -o /dev/null -w '%{http_code}' \
    -H 'Authorization: Bearer invalid' -F "audio=@$wav;type=audio/wav" \
    "$api/api/v1/audio/analyze")" || return 1
  printf 'no-token HTTP %s; invalid-token HTTP %s\n' "$no_token" "$invalid_token"
  [[ "$no_token" == 401 && "$invalid_token" == 401 ]] || return 1

  docker exec "$container" sh -c '
    for f in /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu.max; do
      if [ -r "$f" ]; then echo "--- $f"; cat "$f"; fi
    done
    if [ -r /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then
      echo "--- /sys/fs/cgroup/memory/memory.max_usage_in_bytes"; cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes
      echo "--- /sys/fs/cgroup/memory/memory.oom_control"; cat /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null || true
      echo "--- /sys/fs/cgroup/cpu/cpu.stat"; cat /sys/fs/cgroup/cpu/cpu.stat 2>/dev/null || true
    fi
  ' >"$outdir/cgroup.before.txt" || return 1
  docker stats --format 'cpu={{.CPUPerc}} memory={{.MemUsage}} pids={{.PIDs}}' "$container" \
    >"$outdir/docker-stats.txt" &
  stats_pid=$!

  for i in first second; do
    local response="$outdir/$i.json"
    local http_status
    /usr/bin/time -f "$i wall=%e s curl_maxrss=%M KiB" -o "$outdir/$i.time" \
      curl --fail --silent --show-error \
        --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") \
        --form "audio=@$wav;type=audio/wav" --output "$response" \
        --write-out '%{http_code}' "$api/api/v1/audio/analyze" >"$outdir/$i.status" || {
          kill "$stats_pid" 2>/dev/null || true
          wait "$stats_pid" 2>/dev/null || true
          return 1
        }
    http_status="$(cat "$outdir/$i.status")"
    printf '%s HTTP %s\n' "$i" "$http_status"
    [[ "$http_status" == 200 ]] || return 1
    docker exec "$container" sh -c '
      for f in /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu.max; do
        if [ -r "$f" ]; then echo "--- $f"; cat "$f"; fi
      done
      echo "--- tmp usage"; du -sk /tmp
      echo "--- request temp directories"; find /tmp -maxdepth 1 -type d -name "arvc-audio-analysis-*" -print
    ' >"$outdir/$i.cgroup.txt" || return 1
    docker top "$container" -eo pid,ppid,comm >"$outdir/$i.processes.txt" || return 1
  done
  kill "$stats_pid" 2>/dev/null || true
  wait "$stats_pid" 2>/dev/null || true

  python3 - "$outdir/first.json" "$outdir/second.json" <<'PY' || return 1
import json, math, sys

def finite(value):
    if isinstance(value, float):
        assert math.isfinite(value)
    elif isinstance(value, dict):
        for item in value.values(): finite(item)
    elif isinstance(value, list):
        for item in value: finite(item)

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as source:
        result = json.load(source, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
    timeline = result["featureTimeline"]
    assert result["musicSummary"]["analysis"]["model"] == "scnet_standard"
    assert timeline["schemaVersion"] == 1
    assert timeline["durationMs"] == 60_000 and timeline["sampleRateHz"] == 44_100
    for name in ("bassEnvelope", "drumEnergy", "vocalsEnvelope", "otherEnvelope", "musicEnergy"):
        assert len(timeline[name]) == 6_000, (name, len(timeline[name]))
    finite(result)
    print(f"{path}: HTTP 200 response; SCNet; Timeline v1; 60s; 6000 points per series; finite JSON")
PY
  cat "$outdir/first.time" "$outdir/second.time"
  echo '--- read-only container resource configuration'; cat "$outdir/container.txt"
  echo '--- after first request'; cat "$outdir/first.cgroup.txt" "$outdir/first.processes.txt"
  echo '--- after second request'; cat "$outdir/second.cgroup.txt" "$outdir/second.processes.txt"

  docker exec "$container" sh -c '
    for f in /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory.events /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu.max; do
      if [ -r "$f" ]; then echo "--- $f"; cat "$f"; fi
    done
    if [ -r /sys/fs/cgroup/memory/memory.max_usage_in_bytes ]; then
      echo "--- /sys/fs/cgroup/memory/memory.max_usage_in_bytes"; cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes
      echo "--- /sys/fs/cgroup/memory/memory.oom_control"; cat /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null || true
      echo "--- /sys/fs/cgroup/cpu/cpu.stat"; cat /sys/fs/cgroup/cpu/cpu.stat 2>/dev/null || true
    fi
    echo "--- tmp usage"; du -sk /tmp
    echo "--- request temp directories"; find /tmp -maxdepth 1 -type d -name "arvc-audio-analysis-*" -print
  ' >"$outdir/cgroup.after.txt" || return 1
  docker top "$container" -eo pid,ppid,comm >"$outdir/processes.after.txt" || return 1
  python3 - "$outdir/cgroup.after.txt" <<'PY' || return 1
import sys

sections = {}
current = None
for line in open(sys.argv[1], encoding="utf-8"):
    if line.startswith("--- "):
        current = line[4:].strip().rsplit("/", 1)[-1]
        sections[current] = []
    elif current:
        sections[current].append(line.strip())

peak = sections.get("memory.peak")
if peak:
    peak_bytes = int(peak[0])
    print(f"cgroup memory.peak={peak_bytes} bytes (4GiB cap=4294967296)")
    assert peak_bytes <= 4_294_967_296, "cgroup memory peak exceeded 4 GiB"
else:
    print("cgroup v2 memory.peak unavailable; inspect recorded v1 fallback if present")

events = dict(line.split() for line in sections.get("memory.events", []) if line)
if events:
    oom = int(events.get("oom", "0"))
    oom_kill = int(events.get("oom_kill", "0"))
    print(f"cgroup memory.events oom={oom} oom_kill={oom_kill}")
    assert oom == 0 and oom_kill == 0, "cgroup OOM event observed"
else:
    print("cgroup v2 memory.events unavailable; OOM counters require manual review")
PY
  echo '--- cgroup before'; cat "$outdir/cgroup.before.txt"
  echo '--- cgroup after (includes memory peak, OOM events, CPU throttling)'; cat "$outdir/cgroup.after.txt"
  echo '--- docker stats samples'; cat "$outdir/docker-stats.txt"
  echo '--- processes after analyses'; cat "$outdir/processes.after.txt"

  arvc_step7k_37d_cancel_only || return $?
  echo 'Evidence retained locally with mode 0700; inspect the directories shown above. No credentials are stored there.'
}

# Cancellation-only entry point. It deliberately does not repeat successful
# warm/cold analysis or change container state.
arvc_step7k_37d_cancel_only() {
  local container=arvc-scnet-step37e
  local api=http://127.0.0.1:18084
  local wav="${ARVC_37D_WAV:-/tmp/arvc-step7k-37d-60s-$(id -u).wav}"
  local outdir curl_pid curl_status i observed=0 child_remaining=1 temp_remaining=1

  if [[ -z "${ARVC_LOCAL_TEST_JWT:-}" ]]; then
    echo 'ARVC_LOCAL_TEST_JWT is unset or empty in this Bash shell.' >&2
    return 2
  fi
  export -n ARVC_LOCAL_TEST_JWT
  if [[ ! -r "$wav" ]]; then
    echo "60-second fixture is not readable: $wav" >&2
    return 2
  fi
  if ! docker inspect "$container" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
    echo "Validation container is not running: $container" >&2
    return 2
  fi
  curl --fail --silent --show-error "$api/healthz" -o /dev/null || return 1

  outdir="$(mktemp -d /tmp/arvc-step7k-37d-cancel.XXXXXX)" || return 2
  chmod 700 "$outdir"
  echo "Cancellation evidence directory: $outdir"
  docker top "$container" -eo pid,ppid,args >"$outdir/processes.before.txt" 2>"$outdir/docker-top.before.err" || {
    cat "$outdir/docker-top.before.err" >&2
    return 1
  }

  curl --max-time 10 --silent --show-error \
    --config <(printf 'header = "Authorization: Bearer %s"\n' "$ARVC_LOCAL_TEST_JWT") \
    --form "audio=@$wav;type=audio/wav" --output /dev/null \
    "$api/api/v1/audio/analyze" >"$outdir/curl.stdout" 2>"$outdir/curl.stderr" &
  curl_pid=$!

  # Identify the Analyze child by its unique request-scoped input path/CLI
  # argument. The Auth relay is also a Python process, so matching 'python'
  # alone is not evidence that Python Island started.
  for ((i = 0; i < 20; i++)); do
    if ! docker top "$container" -eo pid,ppid,args >"$outdir/processes.latest.txt" 2>"$outdir/docker-top.latest.err"; then
      kill "$curl_pid" 2>/dev/null || true
      wait "$curl_pid" 2>/dev/null || true
      cat "$outdir/docker-top.latest.err" >&2
      return 1
    fi
    if grep -Eq 'arvc-audio-analysis-[^[:space:]]+/clip\.wav|--output-dir' "$outdir/processes.latest.txt"; then
      cp "$outdir/processes.latest.txt" "$outdir/processes.during.txt"
      observed=1
      break
    fi
    kill -0 "$curl_pid" 2>/dev/null || break
    sleep 0.5
  done

  wait "$curl_pid"; curl_status=$?
  printf 'cancel request curl exit=%s (expected 28)\n' "$curl_status"
  if [[ "$curl_status" != 28 ]]; then
    echo 'The client did not time out while the analysis was running.' >&2
    return 1
  fi

  for ((i = 0; i < 40; i++)); do
    docker top "$container" -eo pid,ppid,args >"$outdir/processes.final.txt" 2>"$outdir/docker-top.final.err" || {
      cat "$outdir/docker-top.final.err" >&2
      return 1
    }
    if grep -Eq 'arvc-audio-analysis-[^[:space:]]+/clip\.wav|--output-dir' "$outdir/processes.final.txt"; then
      child_remaining=1
    else
      child_remaining=0
    fi
    docker exec "$container" sh -c 'find /tmp -maxdepth 1 -type d -name "arvc-audio-analysis-*" -print' \
      >"$outdir/temp.final.txt" || return 1
    if [[ -s "$outdir/temp.final.txt" ]]; then temp_remaining=1; else temp_remaining=0; fi
    [[ "$child_remaining" == 0 && "$temp_remaining" == 0 ]] && break
    sleep 0.5
  done

  echo '--- Python Island process during request (matched request input/output arguments)'
  if [[ "$observed" == 1 ]]; then
    cat "$outdir/processes.during.txt"
  else
    echo 'NOT OBSERVED: no process with the request-scoped clip.wav/--output-dir arguments was captured.'
  fi
  echo '--- process state after client cancellation'; cat "$outdir/processes.final.txt"
  echo '--- request temporary directories after cancellation'; cat "$outdir/temp.final.txt"

  if [[ "$observed" != 1 ]]; then
    echo 'Cancellation request timed out, but Python Island startup was not observed; not a pass.' >&2
    return 1
  fi
  if [[ "$child_remaining" != 0 || "$temp_remaining" != 0 ]]; then
    echo 'Python Island or request temp directory remains after cancellation.' >&2
    return 1
  fi
  curl --fail --silent --show-error "$api/healthz" -o /dev/null || return 1
  docker inspect "$container" --format 'container state after cancellation={{.State.Status}}' | grep -qx 'container state after cancellation=running' || return 1
  echo 'PASS: Python Island was observed, curl exited 28, child/temp directory were released, and API health stayed 200.'
}
