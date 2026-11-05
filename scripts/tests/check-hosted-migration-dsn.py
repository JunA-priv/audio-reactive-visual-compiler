#!/usr/bin/env python3
"""Validate Hosted migration connection target without printing credentials."""
import os
import re
import sys
from urllib.parse import urlsplit, unquote

ref = os.environ.get("EXPECTED_PROJECT_REF", "")
expected_host = os.environ.get("EXPECTED_POOLER_HOST", "").lower()
dsn = os.environ.get("SUPABASE_MIGRATION_DSN", "")
if not re.fullmatch(r"[a-z0-9]{20}", ref):
    sys.exit("invalid expected project reference")
try:
    parsed = urlsplit(dsn)
    user = unquote(parsed.username or "")
    valid = (
        parsed.scheme == "postgresql"
        and parsed.hostname is not None
        and re.fullmatch(r"aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com", parsed.hostname)
        and re.fullmatch(r"aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com", expected_host)
        and parsed.hostname.lower() == expected_host
        and parsed.port == 5432
        and user == "postgres." + ref
        and parsed.path == "/postgres"
        and parsed.query.lower() == "sslmode=verify-full"
        and parsed.password is not None
    )
except ValueError:
    valid = False
if not valid:
    sys.exit("migration DSN must target this project's verified IPv4 Session Pooler as postgres.<project-ref>")
print("Hosted migration DSN target validated (credential omitted).")
