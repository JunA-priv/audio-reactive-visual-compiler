-- Read-only Step 7g privilege and RLS checks for the local Supabase database.
WITH target AS (
  SELECT
    'arvc_internal.ai_generation_reserve(uuid,bytea)'::regprocedure AS reserve_fn,
    'arvc_internal.ai_generation_reserve_local_fixture(uuid,bytea)'::regprocedure AS fixture_fn,
    'arvc_internal.ai_generation_settle(uuid, text, integer, integer, text)'::regprocedure AS settle_fn
), checks AS (
  SELECT 'budget_role_restricted' AS name,
    EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='arvc_ai_budget'
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls AND NOT rolinherit) AS ok
  UNION ALL SELECT 'budget_role_no_memberships',
    NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
      WHERE (m.roleid='arvc_ai_budget'::regrole OR m.member='arvc_ai_budget'::regrole)
        AND NOT (m.roleid='arvc_ai_budget'::regrole AND m.member='postgres'::regrole
          AND m.grantor='supabase_admin'::regrole AND m.admin_option
          AND NOT m.inherit_option AND NOT m.set_option))
  UNION ALL SELECT 'budget_role_private_rpc_only',
    has_function_privilege('arvc_ai_budget', reserve_fn, 'EXECUTE')
    AND has_function_privilege('arvc_ai_budget', fixture_fn, 'EXECUTE')
    AND has_function_privilege('arvc_ai_budget', settle_fn, 'EXECUTE')
    AND NOT has_table_privilege('arvc_ai_budget','public.ai_entitlements','SELECT')
    AND NOT has_table_privilege('arvc_ai_budget','public.ai_budget_control','UPDATE')
    AND NOT has_table_privilege('arvc_ai_budget','public.ai_generation_usage','SELECT')
  FROM target
  UNION ALL SELECT 'app_roles_cannot_execute_private_rpcs',
    NOT has_function_privilege('anon', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', reserve_fn, 'EXECUTE')
    AND NOT has_function_privilege('anon', fixture_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', fixture_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', fixture_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', fixture_fn, 'EXECUTE')
    AND NOT has_function_privilege('anon', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('authenticated', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('service_role', settle_fn, 'EXECUTE')
    AND NOT has_function_privilege('arvc_asset_verifier', settle_fn, 'EXECUTE')
  FROM target
  UNION ALL SELECT 'private_rpc_hardening',
    (SELECT count(*)=3 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='arvc_internal' AND p.proname IN ('ai_generation_reserve','ai_generation_reserve_local_fixture','ai_generation_settle')
        AND p.prosecdef AND p.proowner='postgres'::regrole
        AND EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c='search_path=""'))
  UNION ALL SELECT 'ai_tables_force_rls',
    (SELECT count(*)=3 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('ai_entitlements','ai_budget_control','ai_generation_usage')
        AND c.relrowsecurity AND c.relforcerowsecurity)
  UNION ALL SELECT 'ai_tables_hidden_from_api_roles',
    NOT has_table_privilege('anon','public.ai_entitlements','SELECT')
    AND NOT has_table_privilege('authenticated','public.ai_entitlements','SELECT')
    AND NOT has_table_privilege('service_role','public.ai_generation_usage','SELECT')
  UNION ALL SELECT 'openai_policy_row',
    EXISTS (SELECT 1 FROM public.ai_budget_control WHERE singleton AND enabled
      AND model='gpt-6-luna' AND pricing_version='gpt-6-luna-standard-2026-11-01'
      AND input_microusd_per_million=100000 AND output_microusd_per_million=500000
      AND user_daily_requests=2 AND user_monthly_requests=10
      AND service_daily_requests=5 AND service_monthly_requests=20 AND max_input_tokens=8000
      AND max_output_tokens=4000 AND max_concurrent_global=2 AND max_concurrent_user=1
      AND service_monthly_budget_microusd=1500000)
  UNION ALL SELECT 'fixture_quota_exemption_is_default_false',
    EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum WHERE n.nspname='public'
      AND c.relname='ai_generation_usage' AND a.attname='quota_exempt' AND a.attnotnull
      AND pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)='false')
  UNION ALL SELECT 'normal_reservations_exclude_only_marked_fixture_rows',
    pg_catalog.strpos(pg_catalog.pg_get_functiondef('arvc_internal.ai_generation_reserve(uuid,bytea)'::regprocedure), 'NOT u.quota_exempt') > 0
  UNION ALL SELECT 'fixture_rpc_retains_kill_switch_entitlement_and_idempotency',
    pg_catalog.strpos(pg_catalog.pg_get_functiondef('arvc_internal.ai_generation_reserve_local_fixture(uuid,bytea)'::regprocedure), 'NOT FOUND OR NOT c.enabled') > 0
    AND pg_catalog.strpos(pg_catalog.pg_get_functiondef('arvc_internal.ai_generation_reserve_local_fixture(uuid,bytea)'::regprocedure), 'ai_entitlements') > 0
    AND pg_catalog.strpos(pg_catalog.pg_get_functiondef('arvc_internal.ai_generation_reserve_local_fixture(uuid,bytea)'::regprocedure), 'duplicate') > 0
)
SELECT name, ok FROM checks ORDER BY name;
