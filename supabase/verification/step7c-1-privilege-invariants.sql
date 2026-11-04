-- Read-only checks for the Step 7c-1 ready transition boundary.
-- Run only against the local Step 7b/7c database after migration 012 and
-- after the local verifier role has been provisioned with LOGIN.
WITH checks(name, passed) AS (
  SELECT 'authenticated_cannot_call_legacy_ready_rpc', NOT has_function_privilege('authenticated', 'public.project_asset_mark_ready(uuid)', 'EXECUTE')
  UNION ALL SELECT 'anon_cannot_call_legacy_ready_rpc', NOT has_function_privilege('anon', 'public.project_asset_mark_ready(uuid)', 'EXECUTE')
  UNION ALL SELECT 'service_role_cannot_call_legacy_ready_rpc', NOT has_function_privilege('service_role', 'public.project_asset_mark_ready(uuid)', 'EXECUTE')
  UNION ALL SELECT 'legacy_ready_rpc_not_public', NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
    WHERE p.oid = 'public.project_asset_mark_ready(uuid)'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  )
  UNION ALL SELECT 'verifier_can_call_private_ready_rpc', has_function_privilege('arvc_asset_verifier', 'arvc_internal.project_asset_mark_ready(uuid,uuid)', 'EXECUTE')
  UNION ALL SELECT 'authenticated_cannot_call_private_ready_rpc', NOT has_function_privilege('authenticated', 'arvc_internal.project_asset_mark_ready(uuid,uuid)', 'EXECUTE')
  UNION ALL SELECT 'anon_cannot_call_private_ready_rpc', NOT has_function_privilege('anon', 'arvc_internal.project_asset_mark_ready(uuid,uuid)', 'EXECUTE')
  UNION ALL SELECT 'service_role_cannot_call_private_ready_rpc', NOT has_function_privilege('service_role', 'arvc_internal.project_asset_mark_ready(uuid,uuid)', 'EXECUTE')
  UNION ALL SELECT 'verifier_can_execute_only_private_ready_rpc', NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'arvc_internal')
      AND has_function_privilege('arvc_asset_verifier', p.oid, 'EXECUTE')
      AND p.oid <> 'arvc_internal.project_asset_mark_ready(uuid,uuid)'::regprocedure
  )
  UNION ALL SELECT 'verifier_is_login_nonsuperuser_nobypassrls_noinherit', r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb
    FROM pg_catalog.pg_roles r WHERE r.rolname = 'arvc_asset_verifier'
  UNION ALL SELECT 'verifier_has_no_role_memberships', NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE (m.roleid = 'arvc_asset_verifier'::regrole OR m.member = 'arvc_asset_verifier'::regrole)
      AND NOT (
        m.roleid = 'arvc_asset_verifier'::regrole
        AND m.member = 'postgres'::regrole
        AND m.grantor = 'supabase_admin'::regrole
        AND m.admin_option
        AND NOT m.inherit_option
        AND NOT m.set_option
      )
  )
  UNION ALL SELECT 'verifier_has_no_project_assets_table_privilege',
    NOT has_table_privilege('arvc_asset_verifier', 'public.project_assets', 'SELECT')
    AND NOT has_table_privilege('arvc_asset_verifier', 'public.project_assets', 'INSERT')
    AND NOT has_table_privilege('arvc_asset_verifier', 'public.project_assets', 'UPDATE')
    AND NOT has_table_privilege('arvc_asset_verifier', 'public.project_assets', 'DELETE')
  UNION ALL SELECT 'verifier_has_no_project_table_privilege',
    NOT has_table_privilege('arvc_asset_verifier', 'public.projects', 'SELECT')
    AND NOT has_table_privilege('arvc_asset_verifier', 'public.projects', 'INSERT')
    AND NOT has_table_privilege('arvc_asset_verifier', 'public.projects', 'UPDATE')
    AND NOT has_table_privilege('arvc_asset_verifier', 'public.projects', 'DELETE')
  UNION ALL SELECT 'project_assets_force_rls', c.relrowsecurity AND c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'project_assets'
  UNION ALL SELECT 'ready_function_owned_by_postgres_search_path_empty', p.proowner = 'postgres'::regrole AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']
    FROM pg_catalog.pg_proc p WHERE p.oid = 'arvc_internal.project_asset_mark_ready(uuid,uuid)'::regprocedure
)
SELECT name, passed FROM checks ORDER BY name;
