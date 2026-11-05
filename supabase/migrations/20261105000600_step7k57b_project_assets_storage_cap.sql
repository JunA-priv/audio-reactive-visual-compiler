-- Step 7k-57b: reserve no more than 500 MiB for Project Assets across the
-- entire project. Keep every owner's reservation within the same bound.
-- These rows account for pending, ready, and delete-pending objects; a row is
-- released only after the Storage object is removed and the row is finalized.
-- This is an application reservation limit, not a meter for other buckets or
-- Supabase platform-level object usage.
CREATE OR REPLACE FUNCTION public.enforce_project_asset_limits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_global_used bigint;
  v_owner_used bigint;
  v_owner_count bigint;
BEGIN
  -- Serialize admission across all owners so the project-wide sum cannot race.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('arvc_project_assets_global_storage', 7301)
  );

  SELECT COALESCE(pg_catalog.sum(a.byte_size), 0)
    INTO v_global_used
    FROM public.project_assets AS a;
  SELECT COALESCE(pg_catalog.sum(a.byte_size), 0), pg_catalog.count(*)
    INTO v_owner_used, v_owner_count
    FROM public.project_assets AS a
    WHERE a.owner_id = NEW.owner_id;

  IF v_owner_count >= 40
     OR v_owner_used + NEW.byte_size > 524288000
     OR v_global_used + NEW.byte_size > 524288000 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'asset_account_limit_reached';
  END IF;
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_project_asset_limits() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_project_asset_limits()
  FROM PUBLIC, anon, authenticated, service_role;
