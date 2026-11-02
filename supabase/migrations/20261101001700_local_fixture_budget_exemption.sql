-- Step 7g-3: distinguish local-fixture reservations from billable/quota usage.
-- This migration does not grant app callers access to the usage table or RPC.
ALTER TABLE public.ai_generation_usage
  ADD COLUMN quota_exempt boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION arvc_internal.ai_generation_reserve(
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
  IF (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.created_at >= pg_catalog.date_trunc('day', v_now)) >= c.service_daily_requests
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.created_at >= pg_catalog.date_trunc('month', v_now)) >= c.service_monthly_requests
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.user_id=p_user_id AND u.created_at >= pg_catalog.date_trunc('day', v_now)) >= c.user_daily_requests
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.user_id=p_user_id AND u.created_at >= pg_catalog.date_trunc('month', v_now)) >= c.user_monthly_requests THEN
    RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.state='reserved' AND u.lease_until > v_now) >= c.max_concurrent_global
    OR (SELECT pg_catalog.count(*) FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.user_id=p_user_id AND u.state='reserved' AND u.lease_until > v_now) >= c.max_concurrent_user THEN
    RETURN QUERY SELECT 'concurrency_exceeded'::text, NULL::uuid, NULL::text, NULL::integer, NULL::integer; RETURN;
  END IF;
  v_cost := ((c.max_input_tokens::bigint * c.input_microusd_per_million) + (c.max_output_tokens::bigint * c.output_microusd_per_million)) / 1000000;
  IF (SELECT COALESCE(pg_catalog.sum(CASE WHEN u.state IN ('reserved','usage_unknown') THEN u.reserved_cost_microusd ELSE COALESCE(u.actual_cost_microusd,0) END),0)
      FROM public.ai_generation_usage u WHERE NOT u.quota_exempt AND u.created_at >= pg_catalog.date_trunc('month', v_now)) + v_cost > c.service_monthly_budget_microusd THEN
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

CREATE FUNCTION arvc_internal.ai_generation_reserve_local_fixture(
  p_user_id uuid, p_idempotency_hash bytea
) RETURNS TABLE(result text, request_id uuid, model text, max_input_tokens integer, max_output_tokens integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  c public.ai_budget_control;
  v_request uuid;
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
  INSERT INTO public.ai_generation_usage(user_id,idempotency_hash,model,pricing_version,input_price_microusd_per_million,output_price_microusd_per_million,state,reserved_input_tokens,reserved_output_tokens,reserved_cost_microusd,lease_until,quota_exempt)
  VALUES (p_user_id,p_idempotency_hash,c.model,c.pricing_version,0,0,'reserved',c.max_input_tokens,c.max_output_tokens,0,v_now + interval '3 minutes',true)
  RETURNING ai_generation_usage.request_id INTO v_request;
  RETURN QUERY SELECT 'reserved'::text, v_request, c.model, c.max_input_tokens, c.max_output_tokens;
END
$function$;
ALTER FUNCTION arvc_internal.ai_generation_reserve_local_fixture(uuid, bytea) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.ai_generation_reserve_local_fixture(uuid, bytea) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier;
GRANT EXECUTE ON FUNCTION arvc_internal.ai_generation_reserve_local_fixture(uuid, bytea) TO arvc_ai_budget;

COMMENT ON COLUMN public.ai_generation_usage.quota_exempt IS 'True only for local fixture reservations admitted by the server-side developer UUID gate; excluded from shared quotas and cost.';
