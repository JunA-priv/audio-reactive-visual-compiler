-- Storage's internal metadata JSON is implementation-specific. Keep RLS
-- responsible for owner/reservation/path; Go verifies bytes, size, MIME and
-- SHA-256 before calling project_asset_mark_ready.
DROP POLICY arvc_project_assets_insert ON storage.objects;
CREATE POLICY arvc_project_assets_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'arvc-project-assets'
    AND EXISTS (
      SELECT 1 FROM public.project_assets a
      WHERE a.owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
        AND a.status = 'pending_upload' AND a.object_key = name
    )
  );

CREATE OR REPLACE FUNCTION public.project_asset_mark_ready(p_asset_id uuid)
RETURNS SETOF public.project_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner uuid := COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
  v_asset public.project_assets;
BEGIN
  SELECT * INTO v_asset FROM public.project_assets
    WHERE id = p_asset_id AND owner_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'asset_not_found';
  END IF;
  IF v_asset.status = 'ready' THEN RETURN NEXT v_asset; RETURN; END IF;
  IF v_asset.status <> 'pending_upload' OR NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'arvc-project-assets' AND o.name = v_asset.object_key
      AND o.owner_id = v_owner::text
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'asset_upload_not_verified';
  END IF;
  UPDATE public.project_assets SET status = 'ready', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_asset_id RETURNING * INTO v_asset;
  RETURN NEXT v_asset;
END
$function$;
ALTER FUNCTION public.project_asset_mark_ready(uuid) OWNER TO postgres;
