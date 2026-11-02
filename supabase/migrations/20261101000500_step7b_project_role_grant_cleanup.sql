-- Supabase local's postgres role cannot revoke a grant made by the reserved
-- supabase_admin role. Apply this cleanup as supabase_admin locally only.
REVOKE arvc_project_writer FROM postgres GRANTED BY postgres;
REVOKE arvc_project_writer FROM postgres GRANTED BY supabase_admin;
