#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# Preserve an explicit process-level mode while loading the local defaults.
mode_override="${BLUEPRINT_MODE:-}"
ai_override="${AI_GENERATION_ENABLED:-}"
projects_override="${PROJECTS_ENABLED:-}"
fixture_unlimited_override="${AI_FIXTURE_UNLIMITED_LOCAL:-}"
fixture_user_override="${AI_FIXTURE_UNLIMITED_USER_ID:-}"
audio_analysis_override="${AUDIO_ANALYSIS_ENABLED:-}"
if [[ -f .env ]]; then
  # Load plain KEY=VALUE lines without evaluating secrets as shell code.
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*$ || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    value="${line#*=}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    export "$key=$value"
  done < .env
fi
if [[ -n "$mode_override" ]]; then
  export BLUEPRINT_MODE="$mode_override"
fi
if [[ -n "$ai_override" ]]; then
  export AI_GENERATION_ENABLED="$ai_override"
fi
if [[ -n "$projects_override" ]]; then
  export PROJECTS_ENABLED="$projects_override"
fi
if [[ -n "$fixture_unlimited_override" ]]; then
  export AI_FIXTURE_UNLIMITED_LOCAL="$fixture_unlimited_override"
fi
if [[ -n "$fixture_user_override" ]]; then
  export AI_FIXTURE_UNLIMITED_USER_ID="$fixture_user_override"
fi
if [[ -n "$audio_analysis_override" ]]; then
  export AUDIO_ANALYSIS_ENABLED="$audio_analysis_override"
fi

exec go run ./cmd/server
