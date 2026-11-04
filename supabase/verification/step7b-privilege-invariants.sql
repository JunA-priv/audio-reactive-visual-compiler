-- Step 7b catalog-only verification. Read-only SELECTs; no role or data changes.
-- Run against a local database after all migrations 001-008 have succeeded.
WITH checks AS (
  SELECT 'migration_history_001_008'::text AS check_name,
         (SELECT count(*) = 8 FROM supabase_migrations.schema_migrations
          WHERE version IN ('20261101000100','20261101000200','20261101000300','20261101000400',
                            '20261101000500','20261101000600','20261101000700','20261101000800')) AS passed,
         'all eight migration versions recorded'::text AS expected
  UNION ALL
  SELECT 'projects_owner_rls_force',
         EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
                 WHERE c.oid='public.projects'::regclass AND r.rolname='postgres'
                   AND c.relrowsecurity AND c.relforcerowsecurity),
         'owner=postgres, RLS enabled and forced'
  UNION ALL
  SELECT 'helper_role_restricted',
         EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname='arvc_project_writer'
                 AND NOT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolcreatedb
                 AND NOT r.rolcreaterole AND NOT r.rolbypassrls)
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members m
                         WHERE (m.roleid=(SELECT oid FROM pg_roles WHERE rolname='arvc_project_writer')
                            OR m.member=(SELECT oid FROM pg_roles WHERE rolname='arvc_project_writer'))
                           AND NOT (
                             m.roleid=(SELECT oid FROM pg_roles WHERE rolname='arvc_project_writer')
                             AND m.member=(SELECT oid FROM pg_roles WHERE rolname='postgres')
                             AND m.grantor=(SELECT oid FROM pg_roles WHERE rolname='supabase_admin')
                             AND m.admin_option
                             AND NOT m.inherit_option
                             AND NOT m.set_option
                           )),
         'restricted role; only the protected non-inheriting, non-settable Supabase bootstrap membership may remain'
  UNION ALL
  SELECT 'helper_schema_grants_removed',
         NOT has_schema_privilege('arvc_project_writer','public','CREATE')
         AND NOT has_schema_privilege('arvc_project_writer','auth','USAGE'),
         'no CREATE on public and no USAGE on auth'
  UNION ALL
  SELECT 'helper_column_grants_minimal',
         has_table_privilege('arvc_project_writer','public.projects','SELECT')
         AND NOT has_table_privilege('arvc_project_writer','public.projects','UPDATE')
         AND has_column_privilege('arvc_project_writer','public.projects','title','UPDATE')
         AND has_column_privilege('arvc_project_writer','public.projects','document','UPDATE')
         AND has_column_privilege('arvc_project_writer','public.projects','revision','UPDATE')
         AND has_column_privilege('arvc_project_writer','public.projects','updated_at','UPDATE')
         AND NOT has_column_privilege('arvc_project_writer','public.projects','owner_id','UPDATE')
         AND NOT has_column_privilege('arvc_project_writer','public.projects','id','UPDATE')
         AND NOT has_column_privilege('arvc_project_writer','public.projects','created_at','UPDATE'),
         'SELECT plus update only title/document/revision/updated_at'
  UNION ALL
  SELECT 'application_roles_table_acl',
         NOT has_table_privilege('anon','public.projects','SELECT')
         AND NOT has_table_privilege('anon','public.projects','INSERT')
         AND NOT has_table_privilege('anon','public.projects','UPDATE')
         AND NOT has_table_privilege('anon','public.projects','DELETE')
         AND has_table_privilege('authenticated','public.projects','SELECT')
         AND has_table_privilege('authenticated','public.projects','DELETE')
         AND NOT has_table_privilege('authenticated','public.projects','UPDATE')
         AND has_column_privilege('authenticated','public.projects','title','INSERT')
         AND has_column_privilege('authenticated','public.projects','document','INSERT')
         AND NOT has_column_privilege('authenticated','public.projects','owner_id','INSERT')
         AND NOT has_table_privilege('service_role','public.projects','SELECT')
         AND NOT has_table_privilege('service_role','public.projects','INSERT')
         AND NOT has_table_privilege('service_role','public.projects','UPDATE')
         AND NOT has_table_privilege('service_role','public.projects','DELETE'),
         'anon/service_role denied; authenticated owner-scoped select/delete and limited insert'
  UNION ALL
  SELECT 'update_rpc_security_boundary',
         EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
                 WHERE p.oid='public.update_project(uuid,bigint,text,jsonb)'::regprocedure
                   AND r.rolname='arvc_project_writer' AND p.prosecdef
                   AND p.proconfig @> ARRAY['search_path=""']::text[])
         AND has_function_privilege('authenticated','public.update_project(uuid,bigint,text,jsonb)','EXECUTE')
         AND NOT has_function_privilege('anon','public.update_project(uuid,bigint,text,jsonb)','EXECUTE')
         AND NOT has_function_privilege('service_role','public.update_project(uuid,bigint,text,jsonb)','EXECUTE'),
         'SECURITY DEFINER owned by helper, empty search_path, execute only for authenticated'
  UNION ALL
  SELECT 'update_policy_helper_only',
         EXISTS (SELECT 1 FROM pg_policies p
                 WHERE p.schemaname='public' AND p.tablename='projects'
                   AND p.policyname='projects_update_owner' AND p.cmd='UPDATE'
                   AND p.roles=ARRAY['arvc_project_writer'::name]
                   AND p.qual IS NOT NULL AND p.with_check IS NOT NULL),
         'update RLS policy scopes helper role with USING and WITH CHECK'
  UNION ALL
  SELECT 'limit_trigger_security',
         EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
                 JOIN pg_roles r ON r.oid=p.proowner
                 WHERE t.tgrelid='public.projects'::regclass
                   AND t.tgname='projects_enforce_limits' AND t.tgenabled <> 'D'
                   AND p.prosecdef AND r.rolname='postgres'
                   AND p.proconfig @> ARRAY['search_path=""']::text[]),
         'enabled SECURITY DEFINER trigger, postgres owner, empty search_path'
)
SELECT check_name, passed, expected
FROM checks
ORDER BY check_name;
