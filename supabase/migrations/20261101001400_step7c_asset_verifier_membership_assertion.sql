-- Remove any postgres-granted membership. Supabase's protected bootstrap
-- membership cannot be revoked by postgres; it is not inheritable or settable.
REVOKE arvc_asset_verifier FROM postgres;
DO $membership$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE (
      m.roleid = 'arvc_asset_verifier'::regrole
      OR m.member = 'arvc_asset_verifier'::regrole
    )
    AND NOT (
      m.roleid = 'arvc_asset_verifier'::regrole
      AND m.member = 'postgres'::regrole
      AND m.grantor = 'supabase_admin'::regrole
      AND m.admin_option
      AND NOT m.inherit_option
      AND NOT m.set_option
    )
  ) THEN
    RAISE EXCEPTION 'arvc_asset_verifier has an unexpected or effective role membership';
  END IF;
END
$membership$;
