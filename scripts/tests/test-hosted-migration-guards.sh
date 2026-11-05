#!/usr/bin/env bash
set -euo pipefail
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
python3 - "$tmp" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
files = sorted(pathlib.Path("supabase/migrations").glob("*.sql"))
versions = [p.name[:14] for p in files]
(root / "versions").write_text(",".join(versions), encoding="utf-8")
lines = ["┌──────────────┬──────────────┬──────────────────────┐", "│ Local        │ Remote       │ Name                 │", "├──────────────┼──────────────┼──────────────────────┤"]
for p in files:
    lines.append(f"│ {p.name[:14]} │              │ {p.stem} │")
lines.append("└──────────────┴──────────────┴──────────────────────┘")
(root / "pending.txt").write_text("\n".join(lines), encoding="utf-8")
ascii_lines = ["Local | Remote | Name", "------|--------|-----"]
for p in files:
    ascii_lines.append(f"{p.name[:14]} |  | {p.stem}")
(root / "pending-ascii.txt").write_text("\n".join(ascii_lines), encoding="utf-8")
(root / "dry.txt").write_text("Would push these migrations:\n" + "\n".join(versions), encoding="utf-8")
applied = [f"│ {v} │ {v} │ 2026-11-05 │" for v in versions]
(root / "applied.txt").write_text("\n".join(["│ Local │ Remote │ Time (UTC) │", *applied]), encoding="utf-8")
(root / "empty-dry.txt").write_text("No pending migrations.\n", encoding="utf-8")
for special in ("20261101001700", "20261101001800"):
    partial = ["│ Local │ Remote │ Name │"]
    for p in files:
        remote = "" if p.name[:14] == special else p.name[:14]
        partial.append(f"│ {p.name[:14]} │ {remote} │ {p.stem} │")
    (root / (special + ".txt")).write_text("\n".join(partial), encoding="utf-8")
    (root / (special + "-dry.txt")).write_text("Would push these migrations:\n" + special, encoding="utf-8")
PY
expected="$(cat "$tmp/versions")"
python3 scripts/tests/check-hosted-migration-target.py before "$tmp/pending.txt" "$tmp/dry.txt" "$expected" true
python3 scripts/tests/check-hosted-migration-target.py before "$tmp/pending-ascii.txt" "$tmp/dry.txt" "$expected" true
if python3 scripts/tests/check-hosted-migration-target.py before "$tmp/pending.txt" "$tmp/dry.txt" "$expected" false >/dev/null 2>&1; then
  echo "Full baseline passed without fresh-project confirmation." >&2
  exit 1
fi
if python3 scripts/tests/check-hosted-migration-target.py before "$tmp/pending.txt" "$tmp/dry.txt" none true >/dev/null 2>&1; then
  echo "Migration set mismatch was accepted." >&2
  exit 1
fi
for special in 20261101001700 20261101001800; do
  if python3 scripts/tests/check-hosted-migration-target.py before "$tmp/$special.txt" "$tmp/$special-dry.txt" "$special" true >/dev/null 2>&1; then
    echo "A partial application of $special was accepted." >&2
    exit 1
  fi
done
python3 scripts/tests/check-hosted-migration-target.py after "$tmp/applied.txt" "$tmp/empty-dry.txt" none false
EXPECTED_PROJECT_REF=abcdefghijklmnopqrst EXPECTED_POOLER_HOST=aws-1-ap-northeast-1.pooler.supabase.com SUPABASE_MIGRATION_DSN='postgresql://postgres.abcdefghijklmnopqrst:dummy-password@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full' python3 scripts/tests/check-hosted-migration-dsn.py
if EXPECTED_PROJECT_REF=abcdefghijklmnopqrst EXPECTED_POOLER_HOST=aws-1-ap-northeast-1.pooler.supabase.com SUPABASE_MIGRATION_DSN='postgresql://postgres.otherprojectref1234:dummy-password@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=verify-full' python3 scripts/tests/check-hosted-migration-dsn.py >/dev/null 2>&1; then
  echo "Wrong project reference was accepted for migration DSN." >&2
  exit 1
fi
echo "Hosted migration guard regressions passed."
