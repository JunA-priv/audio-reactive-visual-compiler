#!/usr/bin/env bash
set -euo pipefail

base_ref="${1:-origin/main}"
mapfile -t migration_files < <(git diff --name-only --diff-filter=ACMR "$base_ref...HEAD" -- 'supabase/migrations/*.sql')
if ((${#migration_files[@]} == 0)); then
  echo "No migration files changed."
  exit 0
fi

python3 - "${migration_files[@]}" <<'PY'
import pathlib
import re
import sys

files = [pathlib.Path(name) for name in sys.argv[1:]]
errors = []
for path in files:
    text = path.read_text(encoding="utf-8")
    # Reject destructive schema operations and deletes against existing product,
    # identity, quota, or asset data. Any retention exception must be narrowly
    # allowlisted by exact file and statement below.
    delete_pattern = r"(?im)^\s*delete\s+from\s+(?:auth\.|storage\.|public\.(?:projects|project_assets|audio_analysis_entitlements|audio_analysis_usage|ai_))"
    patterns = [
        r"(?im)^\s*(?:drop|truncate)\s+(?:table|schema|database|role|function|policy|sequence)\b",
        r"(?im)^\s*alter\s+table\b[^;]*\bdrop\s+(?:column|constraint|not\s+null)\b",
        delete_pattern,
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, text):
            line = text.count("\n", 0, match.start()) + 1
            # This exact, documented quota-ledger retention rule deletes only
            # finalized usage older than 90 days. Keep all other quota/history
            # deletion blocked; do not broaden this exception to another file
            # or a changed predicate.
            if pattern == delete_pattern and path.name == "20261104000100_step7k42_audio_analysis_quota.sql":
                statement_start = text.rfind(";", 0, match.start()) + 1
                statement_end = text.find(";", match.end())
                statement = text[statement_start:statement_end + 1] if statement_end >= 0 else ""
                statement = re.sub(r"--[^\n]*", " ", statement)
                normalized = re.sub(r"\s+", " ", statement).strip().lower()
                if normalized == "delete from public.audio_analysis_usage where finalized_at < v_now - interval '90 days';":
                    continue
            errors.append(f"{path}:{line}: destructive operation requires separate data-preservation review")
    if not re.match(r"^\d{14}_[a-z0-9_]+\.sql$", path.name):
        errors.append(f"{path}: migration filename must use the 14-digit forward timestamp format")

if errors:
    print("\n".join(errors), file=sys.stderr)
    raise SystemExit(1)
print(f"Forward migration safety check passed ({len(files)} file(s)).")
PY
