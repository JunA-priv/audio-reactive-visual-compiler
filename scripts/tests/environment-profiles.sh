#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOCK_BIN="$(mktemp -d)"
trap 'rm -rf "$MOCK_BIN"' EXIT
cat > "$MOCK_BIN/curl" <<'MOCK'
#!/usr/bin/env bash
exit "${MOCK_CURL_STATUS:-0}"
MOCK
cat > "$MOCK_BIN/ss" <<'MOCK'
#!/usr/bin/env bash
[[ "${MOCK_SS_FAIL:-0}" == 1 ]] && exit 1
last="${!#}"
port="${last##*:}"
if [[ "${MOCK_SS_PORT:-}" == "$port" ]]; then
  printf 'LISTEN 0 128 127.0.0.1:%s 0.0.0.0:*\n' "$port"
fi
MOCK
chmod +x "$MOCK_BIN/curl" "$MOCK_BIN/ss"
PATH_FOR_TEST="$MOCK_BIN:$PATH"

run_profile() {
  local -a overrides=()
  while [[ "${1:-}" != -- ]]; do
    [[ $# -gt 0 ]] || { printf 'run_profile needs -- before profile/action\n' >&2; return 2; }
    overrides+=("$1")
    shift
  done
  shift
  /usr/bin/env -i PATH="$PATH_FOR_TEST" HOME="${HOME:-/tmp}" VITE_SUPABASE_ANON_KEY=test-local-anon-key "${overrides[@]}" "$ROOT/scripts/arvc.sh" "$@"
}
expect_fail() {
  if run_profile "$@" >/dev/null 2>&1; then
    printf 'Expected safe failure, but command succeeded: %s\n' "$*" >&2
    exit 1
  fi
}

bash -n "$ROOT/scripts/arvc.sh"
bash -n "$ROOT/api/run-local.sh"
bash -n "$ROOT/scripts/tests/environment-profiles.sh"

# Verify api/.env supplies missing values, while even an explicit empty process value wins.
LOCAL_API_TEST="$(mktemp -d)"
trap 'rm -rf "$MOCK_BIN" "$LOCAL_API_TEST"' EXIT
mkdir -p "$LOCAL_API_TEST/api" "$LOCAL_API_TEST/bin"
cp "$ROOT/api/run-local.sh" "$LOCAL_API_TEST/api/run-local.sh"
cat > "$LOCAL_API_TEST/api/.env" <<'ENV'
OVERRIDE=from-file
FILE_ONLY=from-file
ENV
cat > "$LOCAL_API_TEST/bin/go" <<'MOCK'
#!/usr/bin/env bash
printf '%s|%s' "${OVERRIDE-unset}" "${FILE_ONLY-unset}" > "$CAPTURE"
MOCK
chmod +x "$LOCAL_API_TEST/bin/go"
CAPTURE="$LOCAL_API_TEST/result" /usr/bin/env -i PATH="$LOCAL_API_TEST/bin:/usr/bin:/bin" CAPTURE="$LOCAL_API_TEST/result" OVERRIDE=from-process "$LOCAL_API_TEST/api/run-local.sh"
[[ "$(cat "$LOCAL_API_TEST/result")" == 'from-process|from-file' ]]
CAPTURE="$LOCAL_API_TEST/result" /usr/bin/env -i PATH="$LOCAL_API_TEST/bin:/usr/bin:/bin" CAPTURE="$LOCAL_API_TEST/result" OVERRIDE= "$LOCAL_API_TEST/api/run-local.sh"
[[ "$(cat "$LOCAL_API_TEST/result")" == '|from-file' ]]

# Both profiles pass with mocked local health and free ports, without launching services.
run_profile -- development check >/dev/null
run_profile ARVC_VITE_HOST=127.0.0.1 -- development check >/dev/null
run_profile ARVC_VITE_HOST=0.0.0.0 -- development check >/dev/null
run_profile -- test check >/dev/null

# Development may opt into Audio Analyze only with the dedicated loopback quota role.
run_profile AUDIO_ANALYSIS_ENABLED=true \
  SUPABASE_AUDIO_ANALYSIS_DSN=postgresql://arvc_audio_analysis:test@127.0.0.1:54322/postgres?sslmode=disable \
  PYTHON_ISLAND_EXECUTABLE=/bin/true PYTHON_ISLAND_DIRECTORY=/tmp FFPROBE_EXECUTABLE=/bin/true \
  -- development check >/dev/null

# Test ports can be independently selected; proxy must follow the selected API port.
run_profile ARVC_FRONTEND_PORT=5274 API_ADDR=127.0.0.1:8181 ARVC_API_PROXY_TARGET=http://127.0.0.1:8181 -- test check >/dev/null

# Missing frontend key, remote Auth, production-like local overrides, and port conflicts fail closed.
expect_fail VITE_SUPABASE_ANON_KEY= -- test check
expect_fail SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co -- development check
expect_fail ARVC_VITE_HOST=192.168.1.10 -- development check
expect_fail ARVC_VITE_HOST='::' -- development check
expect_fail ARVC_API_PROXY_TARGET=https://api.example.com -- test check
expect_fail MOCK_SS_PORT=5173 -- development check
expect_fail MOCK_SS_FAIL=1 -- development check
expect_fail AUDIO_ANALYSIS_ENABLED=true SUPABASE_AUDIO_ANALYSIS_DSN=postgresql://test:pw@db.example.com/postgres?sslmode=verify-full -- test check
expect_fail AUDIO_ANALYSIS_ENABLED=true SUPABASE_AUDIO_ANALYSIS_DSN=postgresql://postgres:pw@127.0.0.1:54322/postgres?sslmode=disable -- test check
expect_fail AUDIO_ANALYSIS_ENABLED=true SUPABASE_AUDIO_ANALYSIS_DSN=postgresql://arvc_audio_analysis:test@db.example.com/postgres?sslmode=verify-full -- development check
expect_fail SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co -- development start

# Production check validates only local syntax/shape and never calls curl or starts services.
/usr/bin/env -i PATH="$PATH_FOR_TEST" HOME="${HOME:-/tmp}" \
  ARVC_PUBLIC_FRONTEND_ORIGIN=https://app.example.com \
  VITE_API_BASE_URL=https://api.example.com \
  SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co \
  VITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co \
  VITE_SUPABASE_ANON_KEY=sb_publishable_test \
  SUPABASE_ISSUER=https://abcdefghijklmnopqrst.supabase.co/auth/v1 \
  CORS_ALLOWED_ORIGINS=https://app.example.com \
  "$ROOT/scripts/arvc.sh" production check >/dev/null
expect_fail ARVC_PUBLIC_FRONTEND_ORIGIN=https://app.example.com VITE_API_BASE_URL=https://api.example.com SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co VITE_SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co VITE_SUPABASE_ANON_KEY=sb_secret_test SUPABASE_ISSUER=https://abcdefghijklmnopqrst.supabase.co/auth/v1 CORS_ALLOWED_ORIGINS=https://app.example.com -- production check
expect_fail -- production start

printf 'Environment profile checks: PASS\n'
