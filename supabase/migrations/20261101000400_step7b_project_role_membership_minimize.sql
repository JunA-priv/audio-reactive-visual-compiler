-- The local migration runner retains a non-inheriting membership after the
-- helper role transfer. Disable all membership capabilities on that link.
GRANT arvc_project_writer TO postgres
  WITH ADMIN FALSE, INHERIT FALSE, SET FALSE;
