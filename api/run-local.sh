#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Process environment is authoritative; api/.env only supplies missing values.
declare -A inherited_environment=()
while IFS='=' read -r key _; do
  [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] && inherited_environment["$key"]=1
done < <(env)
if [[ -f .env ]]; then
  # Parse plain KEY=VALUE lines without evaluating them as shell code.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    if [[ -z "${inherited_environment[$key]+set}" ]]; then
      export "$key=$value"
      inherited_environment["$key"]=1
    fi
  done < .env
fi

exec go run ./cmd/server
