-- Step 7g: server-only AI entitlement and atomic usage admission.
-- Apply only after local schema backup and target confirmation.
DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'arvc_ai_budget') THEN
    RAISE EXCEPTION 'arvc_ai_budget already exists; inspect role state before migration';
  END IF;
  CREATE ROLE arvc_ai_budget NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END
$role$;
-- PostgreSQL may grant the migration role membership in a newly-created role;
-- remove that authority so postgres is not an implicit role administrator.
REVOKE arvc_ai_budget FROM postgres;

CREATE TABLE public.ai_entitlements (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  granted_at timestamptz,
  granted_by text,
  expires_at timestamptz,
  CONSTRAINT ai_entitlements_grant_consistent CHECK (NOT enabled OR granted_at IS NOT NULL)
);
ALTER TABLE public.ai_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_entitlements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_entitlements FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;

CREATE TABLE public.ai_budget_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT true,
  model text NOT NULL DEFAULT 'gemini-3.8-flash' CHECK (model = 'gemini-3.8-flash'),
  pricing_version text NOT NULL DEFAULT 'gemini-3.8-flash-2026-12-31',
  input_microusd_per_million bigint NOT NULL DEFAULT 750000 CHECK (input_microusd_per_million >= 0),
  output_microusd_per_million bigint NOT NULL DEFAULT 3750000 CHECK (output_microusd_per_million >= 0),
  user_daily_requests integer NOT NULL DEFAULT 2 CHECK (user_daily_requests > 0),
  user_monthly_requests integer NOT NULL DEFAULT 10 CHECK (user_monthly_requests > 0),
  service_daily_requests integer NOT NULL DEFAULT 5 CHECK (service_daily_requests > 0),
  service_monthly_requests integer NOT NULL DEFAULT 20 CHECK (service_monthly_requests > 0),
  max_input_tokens integer NOT NULL DEFAULT 8000 CHECK (max_input_tokens BETWEEN 1 AND 8000),
  max_output_tokens integer NOT NULL DEFAULT 4000 CHECK (max_output_tokens BETWEEN 1 AND 4000),
  max_concurrent_global integer NOT NULL DEFAULT 2 CHECK (max_concurrent_global > 0),
  max_concurrent_user integer NOT NULL DEFAULT 1 CHECK (max_concurrent_user > 0),
  service_monthly_budget_microusd bigint NOT NULL DEFAULT 1500000 CHECK (service_monthly_budget_microusd BETWEEN 1 AND 1500000),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.ai_budget_control(singleton) VALUES (true);
ALTER TABLE public.ai_budget_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_budget_control FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_budget_control FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;

CREATE TABLE public.ai_generation_usage (
  request_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_hash bytea NOT NULL CHECK (pg_catalog.octet_length(idempotency_hash) = 32),
  model text NOT NULL,
  pricing_version text NOT NULL,
  input_price_microusd_per_million bigint NOT NULL,
  output_price_microusd_per_million bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved', 'succeeded', 'failed_known', 'usage_unknown')),
  reserved_input_tokens integer NOT NULL,
  reserved_output_tokens integer NOT NULL,
  reserved_cost_microusd bigint NOT NULL,
  actual_input_tokens integer,
  actual_output_tokens integer,
  actual_cost_microusd bigint,
  safe_error_code text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  settled_at timestamptz,
  lease_until timestamptz NOT NULL,
  UNIQUE(user_id, idempotency_hash),
  CHECK (reserved_input_tokens > 0 AND reserved_output_tokens > 0 AND reserved_cost_microusd >= 0),
  CHECK (actual_input_tokens IS NULL OR actual_input_tokens >= 0),
  CHECK (actual_output_tokens IS NULL OR actual_output_tokens >= 0),
  CHECK (actual_cost_microusd IS NULL OR actual_cost_microusd >= 0)
);
CREATE INDEX ai_generation_usage_user_created ON public.ai_generation_usage(user_id, created_at DESC);
CREATE INDEX ai_generation_usage_lease ON public.ai_generation_usage(lease_until) WHERE state = 'reserved';
ALTER TABLE public.ai_generation_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_generation_usage FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_generation_usage FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;

GRANT CONNECT ON DATABASE postgres TO arvc_ai_budget;
GRANT USAGE ON SCHEMA arvc_internal TO arvc_ai_budget;

CREATE FUNCTION arvc_internal.ai_generation_reserve(
  p_user_id uuid, p_idempotency_hash bytea
) RETURNS TABLE(result text, request_id uuid, model text, max_input_tokens integer, max_output_tokens integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  c public.ai_budget_control;
  v_request uuid;
  v_cost bigint;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('TimeZone', 'UTC', true);
  IF p_user_id IS NULL OR p_idempotency_hash IS NULL OR pg_catalog.octet_length(p_idempotency_hash) <> 32 THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  SELECT * INTO c FROM public.ai_budget_control WHERE singleton FOR UPDATE;
  IF NOT FOUND OR NOT c.enabled THEN
    RETURN QUERY SELECT 'disabled'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.ai_entitlements e
    WHERE e.user_id = p_user_id AND e.enabled AND (e.expires_at IS NULL OR e.expires_at > v_now)
  ) THEN
    RETURN QUERY SELECT 'not_entitled'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.ai_generation_usage u WHERE u.user_id=p_user_id AND u.idempotency_hash=p_idempotency_hash) THEN
    RETURN QUERY SELECT 'duplicate'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE u.created_at >= pg_catalog.date_trunc('day', v_now)) >= c.service_daily_requests
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE u.created_at >= pg_catalog.date_trunc('month', v_now)) >= c.service_monthly_requests
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE u.user_id=p_user_id AND u.created_at >= pg_catalog.date_trunc('day', v_now)) >= c.user_daily_requests
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE u.user_id=p_user_id AND u.created_at >= pg_catalog.date_trunc('month', v_now)) >= c.user_monthly_requests THEN
    RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE u.state='reserved' AND u.lease_until > v_now) >= c.max_concurrent_global
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE u.user_id=p_user_id AND u.state='reserved' AND u.lease_until > v_now) >= c.max_concurrent_user THEN
    RETURN QUERY SELECT 'concurrency_exceeded'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  v_cost := ((c.max_input_tokens::bigint * c.input_microusd_per_million) + (c.max_output_tokens::bigint * c.output_microusd_per_million)) / 1000000;
  IF (SELECT COALESCE(pg_catalog.sum(CASE WHEN u.state IN ('reserved','usage_unknown') THEN u.reserved_cost_microusd ELSE COALESCE(u.actual_cost_microusd,0) END),0)
      FROM public.ai_generation_usage u WHERE u.created_at >= pg_catalog.date_trunc('month', v_now)) + v_cost > c.service_monthly_budget_microusd THEN
    RETURN QUERY SELECT 'budget_exceeded'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  INSERT INTO public.ai_generation_usage(user_id,idempotency_hash,model,pricing_version,input_price_microusd_per_million,output_price_microusd_per_million,state,reserved_input_tokens,reserved_output_tokens,reserved_cost_microusd,lease_until)
  VALUES (p_user_id,p_idempotency_hash,c.model,c.pricing_version,c.input_microusd_per_million,c.output_microusd_per_million,'reserved',c.max_input_tokens,c.max_output_tokens,v_cost,v_now + interval '3 minutes')
  RETURNING ai_generation_usage.request_id INTO v_request;
  RETURN QUERY SELECT 'reserved'::text, v_request, c.model, c.max_input_tokens, c.max_output_tokens;
END
$function$;
ALTER FUNCTION arvc_internal.ai_generation_reserve(uuid, bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.ai_generation_reserve(uuid, bytea) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier;
GRANT EXECUTE ON FUNCTION arvc_internal.ai_generation_reserve(uuid, bytea) TO arvc_ai_budget;

CREATE FUNCTION arvc_internal.ai_generation_settle(
  p_request_id uuid, p_state text, p_input_tokens integer, p_output_tokens integer, p_error_code text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  u public.ai_generation_usage;
  v_cost bigint;
BEGIN
  PERFORM pg_catalog.set_config('TimeZone', 'UTC', true);
  IF p_request_id IS NULL OR p_state IS NULL OR p_input_tokens IS NULL OR p_output_tokens IS NULL
    OR p_state NOT IN ('succeeded','failed_known','usage_unknown') OR p_input_tokens < 0 OR p_output_tokens < 0
    OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z0-9_]{1,64}$') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_ai_settlement';
  END IF;
  SELECT * INTO u FROM public.ai_generation_usage WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND OR u.state <> 'reserved' THEN RETURN false; END IF;
  IF p_input_tokens > u.reserved_input_tokens OR p_output_tokens > u.reserved_output_tokens THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='ai_settlement_exceeds_reservation';
  END IF;
  IF p_state = 'usage_unknown' THEN
    UPDATE public.ai_generation_usage SET state=p_state, safe_error_code=p_error_code, settled_at=pg_catalog.clock_timestamp(), lease_until=pg_catalog.clock_timestamp() WHERE request_id=p_request_id;
    RETURN true;
  END IF;
  v_cost := ((p_input_tokens::bigint*u.input_price_microusd_per_million)+(p_output_tokens::bigint*u.output_price_microusd_per_million))/1000000;
  UPDATE public.ai_generation_usage SET state=p_state, actual_input_tokens=p_input_tokens, actual_output_tokens=p_output_tokens,
    actual_cost_microusd=v_cost, safe_error_code=p_error_code, settled_at=pg_catalog.clock_timestamp(), lease_until=pg_catalog.clock_timestamp()
    WHERE request_id=p_request_id;
  RETURN true;
END
$function$;
ALTER FUNCTION arvc_internal.ai_generation_settle(uuid,text,integer,integer,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.ai_generation_settle(uuid,text,integer,integer,text) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier;
GRANT EXECUTE ON FUNCTION arvc_internal.ai_generation_settle(uuid,text,integer,integer,text) TO arvc_ai_budget;

COMMENT ON TABLE public.ai_entitlements IS 'Step 7g: operator-managed AI eligibility; default deny.';
COMMENT ON TABLE public.ai_budget_control IS 'Step 7g: private operator-managed request/token/cost/concurrency policy and global kill switch.';
COMMENT ON TABLE public.ai_generation_usage IS 'Step 7g: no prompt or media data; idempotency hashes retained to prevent re-execution.';
