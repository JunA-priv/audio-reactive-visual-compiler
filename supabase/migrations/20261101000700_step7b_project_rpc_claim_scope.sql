-- The local migration role cannot grant USAGE on Supabase-owned auth schema.
-- Keep the update RPC SECURITY DEFINER, but derive its owner from PostgREST's
-- verified JWT claim settings and apply the same predicate in its RLS policy.
DROP POLICY projects_update_owner ON public.projects;
CREATE POLICY projects_update_owner ON public.projects
  FOR UPDATE TO arvc_project_writer
  USING (
    owner_id = COALESCE(
      NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    )::uuid
  )
  WITH CHECK (
    owner_id = COALESCE(
      NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
      pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
    )::uuid
  );

GRANT arvc_project_writer TO postgres WITH SET TRUE;
SET ROLE arvc_project_writer;
CREATE OR REPLACE FUNCTION public.update_project(
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
  request_owner uuid;
BEGIN
  request_owner := COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
  )::uuid;
  SELECT p.* INTO current_project
    FROM public.projects AS p
    WHERE p.id = p_id AND p.owner_id = request_owner
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'project_not_found';
  END IF;
  IF current_project.revision <> p_expected_revision THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = 'revision_conflict';
  END IF;
  UPDATE public.projects AS p
    SET title = p_title, document = p_document, revision = current_project.revision + 1
    WHERE p.id = p_id AND p.owner_id = request_owner
    RETURNING p.* INTO updated_project;
  RETURN NEXT updated_project;
END
$function$;
RESET ROLE;
REVOKE arvc_project_writer FROM postgres;
