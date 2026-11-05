-- Step 7k-56: explicitly scope Audio Analyze entitlements to a tier and
-- deployment environment. Beta skips per-user day/month counters only; global
-- service quotas, burst limits, queue/storage bounds, concurrency and kill
-- switch remain enforced.
ALTER TABLE public.audio_analysis_entitlements
  ADD COLUMN access_tier text NOT NULL DEFAULT 'standard'
    CHECK (access_tier IN ('standard','beta')),
  ADD COLUMN deployment_environment text NOT NULL DEFAULT 'local'
    CHECK (deployment_environment IN ('local','hosted')),
  ADD CONSTRAINT audio_analysis_beta_expiry_required
    CHECK (access_tier <> 'beta' OR expires_at IS NOT NULL);

ALTER TABLE public.audio_analysis_control
  ADD COLUMN deployment_environment text NOT NULL DEFAULT 'local'
    CHECK (deployment_environment IN ('local','hosted'));

COMMENT ON COLUMN public.audio_analysis_entitlements.access_tier IS
  'standard enforces per-user daily/monthly limits; beta skips only those counters and always requires an explicit expiry.';
COMMENT ON COLUMN public.audio_analysis_entitlements.deployment_environment IS
  'Entitlement is usable only in the environment explicitly selected in audio_analysis_control.';
COMMENT ON COLUMN public.audio_analysis_control.deployment_environment IS
  'Fail-closed scope for environment-bound audio-analysis entitlements; hosted operators must set hosted explicitly.';

CREATE FUNCTION arvc_internal.audio_analysis_environment_matches(p_environment text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT p_environment IN ('local','hosted') AND EXISTS (
    SELECT 1 FROM public.audio_analysis_control c
    WHERE c.singleton AND c.deployment_environment=p_environment
  )
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_environment_matches(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_environment_matches(text) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_environment_matches(text) TO arvc_audio_analysis;

CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_job_submit(
  p_user_id uuid, p_key text, p_hash bytea, p_audio bytea, p_gate text
) RETURNS TABLE(result text, job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_id uuid; v_now timestamptz:=pg_catalog.clock_timestamp(); v_existing public.audio_analysis_jobs; c public.audio_analysis_control;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton;
  IF p_user_id IS NULL OR p_key IS NULL OR p_hash IS NULL OR p_audio IS NULL OR p_gate IS NULL OR p_gate NOT IN ('off','soft','middle','hard')
    OR p_hash<>extensions.digest(p_audio||pg_catalog.convert_to('|'||p_gate,'UTF8'),'sha256') THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::uuid; RETURN;
  END IF;
  DELETE FROM public.audio_analysis_jobs WHERE created_at<v_now-interval '24 hours' AND state<>'running';
  SELECT * INTO v_existing FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF v_existing.request_hash<>p_hash THEN RETURN QUERY SELECT 'idempotency_conflict'::text,NULL::uuid;
    ELSE
      IF v_existing.state='queued' THEN INSERT INTO public.audio_analysis_job_dispatch(job_id) VALUES(v_existing.job_id) ON CONFLICT ON CONSTRAINT audio_analysis_job_dispatch_pkey DO NOTHING; END IF;
      RETURN QUERY SELECT 'existing'::text,v_existing.job_id;
    END IF;
    RETURN;
  END IF;
  IF NOT c.enabled THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid; RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled
    AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)
    AND e.deployment_environment=c.deployment_environment) THEN
    RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))>=20
    OR (SELECT COALESCE(pg_catalog.sum(pg_catalog.octet_length(audio_wav)),0) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))+pg_catalog.octet_length(p_audio)>335544320 THEN
    RETURN QUERY SELECT 'queue_full'::text,NULL::uuid; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND state='queued')>=2 THEN
    RETURN QUERY SELECT 'user_queue_full'::text,NULL::uuid; RETURN;
  END IF;
  INSERT INTO public.audio_analysis_jobs(user_id,idempotency_key,request_hash,audio_wav,kick_gate_mode)
    VALUES(p_user_id,p_key,p_hash,p_audio,p_gate) RETURNING audio_analysis_jobs.job_id INTO v_id;
  INSERT INTO public.audio_analysis_job_dispatch(job_id) VALUES(v_id);
  RETURN QUERY SELECT 'queued'::text,v_id;
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) TO arvc_audio_analysis;

CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_reserve(p_user_id uuid)
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
  IF NOT FOUND OR NOT e.enabled OR (e.expires_at IS NOT NULL AND e.expires_at <= v_now)
    OR e.deployment_environment <> c.deployment_environment
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

  IF e.access_tier <> 'beta' THEN
    SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage u
      WHERE u.user_id=p_user_id AND (u.started_at >= v_day OR (u.state='reserved' AND u.created_at >= v_day));
    IF v_count >= e.daily_limit THEN RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid; RETURN; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage u
      WHERE u.user_id=p_user_id AND (u.started_at >= v_month OR (u.state='reserved' AND u.created_at >= v_month));
    IF v_count >= e.monthly_limit THEN RETURN QUERY SELECT 'quota_exceeded'::text, NULL::uuid; RETURN; END IF;
  END IF;

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

CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_start(p_reservation_id uuid)
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
  IF c.singleton IS DISTINCT FROM true OR NOT c.enabled OR c.service_daily_limit <= 0 OR c.service_monthly_limit <= 0
    OR c.concurrent_limit <= 0 OR c.request_window_seconds <= 0 OR c.request_window_limit <= 0 THEN RETURN 'disabled'; END IF;
  SELECT * INTO u FROM public.audio_analysis_usage WHERE reservation_id=p_reservation_id FOR UPDATE;
  IF NOT FOUND OR u.state <> 'reserved' THEN RETURN 'invalid'; END IF;
  IF u.lease_until <= v_now THEN
    UPDATE public.audio_analysis_usage SET state='released', finalized_at=v_now, lease_until=v_now WHERE reservation_id=p_reservation_id;
    RETURN 'expired';
  END IF;
  SELECT * INTO e FROM public.audio_analysis_entitlements WHERE user_id=u.user_id FOR SHARE;
  IF NOT FOUND OR NOT e.enabled OR (e.expires_at IS NOT NULL AND e.expires_at <= v_now)
    OR e.deployment_environment <> c.deployment_environment
    OR e.daily_limit <= 0 OR e.monthly_limit <= 0 OR e.concurrent_limit <= 0 THEN RETURN 'not_entitled'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.reservation_id <> p_reservation_id AND (x.started_at >= v_day OR (x.state='reserved' AND x.created_at >= v_day));
  IF v_count >= c.service_daily_limit THEN RETURN 'quota_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
    WHERE x.reservation_id <> p_reservation_id AND (x.started_at >= v_month OR (x.state='reserved' AND x.created_at >= v_month));
  IF v_count >= c.service_monthly_limit THEN RETURN 'quota_exceeded'; END IF;
  IF e.access_tier <> 'beta' THEN
    SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
      WHERE x.user_id=u.user_id AND x.reservation_id <> p_reservation_id AND (x.started_at >= v_day OR (x.state='reserved' AND x.created_at >= v_day));
    IF v_count >= e.daily_limit THEN RETURN 'quota_exceeded'; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.audio_analysis_usage x
      WHERE x.user_id=u.user_id AND x.reservation_id <> p_reservation_id AND (x.started_at >= v_month OR (x.state='reserved' AND x.created_at >= v_month));
    IF v_count >= e.monthly_limit THEN RETURN 'quota_exceeded'; END IF;
  END IF;
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

-- Scope new Storage reservation and job registration at both sides of upload.
CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_storage_intent(
  p_user_id uuid,p_key text,p_hash bytea,p_job_id uuid,p_audio_bytes integer,p_gate text
) RETURNS TABLE(result text,job_id uuid,object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp(); j public.audio_analysis_jobs; i public.audio_analysis_storage_intents; c public.audio_analysis_control;
BEGIN
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  IF p_user_id IS NULL OR p_key IS NULL OR pg_catalog.length(p_key) NOT BETWEEN 1 AND 128 OR p_hash IS NULL OR pg_catalog.octet_length(p_hash)<>32
    OR p_job_id IS NULL OR p_audio_bytes IS NULL OR p_audio_bytes NOT BETWEEN 45 AND 16777216 OR p_gate IS NULL OR p_gate NOT IN ('off','soft','middle','hard') THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF j.request_hash<>p_hash THEN RETURN QUERY SELECT 'idempotency_conflict'::text,NULL::uuid,NULL::text;
    ELSIF j.audio_object_key IS NULL THEN RETURN QUERY SELECT 'existing_legacy'::text,j.job_id,NULL::text;
    ELSE RETURN QUERY SELECT 'existing'::text,j.job_id,j.audio_object_key; END IF;
    RETURN;
  END IF;
  IF NOT c.enabled THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text; RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled
    AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)
    AND e.deployment_environment=c.deployment_environment) THEN
    RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  SELECT * INTO i FROM public.audio_analysis_storage_intents WHERE user_id=p_user_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF i.created_at<=v_now-interval '24 hours' THEN RETURN QUERY SELECT 'expired'::text,NULL::uuid,NULL::text; RETURN; END IF;
    IF i.request_hash<>p_hash OR i.audio_bytes<>p_audio_bytes OR i.kick_gate_mode<>p_gate THEN
      RETURN QUERY SELECT 'idempotency_conflict'::text,NULL::uuid,NULL::text;
    ELSE RETURN QUERY SELECT 'upload'::text,i.job_id,i.object_key; END IF;
    RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))
       +(SELECT pg_catalog.count(*) FROM public.audio_analysis_storage_intents WHERE created_at>v_now-interval '24 hours')>=20
    OR (SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))
       +(SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_storage_intents)
       +(SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_storage_cleanup)+p_audio_bytes>335544320 THEN
    RETURN QUERY SELECT 'queue_full'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  IF (SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND state IN ('queued','running'))
       +(SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_storage_intents WHERE user_id=p_user_id)
       +(SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_storage_cleanup WHERE user_id=p_user_id)+p_audio_bytes>50331648 THEN
    RETURN QUERY SELECT 'user_storage_full'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND state='queued')
       +(SELECT pg_catalog.count(*) FROM public.audio_analysis_storage_intents WHERE user_id=p_user_id AND created_at>v_now-interval '24 hours')>=2 THEN
    RETURN QUERY SELECT 'user_queue_full'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  INSERT INTO public.audio_analysis_storage_intents(user_id,idempotency_key,request_hash,job_id,object_key,audio_bytes,kick_gate_mode)
    VALUES(p_user_id,p_key,p_hash,p_job_id,p_user_id::text||'/'||p_job_id::text||'.wav',p_audio_bytes,p_gate);
  RETURN QUERY SELECT 'upload'::text,p_job_id,p_user_id::text||'/'||p_job_id::text||'.wav';
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_intent(uuid,text,bytea,uuid,integer,text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_job_submit_storage(
  p_user_id uuid,p_key text,p_hash bytea,p_job_id uuid,p_gate text
) RETURNS TABLE(result text,job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp(); i public.audio_analysis_storage_intents; v_existing public.audio_analysis_jobs; c public.audio_analysis_control;
BEGIN
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  IF p_user_id IS NULL OR p_key IS NULL OR pg_catalog.length(p_key) NOT BETWEEN 1 AND 128 OR p_hash IS NULL OR pg_catalog.octet_length(p_hash)<>32
    OR p_job_id IS NULL OR p_gate IS NULL OR p_gate NOT IN ('off','soft','middle','hard') THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::uuid; RETURN;
  END IF;
  SELECT * INTO v_existing FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF v_existing.request_hash<>p_hash THEN RETURN QUERY SELECT 'idempotency_conflict'::text,NULL::uuid;
    ELSE
      IF v_existing.state='queued' THEN INSERT INTO public.audio_analysis_job_dispatch(job_id) VALUES(v_existing.job_id) ON CONFLICT ON CONSTRAINT audio_analysis_job_dispatch_pkey DO NOTHING; END IF;
      RETURN QUERY SELECT 'existing'::text,v_existing.job_id;
    END IF;
    RETURN;
  END IF;
  IF NOT c.enabled THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid; RETURN; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled
    AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)
    AND e.deployment_environment=c.deployment_environment) THEN
    RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid; RETURN;
  END IF;
  SELECT * INTO i FROM public.audio_analysis_storage_intents WHERE user_id=p_user_id AND idempotency_key=p_key FOR UPDATE;
  IF NOT FOUND OR i.created_at<=v_now-interval '24 hours' OR i.job_id<>p_job_id OR i.request_hash<>p_hash OR i.kick_gate_mode<>p_gate THEN RETURN QUERY SELECT 'invalid'::text,NULL::uuid; RETURN; END IF;
  INSERT INTO public.audio_analysis_jobs(job_id,user_id,idempotency_key,request_hash,audio_wav,audio_bytes,audio_object_key,kick_gate_mode)
    VALUES(p_job_id,p_user_id,p_key,p_hash,''::bytea,i.audio_bytes,i.object_key,p_gate);
  INSERT INTO public.audio_analysis_job_dispatch(job_id) VALUES(p_job_id);
  DELETE FROM public.audio_analysis_storage_intents WHERE public.audio_analysis_storage_intents.job_id=p_job_id;
  RETURN QUERY SELECT 'queued'::text,p_job_id;
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_job_submit_storage(uuid,text,bytea,uuid,text) OWNER TO postgres;

CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_job_quota_start(p_job_id uuid,p_attempt integer,p_reservation_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE j public.audio_analysis_jobs; c public.audio_analysis_control; u public.audio_analysis_usage; e public.audio_analysis_entitlements; v_now timestamptz:=pg_catalog.clock_timestamp(); n bigint;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE audio_analysis_jobs.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.attempts<>p_attempt OR j.cancel_requested THEN RETURN 'invalid'; END IF;
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton;
  IF NOT c.enabled OR c.concurrent_limit<=0 THEN RETURN 'disabled'; END IF;
  SELECT * INTO u FROM public.audio_analysis_usage WHERE audio_analysis_usage.reservation_id=p_reservation_id AND audio_job_id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF u.state='reserved' THEN RETURN arvc_internal.audio_analysis_start(p_reservation_id); END IF;
  IF u.started_at IS NULL OR u.state NOT IN ('running','succeeded','failed','canceled','expired_charged') THEN RETURN 'invalid'; END IF;
  SELECT * INTO e FROM public.audio_analysis_entitlements WHERE user_id=u.user_id FOR SHARE;
  IF NOT FOUND OR NOT e.enabled OR (e.expires_at IS NOT NULL AND e.expires_at<=v_now)
    OR e.deployment_environment<>c.deployment_environment OR e.concurrent_limit<=0 THEN RETURN 'not_entitled'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.audio_analysis_usage
    WHERE reservation_id<>p_reservation_id AND state IN ('reserved','running') AND lease_until>v_now;
  IF n>=c.concurrent_limit THEN RETURN 'concurrency_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.audio_analysis_usage
    WHERE user_id=u.user_id AND reservation_id<>p_reservation_id AND state IN ('reserved','running') AND lease_until>v_now;
  IF n>=e.concurrent_limit THEN RETURN 'concurrency_exceeded'; END IF;
  UPDATE public.audio_analysis_usage SET state='running',finalized_at=NULL,lease_until=v_now+pg_catalog.make_interval(secs=>c.lease_seconds),safe_error_code=NULL
    WHERE public.audio_analysis_usage.reservation_id=p_reservation_id;
  RETURN 'started';
END
$function$;
ALTER FUNCTION arvc_internal.audio_analysis_job_quota_start(uuid,integer,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_quota_start(uuid,integer,uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_quota_start(uuid,integer,uuid) TO arvc_audio_analysis;

DO $$ DECLARE f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'arvc_internal.audio_analysis_storage_intent(uuid,text,bytea,uuid,integer,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_submit_storage(uuid,text,bytea,uuid,text)'::regprocedure
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres',f);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget',f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO arvc_audio_analysis',f);
  END LOOP;
END $$;
