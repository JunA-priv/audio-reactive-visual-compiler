-- Fail closed if the admin grantor handoff in 013 was not effective.
REVOKE arvc_asset_verifier FROM postgres;
DO $membership$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles r ON r.oid = m.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = m.member
    WHERE r.rolname = 'arvc_asset_verifier' OR u.rolname = 'arvc_asset_verifier'
  ) THEN
    RAISE EXCEPTION 'arvc_asset_verifier must have no role memberships; apply this migration as its grantor-capable local administrator';
  END IF;
END
$membership$;
