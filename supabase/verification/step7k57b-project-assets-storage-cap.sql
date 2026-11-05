-- Disposable database only. Exercises the Project Assets reservation ledger
-- and global cap; these pending_upload rows do not write Storage objects.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN (
    '00000000-0000-4000-8000-000000000571',
    '00000000-0000-4000-8000-000000000572'
  )) THEN
    RAISE EXCEPTION 'Step 7k-57b synthetic users already exist; refusing to overwrite';
  END IF;
  INSERT INTO auth.users(id) VALUES
    ('00000000-0000-4000-8000-000000000571'),
    ('00000000-0000-4000-8000-000000000572');
END
$$;

DO $$
DECLARE
  v_function pg_proc;
  v_owner name;
BEGIN
  SELECT p.* INTO v_function
    FROM pg_catalog.pg_proc AS p
    WHERE p.oid = 'public.enforce_project_asset_limits()'::regprocedure;
  SELECT r.rolname INTO v_owner FROM pg_catalog.pg_roles AS r WHERE r.oid = v_function.proowner;
  IF v_owner <> 'postgres' OR NOT v_function.prosecdef
     OR NOT (v_function.proconfig @> ARRAY['search_path=""']::text[])
     OR pg_catalog.pg_get_functiondef(v_function.oid) NOT LIKE '%524288000%'
     OR pg_catalog.pg_get_functiondef(v_function.oid) NOT LIKE '%arvc_project_assets_global_storage%' THEN
    RAISE EXCEPTION 'Project Assets quota trigger function is not globally scoped and safely hardened';
  END IF;
  IF has_function_privilege('anon','public.enforce_project_asset_limits()','EXECUTE')
     OR has_function_privilege('authenticated','public.enforce_project_asset_limits()','EXECUTE')
     OR has_function_privilege('service_role','public.enforce_project_asset_limits()','EXECUTE') THEN
    RAISE EXCEPTION 'Project Assets trigger function has an unexpected direct EXECUTE grant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger AS t
    WHERE t.tgrelid = 'public.project_assets'::regclass
      AND t.tgname = 'project_assets_enforce_limits'
      AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Project Assets reservation trigger is missing or disabled';
  END IF;
END
$$;

SET LOCAL ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000571',true);
DO $$
DECLARE
  v_project uuid;
  v_total bigint;
  i integer;
  v_document jsonb := '{"documentVersion":1,"metadata":{"blueprintSchemaVersion":1,"featureTimelineSchemaVersion":1,"rendererVersion":"editor-renderer/1","seed":1},"blueprint":{"version":1,"seed":1,"background":{"kind":"solid"}},"featureTimeline":{"schemaVersion":1,"timeUnit":"ms"}}'::jsonb;
BEGIN
  -- Eleven complete 42 MiB projects reserve 462 MiB.
  FOR i IN 1..11 LOOP
    INSERT INTO public.projects(title,document) VALUES('cap-fixture-' || i,v_document) RETURNING id INTO v_project;
    INSERT INTO public.project_assets(project_id,kind,original_name,content_type,byte_size,sha256)
      VALUES(v_project,'source_audio','audio-' || i,'audio/wav',33554432,pg_catalog.repeat('a',64));
    INSERT INTO public.project_assets(project_id,kind,original_name,content_type,byte_size,sha256)
      VALUES(v_project,'background_image','image-' || i,'image/png',10485760,pg_catalog.repeat('b',64));
  END LOOP;

  -- 32 MiB audio + 6 MiB image reaches exactly 500 MiB.
  INSERT INTO public.projects(title,document) VALUES('cap-fixture-12',v_document) RETURNING id INTO v_project;
  INSERT INTO public.project_assets(project_id,kind,original_name,content_type,byte_size,sha256)
    VALUES(v_project,'source_audio','audio-12','audio/wav',33554432,pg_catalog.repeat('c',64));
  INSERT INTO public.project_assets(project_id,kind,original_name,content_type,byte_size,sha256)
    VALUES(v_project,'background_image','image-12','image/png',6291456,pg_catalog.repeat('d',64));

  SELECT pg_catalog.sum(byte_size) INTO v_total FROM public.project_assets;
  IF v_total <> 524288000 THEN RAISE EXCEPTION 'Project Assets exact-cap accounting mismatch: %',v_total; END IF;

  INSERT INTO public.projects(title,document) VALUES('cap-fixture-overflow',v_document) RETURNING id INTO v_project;
  BEGIN
    INSERT INTO public.project_assets(project_id,kind,original_name,content_type,byte_size,sha256)
      VALUES(v_project,'source_audio','overflow','audio/wav',1,pg_catalog.repeat('e',64));
    RAISE EXCEPTION 'Project Assets admitted bytes over the 500 MiB global cap';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'asset_account_limit_reached' THEN RAISE; END IF;
  END;

  -- A different owner is denied by the project-wide reservation, even though
  -- that owner's individual account usage is zero.
  PERFORM pg_catalog.set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000572',true);
  INSERT INTO public.projects(title,document) VALUES('cap-fixture-other-owner',v_document) RETURNING id INTO v_project;
  BEGIN
    INSERT INTO public.project_assets(project_id,kind,original_name,content_type,byte_size,sha256)
      VALUES(v_project,'source_audio','other-owner','audio/wav',1,pg_catalog.repeat('f',64));
    RAISE EXCEPTION 'Second owner bypassed the project-wide 500 MiB reservation cap';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM <> 'asset_account_limit_reached' THEN RAISE; END IF;
  END;
END
$$;
ROLLBACK;
