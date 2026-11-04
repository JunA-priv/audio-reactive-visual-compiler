-- Step 7k-42: private Audio Analyze admission and usage ledger.
-- Additive only. Do not apply until local target/backup and role provisioning are approved.
DO $role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'arvc_audio_analysis') THEN
    RAISE EXCEPTION 'arvc_audio_analysis already exists; inspect role state before migration';
  END IF;
  CREATE ROLE arvc_audio_analysis NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
END
$role$;
REVOKE arvc_audio_analysis FROM postgres;

CREATE TABLE public.audio_analysis_entitlements (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  daily_limit integer NOT NULL DEFAULT 0 CHECK (daily_limit >= 0),
  monthly_limit integer NOT NULL DEFAULT 0 CHECK (monthly_limit >= 0),
  concurrent_limit integer NOT NULL DEFAULT 0 CHECK (concurrent_limit >= 0),
  granted_at timestamptz,
  expires_at timestamptz,
  CHECK (NOT enabled OR (daily_limit > 0 AND monthly_limit > 0 AND concurrent_limit > 0 AND granted_at IS NOT NULL))
);
ALTER TABLE public.audio_analysis_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_entitlements FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_entitlements FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget, arvc_audio_analysis;

CREATE TABLE public.audio_analysis_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  service_daily_limit integer NOT NULL DEFAULT 0 CHECK (service_daily_limit >= 0),
  service_monthly_limit integer NOT NULL DEFAULT 0 CHECK (service_monthly_limit >= 0),
  concurrent_limit integer NOT NULL DEFAULT 0 CHECK (concurrent_limit >= 0),
  request_window_seconds integer NOT NULL DEFAULT 0 CHECK (request_window_seconds >= 0),
  request_window_limit integer NOT NULL DEFAULT 0 CHECK (request_window_limit >= 0),
  lease_seconds integer NOT NULL DEFAULT 900 CHECK (lease_seconds BETWEEN 60 AND 1800),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
INSERT INTO public.audio_analysis_control(singleton) VALUES (true);
ALTER TABLE public.audio_analysis_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_control FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_control FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget, arvc_audio_analysis;

CREATE TABLE public.audio_analysis_usage (
  reservation_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','running','succeeded','failed','canceled','expired_charged','released')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  finalized_at timestamptz,
  lease_until timestamptz NOT NULL,
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,64}$'),
  CHECK ((state IN ('reserved','released') AND started_at IS NULL) OR state NOT IN ('reserved','released')),
  CHECK ((state IN ('reserved','running') AND finalized_at IS NULL) OR state NOT IN ('reserved','running')),
  CHECK ((state IN ('running','succeeded','failed','canceled','expired_charged')) = (started_at IS NOT NULL))
);
CREATE INDEX audio_analysis_usage_user_created ON public.audio_analysis_usage(user_id, created_at DESC);
CREATE INDEX audio_analysis_usage_state_lease ON public.audio_analysis_usage(state, lease_until) WHERE state IN ('reserved','running');
CREATE INDEX audio_analysis_usage_started ON public.audio_analysis_usage(started_at) WHERE started_at IS NOT NULL;
ALTER TABLE public.audio_analysis_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_usage FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_usage FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget, arvc_audio_analysis;

GRANT CONNECT ON DATABASE postgres TO arvc_audio_analysis;
GRANT USAGE ON SCHEMA arvc_internal TO arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_reserve(p_user_id uuid)
RETURNS TABLE(result text, reservation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  c public.audio_analysis_control;
  e public.audio_analysis_entitlements;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_day timestamptz;
  v_month timestamptz;
  v_id uuid;
  v_count bigint;
BEGIN
  PERFORM pg_catalog.set_config('TimeZone', 'UTC', true);
  v_day := pg_catalog.date_trunc('day', v_now);
  v_month := pg_catalog.date_trunc('month', v_now);
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton FOR UPDATE;

  -- Expired upload reservations are released; expired inference leases remain charged.
  UPDATE public.audio_analysis_usage SET state='released', finalized_at=v_now, lease_until=v_now
    WHERE state='reserved' AND lease_until <= v_now;
  UPDATE public.audio_analysis_usage SET state='expired_charged', finalized_at=v_now, lease_until=v_now, safe_error_code='lease_expired'
    WHERE state='running' AND lease_until <= v_now;
  DELETE FROM public.audio_analysis_usage WHERE finalized_at < v_now - interval '90 days';

  IF c.singleton IS DISTINCT FROM true OR NOT c.enabled OR c.service_daily_limit <= 0 OR c.service_monthly_limit <= 0
    OR c.concurrent_limit <= 0 OR c.request_window_seconds <= 0 OR c.request_window_limit <= 0 THEN
    RETURN QUERY SELECT 'disabled'::text, NULL::uuid; RETURN;
  END IF;
  IF p_user_id IS NULL THEN RETURN QUERY SELECT 'invalid'::text, NULL::uuid; RETURN; END IF;
  SELECT * INTO e FROM public.audio_analysis_entitlements WHERE user_id=p_user_id FOR SHARE;
  IF NOT FOUND OR NOT e.enabled OR e.expires_at IS NOT NULL AND e.expires_at <= v_now
    OR e.daily_limit <= 0 OR e.monthly_limit <= 0 OR e.concurrent_limit <= 0 THEN
    RETURN QUERY SELECT 'not_entitled'::text, NULL::uuid; RETURN;
  END IF;

  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage
    WHERE user_id=p_user_id AND created_at > v_now - pg_catalog.make_interval(secs => c.request_window_seconds);
  IF v_count >= c.request_window_limit THEN RETURN QUERY SELECT 'rate_limited'::text, NULL::uuid; RETURN; END IF;

  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage u
    WHERE u.started_at >= v_day OR (u.state='reserved' AND u.created_at >= v_day);
  IF v_count >= c.service_daily_limit THEN RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid; RETURN; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage u
    WHERE u.started_at >= v_month OR (u.state='reserved' AND u.created_at >= v_month);
  IF v_count >= c.service_monthly_limit THEN RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid; RETURN; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage u
    WHERE u.user_id=p_user_id AND (u.started_at >= v_day OR (u.state='reserved' AND u.created_at >= v_day));
  IF v_count >= e.daily_limit THEN RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid; RETURN; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage u
    WHERE u.user_id=p_user_id AND (u.started_at >= v_month OR (u.state='reserved' AND u.created_at >= v_month));
  IF v_count >= e.monthly_limit THEN RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid; RETURN; END IF;

  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage
    WHERE state IN ('reserved','running') AND lease_until > v_now;
  IF v_count >= c.concurrent_limit THEN RETURN QUERY SELECT 'concurrency_exceeded'::text, NULL::uuid; RETURN; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage
    WHERE user_id=p_user_id AND state IN ('reserved','running') AND lease_until > v_now;
  IF v_count >= e.concurrent_limit THEN RETURN QUERY SELECT 'concurrency_exceeded'::text, NULL::uuid; RETURN; END IF;

  INSERT INTO public.audio_analysis_usage(user_id,state,lease_until)
    VALUES (p_user_id,'reserved',v_now + pg_catalog.make_interval(secs => c.lease_seconds))
    RETURNING audio_analysis_usage.reservation_id INTO v_id;
  RETURN QUERY SELECT 'reserved'::text, v_id;
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_reserve(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_reserve(uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_reserve(uuid) TO arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_start(p_reservation_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  c public.audio_analysis_control;
  u public.audio_analysis_usage;
  e public.audio_analysis_entitlements;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_day timestamptz;
  v_month timestamptz;
  v_count bigint;
BEGIN
  PERFORM pg_catalog.set_config('TimeZone', 'UTC', true);
  v_day := pg_catalog.date_trunc('day', v_now);
  v_month := pg_catalog.date_trunc('month', v_now);
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  IF c.singleton IS DISTINCT FROM true OR NOT c.enabled OR c.service_daily_limit <= 0 OR c.service_monthly_limit <= 0 OR c.concurrent_limit <= 0
    OR c.request_window_seconds <= 0 OR c.request_window_limit <= 0 THEN RETURN 'disabled'; END IF;
  SELECT * INTO u FROM public.audio_analysis_usage WHERE reservation_id=p_reservation_id FOR UPDATE;
  IF NOT FOUND OR u.state <> 'reserved' THEN RETURN 'invalid'; END IF;
  IF u.lease_until <= v_now THEN
    UPDATE public.audio_analysis_usage SET state='released', finalized_at=v_now, lease_until=v_now WHERE reservation_id=p_reservation_id;
    RETURN 'expired';
  END IF;
  SELECT * INTO e FROM public.audio_analysis_entitlements WHERE user_id=u.user_id FOR SHARE;
  IF NOT FOUND OR NOT e.enabled OR e.expires_at IS NOT NULL AND e.expires_at <= v_now
    OR e.daily_limit <= 0 OR e.monthly_limit <= 0 OR e.concurrent_limit <= 0 THEN RETURN 'not_entitled'; END IF;

  -- Recheck current UTC buckets so an upload crossing midnight/month-end cannot bypass limits.
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.reservation_id <> p_reservation_id AND (x.started_at >= v_day OR (x.state='reserved' AND x.created_at >= v_day));
  IF v_count >= c.service_daily_limit THEN RETURN 'quota_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.reservation_id <> p_reservation_id AND (x.started_at >= v_month OR (x.state='reserved' AND x.created_at >= v_month));
  IF v_count >= c.service_monthly_limit THEN RETURN 'quota_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.user_id=u.user_id AND x.reservation_id <> p_reservation_id AND (x.started_at >= v_day OR (x.state='reserved' AND x.created_at >= v_day));
  IF v_count >= e.daily_limit THEN RETURN 'quota_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.user_id=u.user_id AND x.reservation_id <> p_reservation_id AND (x.started_at >= v_month OR (x.state='reserved' AND x.created_at >= v_month));
  IF v_count >= e.monthly_limit THEN RETURN 'quota_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.state IN ('reserved','running') AND x.lease_until > v_now AND x.reservation_id <> p_reservation_id;
  IF v_count >= c.concurrent_limit THEN RETURN 'concurrency_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.user_id=u.user_id AND x.state IN ('reserved','running') AND x.lease_until > v_now AND x.reservation_id <> p_reservation_id;
  IF v_count >= e.concurrent_limit THEN RETURN 'concurrency_exceeded'; END IF;

  UPDATE public.audio_analysis_usage SET state='running', started_at=v_now, lease_until=v_now + pg_catalog.make_interval(secs => c.lease_seconds)
    WHERE reservation_id=p_reservation_id;
  RETURN 'started';
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_start(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_start(uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_start(uuid) TO arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_release(p_reservation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE u public.audio_analysis_usage; v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  SELECT * INTO u FROM public.audio_analysis_usage WHERE reservation_id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF u.state='released' THEN RETURN true; END IF;
  IF u.state <> 'reserved' THEN RETURN false; END IF;
  UPDATE public.audio_analysis_usage SET state='released', finalized_at=v_now, lease_until=v_now WHERE reservation_id=p_reservation_id;
  RETURN true;
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_release(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_release(uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_release(uuid) TO arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_settle(p_reservation_id uuid, p_state text, p_safe_error_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE u public.audio_analysis_usage; v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_reservation_id IS NULL OR p_state IS NULL OR p_state NOT IN ('succeeded','failed','canceled')
    OR (p_safe_error_code IS NOT NULL AND p_safe_error_code !~ '^[a-z0-9_]{1,64}$') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='invalid_audio_analysis_settlement';
  END IF;
  SELECT * INTO u FROM public.audio_analysis_usage WHERE reservation_id=p_reservation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF u.state=p_state THEN RETURN true; END IF;
  IF u.state <> 'running' THEN RETURN false; END IF;
  UPDATE public.audio_analysis_usage SET state=p_state, finalized_at=v_now, lease_until=v_now, safe_error_code=p_safe_error_code
    WHERE reservation_id=p_reservation_id;
  RETURN true;
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_settle(uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_settle(uuid,text,text) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_settle(uuid,text,text) TO arvc_audio_analysis;

COMMENT ON TABLE public.audio_analysis_entitlements IS 'Step 7k-42: operator-managed Audio Analyze eligibility and explicit per-user limits; default deny.';
COMMENT ON TABLE public.audio_analysis_control IS 'Step 7k-42: private service quota, concurrency, burst limit, lease policy and global kill switch.';
COMMENT ON TABLE public.audio_analysis_usage IS 'Step 7k-42: reservation and minimal charged-attempt ledger; no media, filename, token, or request payload.';
