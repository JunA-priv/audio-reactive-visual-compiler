-- ACL changes must be issued as the helper role that owns the RPC.
GRANT arvc_project_writer TO postgres WITH SET TRUE;
SET ROLE arvc_project_writer;
REVOKE ALL ON FUNCTION public.update_project(uuid, bigint, text, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_project(uuid, bigint, text, jsonb)
  TO authenticated;
RESET ROLE;

-- The temporary membership is no longer required after ownership transfer.
REVOKE arvc_project_writer FROM postgres;
