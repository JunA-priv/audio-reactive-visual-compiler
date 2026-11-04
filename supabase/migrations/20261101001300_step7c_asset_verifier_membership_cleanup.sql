-- Remove the postgres-granted link. Supabase's protected bootstrap membership
-- remains non-inheriting and non-settable and is not a runtime access path.
REVOKE arvc_asset_verifier FROM postgres;
