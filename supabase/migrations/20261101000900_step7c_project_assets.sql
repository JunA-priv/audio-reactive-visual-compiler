-- Step 7c: private project assets and cloud document envelope v1.
-- Additive to Step 7b: ProjectDocument v1 and existing rows remain valid.

ALTER TABLE public.projects
  ADD CONSTRAINT projects_id_owner_unique UNIQUE (id, owner_id);

CREATE TABLE public.project_assets (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  project_id uuid NOT NULL,
  owner_id uuid NOT NULL DEFAULT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  )::uuid,
  kind text NOT NULL CHECK (kind IN ('source_audio', 'background_image')),
  original_name text NOT NULL CHECK (pg_catalog.char_length(original_name) BETWEEN 1 AND 255),
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'ready', 'delete_pending')),
  object_key text GENERATED ALWAYS AS (owner_id::text || '/' || project_id::text || '/' || id::text) STORED,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT project_assets_project_owner_fk FOREIGN KEY (project_id, owner_id)
    REFERENCES public.projects(id, owner_id) ON DELETE RESTRICT,
  CONSTRAINT project_assets_kind_size_type_check CHECK (
    (kind = 'source_audio' AND byte_size <= 33554432 AND content_type IN (
      'audio/mpeg','audio/wav','audio/ogg','audio/opus','audio/mp4','audio/aac','audio/webm','audio/flac'
    )) OR
    (kind = 'background_image' AND byte_size <= 10485760 AND content_type IN ('image/png','image/jpeg'))
  ),
  CONSTRAINT project_assets_one_per_kind UNIQUE (project_id, kind)
);

ALTER TABLE public.project_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_assets FORCE ROW LEVEL SECURITY;

CREATE POLICY project_assets_select_owner ON public.project_assets
  FOR SELECT TO authenticated
  USING (owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid);
CREATE POLICY project_assets_insert_owner ON public.project_assets
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
    AND status = 'pending_upload'
    AND EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND p.owner_id = owner_id)
  );

CREATE FUNCTION public.enforce_project_asset_limits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_used bigint;
  v_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.owner_id::text, 7301));
  SELECT COALESCE(pg_catalog.sum(byte_size), 0), pg_catalog.count(*)
    INTO v_used, v_count FROM public.project_assets WHERE owner_id = NEW.owner_id;
  IF v_count >= 40 OR v_used + NEW.byte_size > 880803840 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'asset_account_limit_reached';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;
CREATE TRIGGER project_assets_enforce_limits BEFORE INSERT ON public.project_assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_asset_limits();
ALTER FUNCTION public.enforce_project_asset_limits() OWNER TO postgres;

GRANT USAGE ON SCHEMA public TO authenticated;
REVOKE ALL ON TABLE public.project_assets FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.project_assets TO authenticated;
GRANT INSERT (project_id, kind, original_name, content_type, byte_size, sha256) ON TABLE public.project_assets TO authenticated;

-- State transition RPCs are callable only by an authenticated owner and operate
-- on the deterministic key. Storage remains the authority for object bytes.
CREATE FUNCTION public.project_asset_mark_ready(p_asset_id uuid)
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
      AND COALESCE((o.metadata->>'size')::bigint, -1) = v_asset.byte_size
      AND COALESCE(o.metadata->>'mimetype', '') = v_asset.content_type
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'asset_upload_not_verified';
  END IF;
  UPDATE public.project_assets SET status = 'ready', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_asset_id RETURNING * INTO v_asset;
  RETURN NEXT v_asset;
END
$function$;
ALTER FUNCTION public.project_asset_mark_ready(uuid) OWNER TO postgres;

CREATE FUNCTION public.project_asset_mark_delete_pending(p_asset_id uuid)
RETURNS SETOF public.project_assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner uuid := COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
  v_asset public.project_assets;
BEGIN
  UPDATE public.project_assets SET status = 'delete_pending', updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_asset_id AND owner_id = v_owner AND status IN ('pending_upload', 'ready')
    RETURNING * INTO v_asset;
  IF NOT FOUND THEN
    SELECT * INTO v_asset FROM public.project_assets WHERE id = p_asset_id AND owner_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'asset_not_found'; END IF;
  END IF;
  RETURN NEXT v_asset;
END
$function$;
ALTER FUNCTION public.project_asset_mark_delete_pending(uuid) OWNER TO postgres;

CREATE FUNCTION public.project_asset_finalize_delete(p_asset_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_owner uuid := COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid;
  v_asset public.project_assets;
BEGIN
  SELECT * INTO v_asset FROM public.project_assets
    WHERE id = p_asset_id AND owner_id = v_owner AND status = 'delete_pending' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'asset_not_found'; END IF;
  IF EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'arvc-project-assets' AND o.name = v_asset.object_key) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'asset_object_still_exists';
  END IF;
  DELETE FROM public.project_assets WHERE id = p_asset_id;
END
$function$;
ALTER FUNCTION public.project_asset_finalize_delete(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.project_asset_mark_ready(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.project_asset_mark_delete_pending(uuid) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.project_asset_finalize_delete(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.project_asset_mark_ready(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_asset_mark_delete_pending(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_asset_finalize_delete(uuid) TO authenticated;

DO $bucket$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'arvc-project-assets') THEN
    RAISE EXCEPTION 'arvc-project-assets bucket already exists; inspect local state before migration';
  END IF;
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES ('arvc-project-assets', 'arvc-project-assets', false, 33554432,
    ARRAY['audio/mpeg','audio/wav','audio/ogg','audio/opus','audio/mp4','audio/aac','audio/webm','audio/flac','image/png','image/jpeg']);
END
$bucket$;

CREATE POLICY arvc_project_assets_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'arvc-project-assets'
    AND EXISTS (
      SELECT 1 FROM public.project_assets a
      WHERE a.owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
        AND a.status = 'pending_upload' AND a.object_key = name
        AND a.content_type = COALESCE(metadata->>'mimetype', '')
        AND a.byte_size = COALESCE((metadata->>'size')::bigint, -1)
    )
  );
CREATE POLICY arvc_project_assets_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'arvc-project-assets' AND owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    AND EXISTS (SELECT 1 FROM public.project_assets a WHERE a.owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND a.status IN ('pending_upload','ready') AND a.object_key = name)
  );
CREATE POLICY arvc_project_assets_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'arvc-project-assets' AND owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')
    AND EXISTS (SELECT 1 FROM public.project_assets a WHERE a.owner_id = COALESCE(NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''), pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid AND a.status = 'delete_pending' AND a.object_key = name)
  );

CREATE POLICY arvc_project_assets_no_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (false) WITH CHECK (false);

-- Preserve the v1 constraint; accept an additional Cloud Document Envelope v1.
ALTER TABLE public.projects DROP CONSTRAINT projects_document_shape_v1;
ALTER TABLE public.projects ADD CONSTRAINT projects_document_shape_v1 CHECK (
  (
    pg_catalog.jsonb_typeof(document) = 'object'
    AND document->>'documentVersion' = '1'
    AND pg_catalog.jsonb_typeof(document->'metadata') = 'object'
    AND document->'metadata'->>'blueprintSchemaVersion' = '1'
    AND document->'metadata'->>'featureTimelineSchemaVersion' = '1'
    AND document->'metadata'->>'rendererVersion' = 'editor-renderer/1'
    AND (document->'metadata'->>'seed') = (document->'blueprint'->>'seed')
    AND pg_catalog.jsonb_typeof(document->'blueprint') = 'object'
    AND document->'blueprint'->>'version' = '1'
    AND document->'blueprint'->'background'->>'kind' IN ('solid', 'gradient')
    AND pg_catalog.jsonb_typeof(document->'featureTimeline') = 'object'
    AND document->'featureTimeline'->>'schemaVersion' = '1'
    AND document->'featureTimeline'->>'timeUnit' = 'ms'
    AND NOT (document ? 'assets')
  ) OR (
    pg_catalog.jsonb_typeof(document) = 'object'
    AND document->>'cloudDocumentVersion' = '1'
    AND pg_catalog.jsonb_typeof(document->'metadata') = 'object'
    AND document->'metadata'->>'blueprintSchemaVersion' = '1'
    AND document->'metadata'->>'featureTimelineSchemaVersion' = '1'
    AND document->'metadata'->>'rendererVersion' = 'editor-renderer/1'
    AND pg_catalog.jsonb_typeof(document->'editorState') = 'object'
    AND pg_catalog.jsonb_typeof(document->'editorState'->'blueprint') = 'object'
    AND document->'editorState'->'blueprint'->>'version' = '1'
    AND document->'editorState'->'blueprint'->'background'->>'kind' IN ('solid', 'gradient')
    AND (document->'editorState'->>'backgroundAssetId' IS NULL OR (document->'editorState'->'blueprint'->'background'->>'kind' = 'solid' AND document->'editorState'->'blueprint'->'background'->>'color' = '#000000'))
    AND pg_catalog.jsonb_typeof(document->'featureTimeline') = 'object'
    AND document->'featureTimeline'->>'schemaVersion' = '1'
    AND document->'featureTimeline'->>'timeUnit' = 'ms'
    AND pg_catalog.jsonb_typeof(document->'assetRefs') = 'object'
  ) IS TRUE
);

CREATE OR REPLACE FUNCTION public.enforce_project_asset_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_background_id uuid;
  v_audio_id uuid;
BEGIN
  IF NEW.document ? 'cloudDocumentVersion' THEN
    v_background_id := NULLIF(NEW.document->'editorState'->>'backgroundAssetId', '')::uuid;
    v_audio_id := NULLIF(NEW.document->'assetRefs'->>'audioAssetId', '')::uuid;
    IF v_background_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.project_assets a WHERE a.id = v_background_id AND a.project_id = NEW.id
        AND a.owner_id = NEW.owner_id AND a.kind = 'background_image' AND a.status = 'ready'
    ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_background_asset_reference'; END IF;
    IF v_audio_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.project_assets a WHERE a.id = v_audio_id AND a.project_id = NEW.id
        AND a.owner_id = NEW.owner_id AND a.kind = 'source_audio' AND a.status = 'ready'
    ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid_audio_asset_reference'; END IF;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.enforce_project_asset_refs() OWNER TO postgres;
DROP TRIGGER IF EXISTS projects_enforce_asset_refs ON public.projects;
CREATE TRIGGER projects_enforce_asset_refs BEFORE INSERT OR UPDATE OF document ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_asset_refs();
