#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_ROOT="$ROOT/.run"
PROFILE="${1:-}"
ACTION="${2:-}"
PROFILE_FILE="$ROOT/config/environments/$PROFILE.env"

# Noninteractive WSL shells may not load the user's interactive toolchain PATH.
if ! command -v go >/dev/null && [[ -x /usr/local/go/bin/go ]]; then
  PATH="/usr/local/go/bin:$PATH"
fi
if { ! command -v node >/dev/null || ! command -v npm >/dev/null; } && [[ -s "${HOME:-}/.nvm/nvm.sh" ]]; then
  # Load the user's installed Node version only when the shell did not expose it.
  # shellcheck source=/dev/null
  source "${HOME}/.nvm/nvm.sh"
fi
export PATH

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
info() { printf '%s\n' "$1"; }

usage() {
  cat <<'USAGE'
Usage:
  scripts/arvc.sh setup [development|test|production]
  scripts/arvc.sh development start|stop|status|check
  scripts/arvc.sh test        start|stop|status|check
  scripts/arvc.sh production  check
USAGE
}

copy_if_missing() {
  local source="$1" target="$2"
  if [[ -e "$target" ]]; then
    info "Kept existing file: ${target#"$ROOT"/}"
  else
    cp -- "$source" "$target"
    chmod 600 "$target"
    info "Created: ${target#"$ROOT"/} (edit local-only values as needed)"
  fi
}

setup_profiles() {
  local selected="${2:-all}"
  mkdir -p "$ROOT/config/environments"
  case "$selected" in
    all|development|test|production) ;;
    *) fail "Unknown setup profile: $selected" ;;
  esac
  for name in development test production; do
    [[ "$selected" == all || "$selected" == "$name" ]] || continue
    copy_if_missing "$ROOT/config/environments/$name.env.example" "$ROOT/config/environments/$name.env"
  done
  if [[ "$selected" == all || "$selected" == development ]]; then
    copy_if_missing "$ROOT/frontend/.env.local.example" "$ROOT/frontend/.env.local"
  fi
  if [[ "$selected" == all || "$selected" == test ]]; then
    copy_if_missing "$ROOT/frontend/.env.test.local.example" "$ROOT/frontend/.env.test.local"
  fi
}

if [[ "$PROFILE" == setup ]]; then
  setup_profiles "${2:-all}"
  exit 0
fi

[[ "$PROFILE" =~ ^(development|test|production)$ ]] || { usage >&2; exit 2; }
[[ "$ACTION" =~ ^(start|stop|status|check)$ ]] || { usage >&2; exit 2; }
if [[ "$ACTION" == start || "$ACTION" == check || "$PROFILE" == production ]]; then
  [[ -f "$PROFILE_FILE" ]] || fail "Missing local profile ${PROFILE_FILE#"$ROOT"/}; run scripts/arvc.sh setup $PROFILE first."
fi
[[ "$PROFILE" != production || "$ACTION" == check ]] || fail "Production is configuration-review only; start/stop/status are disabled."

# Explicit shell environment > ignored profile file > component-local .env fallback.
declare -A inherited=()
if [[ "$ACTION" != stop && -f "$PROFILE_FILE" ]]; then
  while IFS='=' read -r key _; do
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && inherited["$key"]=1
  done < <(env)
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *=* ]] || fail "Invalid profile line in ${PROFILE_FILE#"$ROOT"/}; expected KEY=VALUE."
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "Invalid profile key in ${PROFILE_FILE#"$ROOT"/}."
    if [[ -z "${inherited[$key]+set}" ]]; then
      export "$key=$value"
      inherited["$key"]=1
    fi
  done < "$PROFILE_FILE"
fi

if [[ "$ACTION" != stop ]]; then
  [[ "${ARVC_ENV:-$PROFILE}" == "$PROFILE" ]] || fail "ARVC_ENV does not match selected profile '$PROFILE'."
fi

profile_port() {
  case "$PROFILE" in development) printf '5173' ;; test) printf '%s' "${ARVC_FRONTEND_PORT:-5174}" ;; esac
}
profile_api_addr() {
  case "$PROFILE" in development) printf '127.0.0.1:8080' ;; test) printf '%s' "${API_ADDR:-127.0.0.1:8081}" ;; esac
}
profile_vite_host() {
  case "$PROFILE" in development) printf '%s' "${ARVC_VITE_HOST:-0.0.0.0}" ;; test) printf '127.0.0.1' ;; esac
}

is_local_http_origin() {
  [[ "$1" =~ ^http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]{1,5})?$ ]]
}

validate_nonproduction() {
  local expected_frontend expected_api vite_host supabase_url issuer vite_url api_host api_port
  expected_frontend="$(profile_port)"
  expected_api="$(profile_api_addr)"
  vite_host="$(profile_vite_host)"
  if [[ "$PROFILE" == development ]]; then
    [[ "${ARVC_FRONTEND_PORT:-}" == "$expected_frontend" ]] || fail "Development uses frontend port 5173."
    [[ "$vite_host" == 127.0.0.1 || "$vite_host" == 0.0.0.0 ]] || fail "Development ARVC_VITE_HOST must be 127.0.0.1 or 0.0.0.0."
    [[ "${API_ADDR:-}" == "$expected_api" ]] || fail "Development uses API_ADDR=127.0.0.1:8080."
  else
    [[ "${ARVC_FRONTEND_PORT:-}" =~ ^[0-9]{1,5}$ ]] || fail "Test ARVC_FRONTEND_PORT must be a TCP port number."
    frontend_port_num=$((10#$ARVC_FRONTEND_PORT))
    (( frontend_port_num >= 1 && frontend_port_num <= 65535 && frontend_port_num != 5173 )) || fail "Test Frontend port must be 1–65535 and must not use Development port 5173."
    [[ "${API_ADDR:-}" =~ ^127\.0\.0\.1:[0-9]{1,5}$ ]] || fail "Test API_ADDR must be a loopback IPv4 address and port."
    api_port_num=$((10#${API_ADDR##*:}))
    (( api_port_num >= 1 && api_port_num <= 65535 && api_port_num != 8080 )) || fail "Test API port must be 1–65535 and must not use Development port 8080."
    (( api_port_num != frontend_port_num )) || fail "Test API and Frontend must use different ports."
  fi
  [[ -z "${PORT:-}" ]] || fail "PORT must be empty; non-empty PORT binds the API to 0.0.0.0."
  [[ "${ARVC_API_PROXY_TARGET:-}" == "http://$expected_api" ]] || fail "ARVC_API_PROXY_TARGET must point to this profile's API ($expected_api)."
  [[ "${AUTH_ENV:-}" == local ]] || fail "$PROFILE only accepts AUTH_ENV=local."
  [[ "${BLUEPRINT_MODE:-}" == fixture ]] || fail "$PROFILE requires BLUEPRINT_MODE=fixture."
  [[ "${AI_GENERATION_ENABLED:-false}" == false && "${PROJECTS_ENABLED:-false}" == false ]] || fail "$PROFILE launcher allows AI and Projects only after a separately reviewed local integration setup."
  [[ "${AI_FIXTURE_UNLIMITED_LOCAL:-false}" == false ]] || fail "Fixture quota bypass must remain disabled in managed profiles."
  [[ -z "${OPENAI_API_KEY:-}" && -z "${SUPABASE_ANON_KEY:-}" && -z "${SUPABASE_AI_BUDGET_DSN:-}" && -z "${SUPABASE_ASSET_VERIFIER_DSN:-}" ]] || fail "Development/Test must not inherit OpenAI or project service credentials."
  [[ "${VITE_API_BASE_URL:-}" == "" ]] || fail "VITE_API_BASE_URL must be blank in local profiles so Vite uses its loopback proxy."
  supabase_url="${SUPABASE_URL:-}"
  issuer="${SUPABASE_ISSUER:-}"
  vite_url="${VITE_SUPABASE_URL:-}"
  is_local_http_origin "$supabase_url" || fail "SUPABASE_URL must be a local loopback HTTP origin."
  [[ "$issuer" == "$supabase_url/auth/v1" ]] || fail "SUPABASE_ISSUER must match local SUPABASE_URL/auth/v1."
  [[ "$vite_url" == "$supabase_url" ]] || fail "VITE_SUPABASE_URL must match local SUPABASE_URL."
  api_host="${expected_api%:*}"
  api_port="${expected_api##*:}"
  [[ "${ARVC_API_PROXY_TARGET:-}" == "http://$api_host:$api_port" ]] || fail "API proxy target mismatch."
  if [[ -n "${CORS_ALLOWED_ORIGINS:-}" ]]; then
    fail "CORS_ALLOWED_ORIGINS must be empty for loopback Vite proxy profiles."
  fi
  if [[ "${AUDIO_ANALYSIS_ENABLED:-false}" == true ]]; then
    [[ "$PROFILE" == development || "$PROFILE" == test ]] || fail "Audio Analyze is available only in local Development or Test profiles."
    [[ -n "${SUPABASE_AUDIO_ANALYSIS_DSN:-}" ]] || fail "Audio Analyze needs the dedicated local quota DSN; profile was not started."
    [[ "${SUPABASE_AUDIO_ANALYSIS_DSN}" =~ ^postgres(ql)?://arvc_audio_analysis:[^/@?#]+@127\.0\.0\.1:54322/postgres\?.*sslmode=disable(&[^#]*)?$ ]] || fail "Audio Analyze DSN must use the dedicated local arvc_audio_analysis role on PostgreSQL loopback with sslmode=disable."
  else
    [[ -z "${SUPABASE_AUDIO_ANALYSIS_DSN:-}" ]] || fail "Do not carry an Audio Analyze DSN while the route is disabled."
  fi
  # Managed profiles explicitly blank service DSNs unless Test opts in to a dedicated local Audio Analyze role.
}

mask_unapproved_component_credentials() {
  # Ensure api/.env cannot inject credentials for API features disabled by this profile.
  export OPENAI_API_KEY="" SUPABASE_ANON_KEY="" SUPABASE_SERVICE_ROLE_KEY=""
  export SUPABASE_AI_BUDGET_DSN="" SUPABASE_ASSET_VERIFIER_DSN=""
  if [[ "${AUDIO_ANALYSIS_ENABLED:-false}" != true ]]; then
    export SUPABASE_AUDIO_ANALYSIS_DSN=""
  fi
}

require_local_supabase_health() {
  local auth_health="${SUPABASE_URL%/}/auth/v1/health"
  if ! curl --fail --silent --show-error --max-time 3 "$auth_health" -o /dev/null 2>/dev/null; then
    fail "Local Supabase Auth health check failed; start/check the existing local Supabase stack separately. No Supabase command was run."
  fi
}

production_check() {
  local frontend api supabase issuer cors
  frontend="${ARVC_PUBLIC_FRONTEND_ORIGIN:-}"
  api="${VITE_API_BASE_URL:-}"
  supabase="${SUPABASE_URL:-}"
  issuer="${SUPABASE_ISSUER:-}"
  cors="${CORS_ALLOWED_ORIGINS:-}"
  [[ "${AUTH_ENV:-}" == hosted ]] || fail "Production requires AUTH_ENV=hosted."
  [[ "$supabase" =~ ^https://[a-z0-9]{20}\.supabase\.co$ ]] || fail "Production SUPABASE_URL must be a canonical HTTPS Supabase project origin."
  [[ "$VITE_SUPABASE_URL" == "$supabase" ]] || fail "Production VITE_SUPABASE_URL must match the Hosted Supabase origin."
  [[ -n "${VITE_SUPABASE_ANON_KEY:-}" && "${VITE_SUPABASE_ANON_KEY}" != replace-with-* ]] || fail "Set the Hosted public anon/publishable key in the production build environment."
  if ! VITE_SUPABASE_ANON_KEY="$VITE_SUPABASE_ANON_KEY" python3 - <<'PY'
import base64
import json
import os
import sys

key = os.environ["VITE_SUPABASE_ANON_KEY"]
if key.startswith("sb_publishable_"):
    sys.exit(0)
if key.startswith("sb_secret_"):
    sys.exit(1)
try:
    payload = key.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    claims = json.loads(base64.urlsafe_b64decode(payload))
except Exception:
    sys.exit(1)
sys.exit(0 if claims.get("role") == "anon" else 1)
PY
  then
    fail "Production VITE_SUPABASE_ANON_KEY must be an anon/publishable key, not a service-role/secret key."
  fi
  [[ "$issuer" == "$supabase/auth/v1" ]] || fail "Production SUPABASE_ISSUER must match SUPABASE_URL/auth/v1."
  [[ "$frontend" =~ ^https://([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(:[0-9]{1,5})?$ && "$frontend" != *YOUR-* ]] || fail "Set the exact public HTTPS frontend origin."
  [[ "$api" =~ ^https://([A-Za-z0-9-]+\.)*[A-Za-z0-9-]+(:[0-9]{1,5})?$ && "$api" != *YOUR-* ]] || fail "Set the exact public HTTPS API origin in VITE_API_BASE_URL."
  [[ "$cors" == "$frontend" ]] || fail "CORS_ALLOWED_ORIGINS must exactly match the public frontend origin."
  [[ "${BLUEPRINT_MODE:-}" == fixture && "${AI_GENERATION_ENABLED:-false}" == false && "${PROJECTS_ENABLED:-false}" == false && "${AUDIO_ANALYSIS_ENABLED:-false}" == false ]] || fail "Production checklist profile must keep unapproved AI/Projects/Audio Analyze features disabled."
  [[ -z "${OPENAI_API_KEY:-}" && -z "${SUPABASE_AI_BUDGET_DSN:-}" && -z "${SUPABASE_ASSET_VERIFIER_DSN:-}" && -z "${SUPABASE_AUDIO_ANALYSIS_DSN:-}" ]] || fail "Do not put real production secrets in the profile file; configure them through a reviewed secret manager after approval."
  info "Production configuration shape: PASS (HTTPS origins, Hosted issuer, exact CORS, restricted feature flags)."
  info "No network request, service start, database operation, secret-manager access, or deployment was performed; no secret values were printed."
  info "Production Auth signing mode, service plan, quota/entitlements, secret-manager bindings, observability, and release approval still require separate review."
}

proc_start_token() {
  local stat rest
  [[ -r "/proc/$1/stat" ]] || return 1
  IFS= read -r stat < "/proc/$1/stat" || return 1
  rest="${stat##*) }"
  local -a fields
  read -r -a fields <<< "$rest"
  printf '%s' "${fields[19]:-}"
}

read_pid_record() {
  local service="$1" record="$STATE_ROOT/$PROFILE/$service.pid"
  [[ -f "$record" ]] || return 1
  read -r PID_RECORDED START_RECORDED < "$record"
  [[ "$PID_RECORDED" =~ ^[0-9]+$ && -n "$START_RECORDED" ]] || return 1
  [[ "$(proc_start_token "$PID_RECORDED" 2>/dev/null || true)" == "$START_RECORDED" ]]
}

service_url() {
  case "$1" in api) printf 'http://127.0.0.1:%s/healthz' "${API_ADDR##*:}" ;; frontend) printf 'http://127.0.0.1:%s/' "$ARVC_FRONTEND_PORT" ;; esac
}

service_port() {
  case "$1" in api) printf '%s' "${API_ADDR##*:}" ;; frontend) printf '%s' "$ARVC_FRONTEND_PORT" ;; esac
}

port_is_free() {
  local listeners
  listeners="$(ss -H -ltn "sport = :$1" 2>/dev/null)" || fail "Could not inspect TCP port $1; refusing to start services."
  [[ -z "$listeners" ]]
}

check_frontend_auth_file() {
  local mode_file="$ROOT/frontend/.env.$([[ "$PROFILE" == test ]] && printf test || printf development).local" base_file="$ROOT/frontend/.env.local" file key value
  local has_url="${VITE_SUPABASE_URL:-}" has_key="${VITE_SUPABASE_ANON_KEY:-}"
  for file in "$mode_file" "$base_file"; do
    [[ -f "$file" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" == VITE_SUPABASE_URL=* && -z "$has_url" ]] && has_url="${line#*=}"
      [[ "$line" == VITE_SUPABASE_ANON_KEY=* && -z "$has_key" ]] && has_key="${line#*=}"
    done < "$file"
  done
  [[ "$has_url" == "${SUPABASE_URL:-}" ]] || fail "Frontend local Supabase URL is missing or mismatched; configure frontend/.env.local or the test mode file."
  [[ -n "$has_key" && "$has_key" != replace-with-* ]] || fail "Local Supabase anon key is missing; use the local public anon/publishable key in the ignored Frontend env file."
}

validate_production() {
  production_check
}

if [[ "$PROFILE" == production ]]; then
  [[ "$ACTION" == check ]] || fail "Production is configuration-review only."
  profile_mode="$(stat -c '%a' "$PROFILE_FILE" 2>/dev/null || true)"
  [[ "$profile_mode" == 600 || "$profile_mode" == 400 ]] || fail "Protect the production profile with chmod 600 before checking it."
  validate_production
  exit 0
fi

if [[ "$ACTION" == start || "$ACTION" == check ]]; then
  profile_mode="$(stat -c '%a' "$PROFILE_FILE" 2>/dev/null || true)"
  [[ "$profile_mode" == 600 || "$profile_mode" == 400 ]] || fail "Protect the selected profile with chmod 600 before use."
  [[ -d "$ROOT/frontend/node_modules" ]] || fail "Frontend dependencies are missing; run npm ci in frontend/ first."
  command -v go >/dev/null || fail "Go is not installed in WSL."
  command -v npm >/dev/null || fail "Node/npm is not installed in WSL."
  command -v curl >/dev/null || fail "curl is required for health checks."
  command -v ss >/dev/null || fail "ss (iproute2) is required for safe port checks."
  command -v setsid >/dev/null || fail "setsid is required to track only launcher-owned process groups."
  validate_nonproduction
  mask_unapproved_component_credentials
  check_frontend_auth_file
  require_local_supabase_health
  if [[ "${AUDIO_ANALYSIS_ENABLED:-false}" == true ]]; then
    python_executable="${PYTHON_ISLAND_EXECUTABLE:-../python-island/.venv/bin/python-island}"
    python_directory="${PYTHON_ISLAND_DIRECTORY:-../python-island}"
    ffprobe_executable="${FFPROBE_EXECUTABLE:-ffprobe}"
    [[ "$python_executable" == /* ]] || python_executable="$ROOT/api/$python_executable"
    [[ -x "$python_executable" ]] || fail "Python Island executable is missing or not executable; check PYTHON_ISLAND_EXECUTABLE."
    [[ -d "$ROOT/api/$python_directory" || -d "$python_directory" ]] || fail "Python Island directory is missing; check PYTHON_ISLAND_DIRECTORY."
    if [[ "$ffprobe_executable" == */* ]]; then
      [[ -x "$ffprobe_executable" ]] || fail "FFprobe executable is missing or not executable."
    else
      command -v "$ffprobe_executable" >/dev/null || fail "FFprobe is required when Audio Analyze is enabled."
    fi
    if [[ -n "${ARVC_SCNET_CHECKPOINT:-}" ]]; then
      [[ -f "$ARVC_SCNET_CHECKPOINT" ]] || fail "ARVC_SCNET_CHECKPOINT does not point to a file."
    fi
  fi
elif [[ "$ACTION" == status ]]; then
  command -v curl >/dev/null || fail "curl is required for health checks."
  ARVC_FRONTEND_PORT="${ARVC_FRONTEND_PORT:-$(profile_port)}"
  API_ADDR="${API_ADDR:-$(profile_api_addr)}"
fi

if [[ "$ACTION" == check ]]; then
  for service in api frontend; do
    port="$(service_port "$service")"
    if port_is_free "$port"; then
      info "$service port $port: available"
    else
      fail "$service port $port is already in use; no process was stopped. Use status or inspect that owner."
    fi
  done
  info "$PROFILE configuration and local Supabase Auth health: PASS. No services started."
  exit 0
fi

mkdir -p "$STATE_ROOT/$PROFILE"
chmod 700 "$STATE_ROOT" "$STATE_ROOT/$PROFILE"

is_healthy() {
  local service="$1" url
  url="$(service_url "$service")"
  curl --fail --silent --max-time 2 "$url" -o /dev/null
}

service_status() {
  local service="$1" port
  port="$(service_port "$service")"
  if read_pid_record "$service"; then
    if is_healthy "$service"; then
      info "$service: running (launcher PID $PID_RECORDED), healthy on 127.0.0.1:$port"
    else
      info "$service: running (launcher PID $PID_RECORDED), health check failed on 127.0.0.1:$port"
      return 1
    fi
  else
    info "$service: not owned by this profile launcher"
    return 1
  fi
}

case "$ACTION" in
  status)
    result=0
    service_status api || result=1
    service_status frontend || result=1
    exit "$result"
    ;;
  stop)
    for service in frontend api; do
      if ! read_pid_record "$service"; then
        info "$service: no verified launcher-owned process; left untouched"
        continue
      fi
      pgid="$(ps -o pgid= -p "$PID_RECORDED" 2>/dev/null | tr -d ' ')"
      [[ "$pgid" == "$PID_RECORDED" ]] || fail "$service PID identity/group check failed; process left untouched."
      kill -TERM -- "-$PID_RECORDED" 2>/dev/null || true
      for _ in {1..80}; do
        kill -0 -- "-$PID_RECORDED" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 -- "-$PID_RECORDED" 2>/dev/null; then
        # The recorded process group was created by this launcher and fingerprinted above.
        [[ "$(proc_start_token "$PID_RECORDED" 2>/dev/null || true)" == "$START_RECORDED" ]] || fail "$service PID changed during shutdown; refusing forced stop."
        kill -KILL -- "-$PID_RECORDED" 2>/dev/null || true
      fi
      rm -f "$STATE_ROOT/$PROFILE/$service.pid"
      info "$service: stopped launcher-owned process group"
    done
    ;;
  start)
    running=0
    for service in api frontend; do
      if read_pid_record "$service"; then
        if is_healthy "$service"; then
          info "$service: already running and healthy"
          running=1
        else
          fail "$service launcher process exists but is unhealthy; inspect logs before restart."
        fi
      elif ! port_is_free "$(service_port "$service")"; then
        fail "$service port $(service_port "$service") is occupied by an unowned process; no process was stopped."
      fi
    done
    if [[ "$running" == 1 ]]; then
      [[ -f "$STATE_ROOT/$PROFILE/api.pid" && -f "$STATE_ROOT/$PROFILE/frontend.pid" ]] && exit 0
      fail "Partial profile already running; use status and stop to inspect/stop only verified launcher-owned processes."
    fi
    umask 077
    api_log="$STATE_ROOT/$PROFILE/api.log"
    frontend_log="$STATE_ROOT/$PROFILE/frontend.log"
    setsid bash -c 'cd "$1" && exec ./run-local.sh' _ "$ROOT/api" >>"$api_log" 2>&1 < /dev/null &
    api_pid=$!
    api_start="$(proc_start_token "$api_pid" 2>/dev/null || true)"
    [[ -n "$api_start" ]] || { kill "$api_pid" 2>/dev/null || true; fail "Could not fingerprint new API process. See $api_log."; }
    printf '%s %s\n' "$api_pid" "$api_start" > "$STATE_ROOT/$PROFILE/api.pid"
    api_ready=false
    for _ in {1..100}; do
      if curl --fail --silent --max-time 1 "$(service_url api)" -o /dev/null; then api_ready=true; break; fi
      kill -0 "$api_pid" 2>/dev/null || break
      sleep 0.2
    done
    if [[ "$api_ready" != true ]]; then
      PROFILE="$PROFILE" ACTION=stop "$ROOT/scripts/arvc.sh" "$PROFILE" stop >/dev/null 2>&1 || true
      fail "API startup/health check failed; only the new API process group was stopped. Log: ${api_log#"$ROOT"/}"
    fi
    mode=development
    [[ "$PROFILE" == test ]] && mode=test
    setsid npm --prefix "$ROOT/frontend" run dev -- --host "$(profile_vite_host)" --port "$ARVC_FRONTEND_PORT" --strictPort --mode "$mode" >>"$frontend_log" 2>&1 < /dev/null &
    frontend_pid=$!
    frontend_start="$(proc_start_token "$frontend_pid" 2>/dev/null || true)"
    [[ -n "$frontend_start" ]] || { kill "$frontend_pid" 2>/dev/null || true; "$ROOT/scripts/arvc.sh" "$PROFILE" stop >/dev/null 2>&1 || true; fail "Could not fingerprint new Frontend process. See $frontend_log."; }
    printf '%s %s\n' "$frontend_pid" "$frontend_start" > "$STATE_ROOT/$PROFILE/frontend.pid"
    frontend_ready=false
    for _ in {1..100}; do
      if curl --fail --silent --max-time 1 "$(service_url frontend)" -o /dev/null; then frontend_ready=true; break; fi
      kill -0 "$frontend_pid" 2>/dev/null || break
      sleep 0.2
    done
    if [[ "$frontend_ready" != true ]]; then
      "$ROOT/scripts/arvc.sh" "$PROFILE" stop >/dev/null 2>&1 || true
      fail "Frontend startup/health check failed; only new profile processes were stopped. Log: ${frontend_log#"$ROOT"/}"
    fi
    info "$PROFILE started: Frontend bind $(profile_vite_host):$ARVC_FRONTEND_PORT, API http://$API_ADDR"
    info "Logs: ${STATE_ROOT#"$ROOT"/}/$PROFILE/ (mode 600)"
    ;;
esac
