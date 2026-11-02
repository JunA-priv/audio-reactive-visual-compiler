-- Supabase grants broad default privileges to service_role. This application
-- table is intentionally not part of a service_role CRUD path.
REVOKE ALL ON TABLE public.projects FROM service_role;
