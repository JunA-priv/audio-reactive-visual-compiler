-- The SECURITY DEFINER update RPC needs schema lookup permission for auth.uid().
GRANT USAGE ON SCHEMA auth TO arvc_project_writer;
