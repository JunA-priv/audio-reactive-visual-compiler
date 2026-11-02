-- Isolate the ready transition from the Supabase Data API roles.
-- The migration runner must be an administrator able to CREATE ROLE/schema.

DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'arvc_asset_verifier') THEN
    RAISE EXCEPTION 'arvc_asset_verifier already exists; inspect local role state before migration';
  END IF;
  CREATE ROLE arvc_asset_verifier
    NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END
$role$;

CREATE SCHEMA arvc_internal AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA arvc_internal FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA arvc_internal TO arvc_asset_verifier;
GRANT CONNECT ON DATABASE postgres TO arvc_asset_verifier;
ALTER ROLE arvc_asset_verifier SET search_path = arvc_internal;

CREATE FUNCTION arvc_internal.project_asset_mark_ready(p_asset_id uuid, p_owner_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_asset public.project_assets;
BEGIN
  IF p_asset_id IS NULL OR p_owner_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'asset_identity_required';
  END IF;

  SELECT * INTO v_asset
    FROM public.project_assets
    WHERE id = p_asset_id AND owner_id = p_owner_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'asset_not_found';
  END IF;
  IF v_asset.status <> 'pending_upload' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'asset_not_pending_upload';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = v_asset.project_id AND p.owner_id = p_owner_id
  ) OR NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'arvc-project-assets'
      AND o.name = v_asset.object_key
      AND o.owner_id = p_owner_id::text
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'asset_upload_not_verified';
  END IF;

  UPDATE public.project_assets
    SET status = 'ready', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_asset_id AND owner_id = p_owner_id AND status = 'pending_upload'
    RETURNING * INTO v_asset;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'asset_state_changed';
  END IF;
  RETURN pg_catalog.to_jsonb(v_asset);
END
$function$;
ALTER FUNCTION arvc_internal.project_asset_mark_ready(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.project_asset_mark_ready(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION arvc_internal.project_asset_mark_ready(uuid, uuid)
  TO arvc_asset_verifier;

-- Keep the legacy PostgREST function present for compatibility with existing
-- deployments, but make it unusable by every Data API role.
REVOKE ALL ON FUNCTION public.project_asset_mark_ready(uuid)
  FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier;
