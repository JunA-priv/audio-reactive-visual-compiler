# Step 7k-57b — Hosted Supabase移行前ブロッカー解消

**Status: completed — Hosted migration preparation and PR CI passed. Hosted Supabase and GCP were not changed; the feature PR is not merged.**

## 1. GitHub and local Git

- Starting worktree had only the uncommitted Step 7k-57 documentation changes; those files were preserved.
- Read-only GitHub API check confirmed PR #5 `MERGED`, head `13f7f5f05217ec974497d5057c17c72e53b04e58`, merge commit `3705bbf001a795f9df160506c903c3f1aa914306`, merged 2026-11-05 07:31:14 UTC.
- Required checks `go`, `migrations`, and `quality` all succeeded. Review requests, reviews, comments, and review threads were empty.
- Fetched `upstream/main`; the old local `main` was its ancestor. Fast-forwarded local `main` to `3705bbf001a795f9df160506c903c3f1aa914306` without switching the current feature worktree.
- Created `feature/step7k57b-free-storage-cli` from the synchronized `main`. Step 7k-57 uncommitted report/current-state/task files carried into the branch and remain preserved.

## 2. Storage capacity semantics and change

### Existing counters reviewed

- Migration `20261101000900` set a per-owner `sum(project_assets.byte_size)` ceiling of 880,803,840 bytes (840 MiB) and at most 40 rows per owner. It did not sum rows across owners or query Supabase's physical Storage usage.
- The Project Assets flow creates a DB reservation row before Storage upload. It remains accounted for pending, ready, and delete-pending states; delete finalization removes the row only after the object is gone. `project_asset_mark_ready` checks Storage object owner, metadata size, MIME, and deterministic key against that reservation.
- Authenticated owner-scoped Data API grants/RLS remain present in migrations even when the Cloud API's `PROJECTS_ENABLED` switch is false. The frontend cloud-project panel is also hard-disabled today, but that does not make database policies a physical quota. The global DB reservation cap therefore applies even while the feature's first-party routes remain disabled.
- Audio Storage already has a 320 MiB global reservation ceiling. Its database sums active job bytes, upload intents, and pending cleanup bytes; the per-user ceiling in SQL is 50,331,648 bytes (48 MiB), and each file is at most 16 MiB. Pending deletion remains charged until the Storage delete is finalized. These are DB reservations, not a query of total project usage.
- Supabase Free usage counts all project buckets/objects. Neither ledger includes objects in other buckets, console/manual/admin uploads, or any object that becomes detached from its application reservation through out-of-band changes. Supabase's own Storage usage view remains authoritative for physical project usage.

### Forward migration

Added `20261105000600_step7k57b_project_assets_storage_cap.sql`:

- Lowers each owner's reservation ceiling to 500 MiB and adds a 500 MiB **project-wide** reservation ceiling across all owners.
- Serializes admissions through one transaction-scoped advisory lock, then sums reservation rows across all owners and for the current owner. The existing 40-assets-per-owner limit remains.
- Keeps pending, ready, and delete-pending bytes reserved. Existing project/asset rows and Storage objects are not rewritten or deleted. A preexisting database above the new cap would reject new reservations until usage drops below it.
- Hardens the accounting trigger as a `SECURITY DEFINER` function owned by `postgres`, with an empty `search_path`, so FORCE RLS cannot hide other owners' reservations from the global sum. Direct EXECUTE grants are revoked from app/Data API roles; callers can only reach it through the table trigger.
- Does not change the Audio 320 MiB aggregate or its per-user controls.

Maximum application-managed reservations across the two buckets are now 500 + 320 = 820 MiB. If the plan's displayed 1 GB is interpreted as decimal, nominal headroom is about 140 MB (134 MiB). Platform usage can include other objects and reported size may differ from application reservation bytes, so record the fresh-project usage before enabling writes, subtract all non-ledger objects from available quota, and check the Supabase usage view during beta. Keep other buckets/writers disabled until separately accounted for. Stop Audio admission by disabling `audio_analysis_control.enabled` before measured total usage nears the Free limit. A project-wide physical-usage meter or alarm is not implemented in app code.

The Cloud Run API template now explicitly sets `PROJECTS_ENABLED=false`. This keeps project/asset API routes off during beta while retaining the database-level global cap for direct authenticated Data API paths.

## 3. Supabase CLI 2.121.0

- WSL is Linux x86_64 with Ubuntu glibc 2.39, supported by the official Linux amd64 distribution.
- Retrieved the official `supabase/cli` v2.121.0 release tarball and `checksums.txt`; archive checksum matched the published checksum.
- Installed only the binary at repository-local ignored path `.tools/supabase/2.121.0/supabase`. Version output is `2.121.0`. No global npm or package-manager install was performed; no Supabase login/link was created. Telemetry was disabled for each invocation because the host user's config directory is read-only.
- Existing local/isolated Supabase stacks were already running. A separate temporary workdir, project id `arvc-step7k57b-captest`, DB port 55422, and unique Docker volume/container were used. No existing stack/container/volume was targeted.

## 4. Migration inventory and isolated database validation

- Local `main` baseline had 24 migrations after PR #5. Added migration 00600 as timestamp 25. No existing migration SQL was edited. `deploy/hosted-migrations.sha256` now has 25 entries, each matching the SQL file.
- CLI `db start` on the disposable PostgreSQL 17.11 Supabase DB applied all 25 migrations in timestamp order. `supabase migration list --local` showed matching local/database versions 25/25 through `20261105000600`.
- CLI `db lint --local --fail-on error` reported no schema errors.
- New rollback-only SQL verification reached exactly 524,288,000 bytes, rejected an additional byte, and rejected a second owner's reservation at the project-wide ceiling. It also checks `postgres` ownership, `SECURITY DEFINER`, empty `search_path`, trigger existence, and no direct app role EXECUTE grants. Its synthetic rows were rolled back and no Storage objects were written.
- Existing Step 7k-50b, 50d, 50e, 52, and 56 SQL regressions passed in the fresh database. Step 7b, 7c, 7g, and 7k42 RLS/ACL/RPC invariants passed.
- The Step 7c verifier invariant was updated to exclude return-type `trigger` helpers from the callable-RPC allowlist; PostgreSQL forbids direct invocation of trigger-returning functions. The disposable test role was set LOGIN to satisfy that invariant's documented local runtime-provisioning precondition. This role change was only in the disposable DB, which is not a persisted local project.
- Reproduced the CI preservation sequence in the disposable PG17 project: apply the 19-migration base, seed Auth/entitlement/usage/control sentinels, apply the six held-out migrations (50b, 50d, 50e, 52, 56, 57b), and run `step7k50b-preservation-after.sql`; all sentinels remained intact and history reached 25/25. The backend GitHub workflow now follows this sequence and runs the new regression. It also runs the Step 7c invariant under its documented disposable-role setup.

## 5. Local verification results

- `go test -race -p 1 ./...`: PASS. First sandbox run failed in preexisting `httptest.NewServer` tests because IPv6 loopback bind was denied; rerun with local loopback permission passed all packages.
- `go vet -p 1 ./...`: PASS.
- `go build -p 1 ./...`: PASS.
- Frontend `npm test`: 15 files / 192 tests PASS. Frontend source was not changed.
- Supabase CLI 2.121.0 fresh PostgreSQL 17 migrations: 25/25 PASS; history matches 25/25.
- Supabase `db lint --local --fail-on error`: PASS.
- New Storage cap regression, existing SQL regressions and four RLS/ACL/RPC invariant files: PASS.
- Migration manifest/hash: 25/25 PASS. Hosted target guard regression: PASS. Forward-only migration guard is scheduled after commit so it can compare the committed migration against `main`. `git diff --check`: PASS.
- Hosted migration workflow remains coupled to later Cloud Run deployments. It was not run. A migration-only operator procedure is documented below; it uses a target-validated direct CLI workflow and ends before any GCP authentication/deploy steps.

## 6. Migration-only Hosted operator procedure (design; not executed)

No Hosted project was linked, queried, or changed. After target identification, backups, capacity and cost review, and explicit migration approval, use a separate controlled operator session:

1. Confirm GitHub PR #5 merge/main head and use the reviewed main commit containing 25 migrations. Recompute and check all manifest hashes.
2. Confirm the exact Supabase project ref, Free plan, region and PostgreSQL version in Dashboard; confirm the project is empty and has no Auth users, custom schema/data, buckets/objects or migration history.
3. Capture empty-state project identity/usage, take a custom-format pre-apply logical DB backup, inventory Storage buckets/objects separately, verify file size/hash, and test backup readability in a same-major isolated DB.
4. Create protected migration DSN for `postgres.<project-ref>` over that project's IPv4 Session Pooler session mode on port 5432, database `postgres`, TLS `sslmode=verify-full`. Keep it separate from runtime `arvc_audio_analysis` and `arvc_ai_budget` credentials.
5. With CLI v2.121.0 and no `supabase link`, run `check-hosted-migration-dsn.py`, `supabase migration list --db-url "$SUPABASE_MIGRATION_DSN"`, and `supabase db push --db-url "$SUPABASE_MIGRATION_DSN" --dry-run`. Require the target guard to match the exact complete 25-version list, manifest and empty-project confirmation. Any partial/existing/unknown history stops the run.
6. Only after exact-set review and separate approval, invoke `supabase db push --db-url "$SUPABASE_MIGRATION_DSN" --yes`; then re-list history and require all 25 versions, compare schema/roles/extension/policies, capture the post-apply backup, and validate it in isolation.
7. Do not run `hosted-release-approved.yml` for this step: that workflow continues into GCP authentication and Cloud Run deployment. This operator procedure performs only Supabase migrations and ends before GCP/Cloud Run operations.

Any target mismatch, nonempty project, unknown role/extension privilege, unexpected object, backup failure, dry-run mismatch, apply failure, incomplete history, or lint/invariant failure stops the process. Do not retry, repair history, edit applied SQL, drop/recreate the project, or restore without separate review/approval.

## 7. Remaining Free-plan limits and approvals

- App reservation caps bound two managed buckets to 820 MiB, but do not guarantee the whole project's physical usage. Read the Supabase usage view before application admission, keep other buckets/manual Storage writers disabled, and stop before reaching the plan cap. Any other measured object bytes reduce the ~134 MiB conservative headroom.
- The 500 MiB Assets cap is one global pool shared by all owners; a single owner can consume the pool. This prevents a multi-user aggregate overshoot but is not a fairness policy.
- Hosted ref/region/plan/version/empty state, actual Pooler and migration permissions, Auth ES256/JWKS/invite settings, private buckets, runtime dedicated roles/credentials, Storage PUT/GET/DELETE, and Hosted recovery have not been tested.
- The Supabase CLI binary is a local ignored convenience and is not part of the feature branch. The official checksum was validated; repo CI continues to install its pinned v2.121.0.
- Explicit approval is still required for Hosted project creation/configuration, backup from Hosted, Hosted DB role/credential setup, migration apply, Auth/Storage changes, user creation, GCP, Production workflow, deployment and public traffic.
- PR #6: https://github.com/JunA-priv/audio-reactive-visual-compiler/pull/6, head `c10b0509ad7eca0cdb05aa705c85d283d37d0f36`. Required `go`, `migrations`, and Frontend `quality` checks passed. PR remains open and unmerged; no main push or merge was performed.

## 8. Changed files

- `.github/workflows/backend-and-migrations.yml`
- `.gitignore` (ignore local repo tool install)
- `CURRENT_TASK.md`, `docs/CURRENT_STATE.md`
- `deploy/cloud-run/README.md`, `deploy/cloud-run/audio-api.service.yaml`
- `deploy/hosted-migrations.sha256`
- `docs/reports/2026-11-05-step7k-57b-hosted-migration-blockers.md`
- `docs/reports/2026-11-05-step7k-57-hosted-supabase-first-migration-readiness.md` (preserved; no edit)
- `supabase/migrations/20261105000600_step7k57b_project_assets_storage_cap.sql`
- `supabase/verification/step7c-1-privilege-invariants.sql`
- `supabase/verification/step7k57b-project-assets-storage-cap.sql`

The existing local development database and the Step 7k-52 isolated Supabase stack remain running and were not connected to by migration or verification commands. No Hosted, GCP or Production workflow changes were made.
