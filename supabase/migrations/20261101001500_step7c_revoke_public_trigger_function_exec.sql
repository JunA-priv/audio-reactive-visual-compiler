-- These functions are invoked only by their installed database triggers.
-- Revoke default PUBLIC EXECUTE so the verifier login inherits no app RPCs.
REVOKE EXECUTE ON FUNCTION public.enforce_project_asset_limits()
  FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier;
REVOKE EXECUTE ON FUNCTION public.enforce_project_asset_refs()
  FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier;
