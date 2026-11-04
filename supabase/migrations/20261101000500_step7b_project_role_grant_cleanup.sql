-- Remove the temporary membership granted by postgres after ownership transfer.
-- Supabase also creates a protected supabase_admin-granted membership for
-- postgres on user-created roles. The managed postgres role cannot revoke it;
-- it has INHERIT and SET disabled and is not part of the runtime access path.
REVOKE arvc_project_writer FROM postgres GRANTED BY postgres;
