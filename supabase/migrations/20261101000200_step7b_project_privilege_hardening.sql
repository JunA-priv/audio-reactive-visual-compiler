-- Keep the revision-checked update RPC callable only by authenticated users.
REVOKE ALL ON FUNCTION public.update_project(uuid, bigint, text, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_project(uuid, bigint, text, jsonb)
  TO authenticated;

-- Ownership transfer required a temporary membership during migration. Remove
-- the migration-role membership after the function has its non-login owner.
REVOKE arvc_project_writer FROM postgres;
