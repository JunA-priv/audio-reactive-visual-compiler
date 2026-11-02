-- PostgreSQL may record the role creator as a member of a newly created role.
-- The runtime verifier must have no role memberships or inheritance path.
REVOKE arvc_asset_verifier FROM postgres;
