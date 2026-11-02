-- The local Storage remove endpoint checks the object under the caller's RLS
-- context before deleting it. Keep that object visible only to its owner while
-- deletion is pending; all other owners remain excluded by owner_id + path.
DROP POLICY arvc_project_assets_select ON storage.objects;
CREATE POLICY arvc_project_assets_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'arvc-project-assets'
    AND owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    AND EXISTS (
      SELECT 1 FROM public.project_assets a
      WHERE a.owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
        AND a.status IN ('pending_upload','ready','delete_pending') AND a.object_key = name
    )
  );
