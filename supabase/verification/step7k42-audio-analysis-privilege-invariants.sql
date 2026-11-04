-- Read-only Step 7k-42 checks. Run only after an explicitly approved DB apply.
WITH targets AS (
  SELECT
    'arvc_internal.audio_analysis_reserve(uuid)'::regprocedure AS reserve_fn,
    'arvc_internal.audio_analysis_start(uuid)'::regprocedure AS start_fn,
    'arvc_internal.audio_analysis_release(uuid)'::regprocedure AS release_fn,
    'arvc_internal.audio_analysis_settle(uuid,text,text)'::regprocedure AS settle_fn
), checks AS (
  SELECT 'audio_role_restricted' AS name,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='arvc_audio_analysis'
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit) AS ok
  UNION ALL SELECT 'audio_role_has_no_membership',
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=m.member WHERE r.rolname='arvc_audio_analysis' OR member.rolname='arvc_audio_analysis')
  UNION ALL SELECT 'audio_role_has_only_four_private_rpcs',
    has_function_privilege('arvc_audio_analysis', reserve_fn, 'EXECUTE')
    AND has_function_privilege('arvc_audio_analysis', start_fn, 'EXECUTE')
    AND has_function_privilege('arvc_audio_analysis', release_fn, 'EXECUTE')
    AND has_function_privilege('arvc_audio_analysis', settle_fn, 'EXECUTE')
    AND NOT has_table_privilege('arvc_audio_analysis','public.audio_analysis_entitlements','SELECT')
    AND NOT has_table_privilege('arvc_audio_analysis','public.audio_analysis_control','UPDATE')
    AND NOT has_table_privilege('arvc_audio_analysis','public.audio_analysis_usage','SELECT')
    AND (SELECT count(*)=4 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='arvc_internal' AND p.proname IN ('audio_analysis_reserve','audio_analysis_start','audio_analysis_release','audio_analysis_settle') AND p.proacl IS NOT NULL
        AND pg_catalog.has_function_privilege('arvc_audio_analysis',p.oid,'EXECUTE'))
  FROM targets
  UNION ALL SELECT 'application_roles_cannot_execute_audio_rpcs',
    NOT has_function_privilege('anon', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_ai_budget', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('anon', start_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', start_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', start_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_ai_budget', start_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', start_fn, 'EXECUTE')
    AND NOT has_function_privilege('anon', release_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', release_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', release_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_ai_budget', release_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', release_fn, 'EXECUTE')
    AND NOT has_function_privilege('anon', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_ai_budget', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', settle_fn, 'EXECUTE')
  FROM targets
  UNION ALL SELECT 'private_rpcs_security_definer_and_fixed_search_path',
    (SELECT count(*)=4 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='arvc_internal' AND p.proname IN ('audio_analysis_reserve','audio_analysis_start','audio_analysis_release','audio_analysis_settle')
        AND p.prosecdef AND p.proowner='postgres'::regrole
        AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c='search_path=""'))
  UNION ALL SELECT 'audio_tables_force_rls_and_hide_api_roles',
    (SELECT count(*)=3 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('audio_analysis_entitlements','audio_analysis_control','audio_analysis_usage')
        AND c.relrowsecurity AND c.relforcerowsecurity)
    AND NOT has_table_privilege('anon','public.audio_analysis_entitlements','SELECT')
    AND NOT has_table_privilege('authenticated','public.audio_analysis_control','SELECT')
    AND NOT has_table_privilege('service_role','public.audio_analysis_usage','SELECT')
  UNION ALL SELECT 'control_defaults_fail_closed',
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relname='audio_analysis_control' AND a.attname='enabled' AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='false')
    AND (SELECT count(*)=5 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname='public' AND c.relname='audio_analysis_control'
        AND a.attname IN ('service_daily_limit','service_monthly_limit','concurrent_limit','request_window_seconds','request_window_limit')
        AND pg_catalog.pg_get_expr(d.adbin,d.adrelid)='0')
)
SELECT name, ok FROM checks ORDER BY name;
