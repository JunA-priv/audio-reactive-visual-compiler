#!/usr/bin/env python3
"""Fail-closed verifier for the reviewed migration set before/after Hosted apply."""
import pathlib
import re
import sys

VERSION = re.compile(r"(?<!\d)(\d{14})(?!\d)")


def fail(message):
    raise SystemExit(message)


def migration_inventory():
    return sorted(p.name[:14] for p in pathlib.Path("supabase/migrations").glob("*.sql"))


def parse_table(raw):
    rows = {}
    for line in raw.splitlines():
        if "│" not in line and "|" not in line:
            continue
        columns = [part.strip() for part in re.split(r"[│|]", line)]
        if columns and not columns[0]:
            columns.pop(0)
        if columns and not columns[-1]:
            columns.pop()
        if not columns:
            continue
        local_match = VERSION.fullmatch(columns[0])
        if not local_match:
            if len(columns) > 1 and VERSION.search(columns[1]):
                fail("Remote-only migration history detected; refusing Hosted apply")
            continue
        version = local_match.group(1)
        # CLI table: Local | Remote | Name. Require both history columns.
        if len(columns) < 2:
            fail("Unrecognized Supabase migration list output; refusing Hosted apply")
        remote = columns[1]
        if remote and not VERSION.search(remote):
            fail("Unrecognized remote migration state; refusing Hosted apply")
        rows[version] = remote
    if not rows:
        fail("No migration rows parsed from Supabase CLI output; refusing Hosted apply")
    return rows


def parse_dry_run(raw):
    versions = sorted(set(VERSION.findall(raw)))
    if not versions and re.search(r"(?i)(no pending|up to date|nothing to push)", raw):
        return []
    if not versions:
        fail("Could not identify exact dry-run migration set; refusing Hosted apply")
    return versions


def main():
    if len(sys.argv) != 6:
        fail("usage: check-hosted-migration-target.py before|after migration-list dry-run expected confirm-empty")
    mode, list_path, dry_path, expected_arg, confirm_empty = sys.argv[1:]
    local = migration_inventory()
    rows = parse_table(pathlib.Path(list_path).read_text(encoding="utf-8"))
    if sorted(rows) != local:
        fail("CLI local migration inventory differs from repository; refusing Hosted apply")
    pending = sorted(version for version, remote in rows.items() if not remote)
    if any(remote and remote != version for version, remote in rows.items()):
        fail("Remote migration history diverges from local migration inventory")
    if mode == "before":
        raw_expected = [] if expected_arg == "none" else expected_arg.split(",")
        if any(not re.fullmatch(r"\d{14}", value) for value in raw_expected) or len(set(raw_expected)) != len(raw_expected):
            fail("Approved migration input must contain unique 14-digit versions or none")
        expected = sorted(raw_expected)
        if expected != pending:
            fail("Pending migrations do not exactly match the explicitly approved set")
        dry = parse_dry_run(pathlib.Path(dry_path).read_text(encoding="utf-8"))
        if dry != pending:
            fail("Supabase db push dry-run differs from the approved pending set")
        bootstrap = {"20261101001700", "20261101001800"}
        if bootstrap.intersection(pending) and pending != local:
            fail("Migrations 017/018 may only be applied as the complete fresh-project baseline")
        if pending == local and confirm_empty.lower() != "true":
            fail("A full migration baseline requires explicit fresh-project-empty confirmation")
    elif mode == "after":
        if pending:
            fail("Migration apply did not converge to the complete local inventory")
    else:
        fail("unknown verification mode")
    print(f"Hosted migration {mode} verification passed ({len(pending)} pending).")


if __name__ == "__main__":
    main()
