-- Step 7b: owner-scoped project metadata and editor document only.
-- Audio and image assets are intentionally not stored in this table.

DO $role$
BEGIN
  CREATE ROLE arvc_project_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
EXCEPTION WHEN duplicate_object THEN
  RAISE EXCEPTION 'arvc_project_writer role already exists; inspect local database before migration';
END
$role$;

CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (pg_catalog.char_length(title) BETWEEN 1 AND 120),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  document jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT projects_document_size_limit CHECK (pg_catalog.octet_length(document::text) <= 1048576),
  CONSTRAINT projects_document_shape_v1 CHECK ((
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
  ) IS TRUE)
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects FORCE ROW LEVEL SECURITY;

CREATE POLICY projects_select_owner ON public.projects
  FOR SELECT TO authenticated, arvc_project_writer
  USING (owner_id = (SELECT auth.uid()));
CREATE POLICY projects_insert_owner ON public.projects
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY projects_update_owner ON public.projects
  FOR UPDATE TO arvc_project_writer
  USING (owner_id = (SELECT auth.uid()))
  WITH CHECK (owner_id = (SELECT auth.uid()));
CREATE POLICY projects_delete_owner ON public.projects
  FOR DELETE TO authenticated
  USING (owner_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.projects FROM PUBLIC, anon, authenticated, arvc_project_writer;
GRANT SELECT, DELETE ON TABLE public.projects TO authenticated;
GRANT INSERT (title, document) ON TABLE public.projects TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated, arvc_project_writer;
GRANT USAGE ON SCHEMA auth TO arvc_project_writer;
GRANT EXECUTE ON FUNCTION auth.uid() TO arvc_project_writer;
GRANT SELECT ON TABLE public.projects TO arvc_project_writer;
GRANT UPDATE (title, document, revision, updated_at) ON TABLE public.projects TO arvc_project_writer;
GRANT CREATE ON SCHEMA public TO arvc_project_writer;

CREATE FUNCTION public.enforce_project_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  project_count bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.owner_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'owner_mismatch';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.owner_id::text, 707));
    SELECT pg_catalog.count(*) INTO project_count
      FROM public.projects AS p WHERE p.owner_id = NEW.owner_id;
    IF project_count >= 20 THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'project_limit_exceeded';
    END IF;
    NEW.revision := 1;
    NEW.created_at := pg_catalog.clock_timestamp();
    NEW.updated_at := NEW.created_at;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'immutable_project_fields';
    END IF;
    IF NEW.revision IS DISTINCT FROM OLD.revision + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'revision_conflict';
    END IF;
    NEW.updated_at := pg_catalog.clock_timestamp();
  END IF;
  IF pg_catalog.octet_length(NEW.document::text) > 1048576 THEN
    RAISE EXCEPTION USING ERRCODE = '22001', MESSAGE = 'project_document_too_large';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER projects_enforce_limits
  BEFORE INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_project_limits();
REVOKE ALL ON FUNCTION public.enforce_project_limits() FROM PUBLIC, anon, authenticated, arvc_project_writer;

CREATE FUNCTION public.update_project(
  p_id uuid,
  p_expected_revision bigint,
  p_title text,
  p_document jsonb
)
RETURNS SETOF public.projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_project public.projects;
  updated_project public.projects;
BEGIN
  SELECT p.* INTO current_project
    FROM public.projects AS p
    WHERE p.id = p_id AND p.owner_id = auth.uid()
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'project_not_found';
  END IF;
  IF current_project.revision <> p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'revision_conflict';
  END IF;
  UPDATE public.projects AS p
    SET title = p_title, document = p_document, revision = current_project.revision + 1
    WHERE p.id = p_id AND p.owner_id = auth.uid()
    RETURNING p.* INTO updated_project;
  RETURN NEXT updated_project;
END
$function$;
GRANT arvc_project_writer TO CURRENT_USER;
ALTER FUNCTION public.update_project(uuid, bigint, text, jsonb) OWNER TO arvc_project_writer;
REVOKE arvc_project_writer FROM CURRENT_USER;
REVOKE CREATE ON SCHEMA public FROM arvc_project_writer;
REVOKE ALL ON FUNCTION public.update_project(uuid, bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_project(uuid, bigint, text, jsonb) TO authenticated;
