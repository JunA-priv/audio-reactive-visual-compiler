#!/usr/bin/env bash
set -euo pipefail
manifest="deploy/hosted-migrations.sha256"
test -s "$manifest"
mapfile -t actual < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' -printf '%f\n' | sort)
mapfile -t recorded < <(awk '{n=split($2, parts, "/"); print parts[n]}' "$manifest" | sort)
if [[ "${actual[*]}" != "${recorded[*]}" ]]; then
  echo "Hosted migration manifest inventory differs from SQL files." >&2
  exit 1
fi
sha256sum --check --status "$manifest"
echo "Hosted migration manifest inventory and hashes verified (${#actual[@]} files)."
