-- Step 7k-50d: bind one quota usage row to each durable audio job and fence
-- every worker mutation by the claim attempt. Existing synchronous RPCs remain unchanged.
ALTER TABLE public.audio_analysis_usage
  ADD COLUMN audio_job_id uuid REFERENCES public.audio_analysis_jobs(job_id) ON DELETE SET NULL;
CREATE UNIQUE INDEX audio_analysis_usage_audio_job ON public.audio_analysis_usage(audio_job_id) WHERE audio_job_id IS NOT NULL;
REVOKE ALL ON public.audio_analysis_usage FROM arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_job_claim_v2()
RETURNS TABLE(job_id uuid,user_id uuid,audio_wav bytea,kick_gate_mode text,attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz := pg_catalog.clock_timestamp(); v_job public.audio_analysis_jobs;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  UPDATE public.audio_analysis_usage u SET state='canceled',finalized_at=v_now,lease_until=v_now,safe_error_code='canceled'
    FROM public.audio_analysis_jobs j
    WHERE u.audio_job_id=j.job_id AND j.state='running' AND j.lease_until<v_now AND j.cancel_requested AND u.state='running';
  UPDATE public.audio_analysis_jobs SET state='canceled',finished_at=v_now,lease_until=NULL,safe_error_code='canceled',audio_wav=''::bytea
    WHERE state='running' AND lease_until<v_now AND cancel_requested;
  UPDATE public.audio_analysis_usage u SET state='expired_charged',finalized_at=v_now,lease_until=v_now,safe_error_code='lease_expired'
    FROM public.audio_analysis_jobs j
    WHERE u.audio_job_id=j.job_id AND j.state='running' AND j.lease_until<v_now AND j.attempts>=3 AND u.state='running';
  UPDATE public.audio_analysis_jobs SET state='failed',finished_at=v_now,safe_error_code='queue_wait_expired',audio_wav=''::bytea
    WHERE state='queued' AND created_at <= v_now - interval '15 minutes';
  UPDATE public.audio_analysis_jobs SET state='queued',started_at=NULL,lease_until=NULL
    WHERE state='running' AND lease_until < v_now AND attempts < 3;
  UPDATE public.audio_analysis_jobs SET state='failed',finished_at=v_now,lease_until=NULL,safe_error_code='worker_lease_expired',audio_wav=''::bytea
    WHERE state='running' AND lease_until < v_now AND attempts >= 3;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN RETURN; END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE state='running') >= 2 THEN RETURN; END IF;
  SELECT j.* INTO v_job FROM public.audio_analysis_jobs j
    WHERE j.state='queued' AND NOT j.cancel_requested
      AND j.created_at > v_now - interval '15 minutes'
      AND NOT EXISTS (SELECT 1 FROM public.audio_analysis_jobs a WHERE a.user_id=j.user_id AND a.state='running')
    ORDER BY j.created_at,j.job_id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.audio_analysis_jobs SET state='running',started_at=v_now,lease_until=v_now+interval '15 minutes',attempts=attempts+1
    WHERE public.audio_analysis_jobs.job_id=v_job.job_id RETURNING public.audio_analysis_jobs.attempts INTO v_job.attempts;
  RETURN QUERY SELECT v_job.job_id,v_job.user_id,v_job.audio_wav,v_job.kick_gate_mode,v_job.attempts;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_claim_v2() OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_claim_v2() FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_claim_v2() TO arvc_audio_analysis;
REVOKE EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_claim() FROM arvc_audio_analysis;

-- A started job owns exactly one usage row across all retries. A started failure
-- is charged once; retries reuse that row and preserve its original started_at.
CREATE FUNCTION arvc_internal.audio_analysis_job_quota_reserve(p_job_id uuid,p_attempt integer,p_user_id uuid)
RETURNS TABLE(result text,reservation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.audio_analysis_jobs; c public.audio_analysis_control; u public.audio_analysis_usage; v_result text; v_id uuid;
BEGIN
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE audio_analysis_jobs.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.attempts<>p_attempt OR j.user_id<>p_user_id OR j.cancel_requested THEN
    RETURN QUERY SELECT 'invalid'::text,NULL::uuid; RETURN;
  END IF;
  IF NOT c.enabled THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid; RETURN; END IF;
  SELECT * INTO u FROM public.audio_analysis_usage WHERE audio_job_id=p_job_id FOR UPDATE;
  IF FOUND THEN
    IF u.user_id<>p_user_id THEN RETURN QUERY SELECT 'invalid'::text,NULL::uuid; RETURN; END IF;
    IF u.state='released' AND u.started_at IS NULL THEN
      UPDATE public.audio_analysis_usage SET state='reserved',created_at=pg_catalog.clock_timestamp(),finalized_at=NULL,
        lease_until=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>c.lease_seconds),safe_error_code=NULL
        WHERE public.audio_analysis_usage.reservation_id=u.reservation_id;
    END IF;
    RETURN QUERY SELECT 'reserved'::text,u.reservation_id; RETURN;
  END IF;
  SELECT q.result,q.reservation_id INTO v_result,v_id FROM arvc_internal.audio_analysis_reserve(p_user_id) AS q;
  IF v_result<>'reserved' OR v_id IS NULL THEN RETURN QUERY SELECT v_result,v_id; RETURN; END IF;
  UPDATE public.audio_analysis_usage SET audio_job_id=p_job_id WHERE public.audio_analysis_usage.reservation_id=v_id;
  RETURN QUERY SELECT 'reserved'::text,v_id;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_quota_reserve(uuid,integer,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_quota_start(p_job_id uuid,p_attempt integer,p_reservation_id uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
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
  IF NOT FOUND OR NOT e.enabled OR e.expires_at IS NOT NULL AND e.expires_at<=v_now OR e.concurrent_limit<=0 THEN RETURN 'not_entitled'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.audio_analysis_usage
    WHERE reservation_id<>p_reservation_id AND state IN ('reserved','running') AND lease_until>v_now;
  IF n>=c.concurrent_limit THEN RETURN 'concurrency_exceeded'; END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.audio_analysis_usage
    WHERE user_id=u.user_id AND reservation_id<>p_reservation_id AND state IN ('reserved','running') AND lease_until>v_now;
  IF n>=e.concurrent_limit THEN RETURN 'concurrency_exceeded'; END IF;
  UPDATE public.audio_analysis_usage SET state='running',finalized_at=NULL,lease_until=v_now+pg_catalog.make_interval(secs=>c.lease_seconds),safe_error_code=NULL
    WHERE public.audio_analysis_usage.reservation_id=p_reservation_id;
  RETURN 'started';
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_quota_start(uuid,integer,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_quota_release(p_job_id uuid,p_attempt integer,p_reservation_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.audio_analysis_jobs;
BEGIN
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE audio_analysis_jobs.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.attempts<>p_attempt THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE reservation_id=p_reservation_id AND audio_job_id=p_job_id) THEN RETURN false; END IF;
  RETURN arvc_internal.audio_analysis_release(p_reservation_id);
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_quota_release(uuid,integer,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_quota_settle(p_job_id uuid,p_attempt integer,p_reservation_id uuid,p_state text,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.audio_analysis_jobs;
BEGIN
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE audio_analysis_jobs.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.attempts<>p_attempt THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE reservation_id=p_reservation_id AND audio_job_id=p_job_id) THEN RETURN false; END IF;
  RETURN arvc_internal.audio_analysis_settle(p_reservation_id,p_state,p_error);
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_quota_settle(uuid,integer,uuid,text,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_finish_attempt(p_job_id uuid,p_attempt integer,p_state text,p_result jsonb,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.audio_analysis_jobs; u public.audio_analysis_usage; final_state text:=p_state;
BEGIN
  IF p_state NOT IN ('succeeded','failed','canceled') THEN RETURN false; END IF;
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE public.audio_analysis_jobs.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.state<>'running' OR j.attempts<>p_attempt THEN RETURN false; END IF;
  SELECT * INTO u FROM public.audio_analysis_usage WHERE audio_job_id=p_job_id FOR UPDATE;
  IF j.cancel_requested THEN final_state:='canceled';
  ELSIF p_state='succeeded' AND (NOT FOUND OR u.state<>'succeeded') THEN RETURN false;
  ELSIF p_state='failed' AND FOUND AND u.state NOT IN ('failed','released') THEN RETURN false;
  ELSIF p_state='canceled' AND FOUND AND u.state NOT IN ('canceled','released') THEN RETURN false;
  END IF;
  UPDATE public.audio_analysis_jobs SET state=final_state,
    result=CASE WHEN final_state='succeeded' THEN p_result ELSE NULL END,
    safe_error_code=CASE WHEN final_state='canceled' THEN 'canceled' ELSE p_error END,
    finished_at=pg_catalog.clock_timestamp(),lease_until=NULL,audio_wav=''::bytea
    WHERE public.audio_analysis_jobs.job_id=p_job_id AND state='running' AND attempts=p_attempt;
  RETURN FOUND;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_finish_attempt(uuid,integer,text,jsonb,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_requeue_attempt(p_job_id uuid,p_attempt integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  UPDATE public.audio_analysis_jobs SET state='queued',started_at=NULL,lease_until=NULL
    WHERE audio_analysis_jobs.job_id=p_job_id AND state='running' AND attempts=p_attempt
      AND NOT cancel_requested AND attempts<3 AND created_at>v_now-interval '15 minutes';
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_requeue_attempt(uuid,integer) OWNER TO postgres;

DO $$
DECLARE f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'arvc_internal.audio_analysis_job_quota_reserve(uuid,integer,uuid)'::regprocedure,
    'arvc_internal.audio_analysis_job_quota_start(uuid,integer,uuid)'::regprocedure,
    'arvc_internal.audio_analysis_job_quota_release(uuid,integer,uuid)'::regprocedure,
    'arvc_internal.audio_analysis_job_quota_settle(uuid,integer,uuid,text,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_finish_attempt(uuid,integer,text,jsonb,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_requeue_attempt(uuid,integer)'::regprocedure
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres',f);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget',f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO arvc_audio_analysis',f);
  END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_finish(uuid,text,jsonb,text) FROM arvc_audio_analysis;
REVOKE EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_requeue(uuid) FROM arvc_audio_analysis;
