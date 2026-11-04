-- Step 7k-50e: transactional dispatch outbox for Cloud Tasks. Jobs and quota
-- remain PostgreSQL-owned; dispatch generation fences stale/duplicate hints.
CREATE TABLE public.audio_analysis_job_dispatch (
  job_id uuid PRIMARY KEY REFERENCES public.audio_analysis_jobs(job_id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','sent','running','done')),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_until timestamptz,
  task_name text,
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,64}$'),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX audio_analysis_job_dispatch_pending ON public.audio_analysis_job_dispatch(next_attempt_at,job_id) WHERE state='pending';
CREATE INDEX audio_analysis_job_dispatch_slots ON public.audio_analysis_job_dispatch(state) WHERE state IN ('leased','sent','running');
ALTER TABLE public.audio_analysis_job_dispatch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_job_dispatch FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_job_dispatch FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget,arvc_audio_analysis;

CREATE OR REPLACE FUNCTION arvc_internal.audio_analysis_job_submit(
  p_user_id uuid,p_key text,p_hash bytea,p_audio bytea,p_gate text
) RETURNS TABLE(result text,job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_now timestamptz:=pg_catalog.clock_timestamp(); v_existing public.audio_analysis_jobs;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
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
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)) THEN
    RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))>=20
    OR (SELECT COALESCE(pg_catalog.sum(pg_catalog.octet_length(audio_wav)),0) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))+pg_catalog.octet_length(p_audio)>335544320 THEN
    RETURN QUERY SELECT 'queue_full'::text,NULL::uuid; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND state='queued')>=2 THEN RETURN QUERY SELECT 'user_queue_full'::text,NULL::uuid; RETURN; END IF;
  INSERT INTO public.audio_analysis_jobs(user_id,idempotency_key,request_hash,audio_wav,kick_gate_mode)
    VALUES(p_user_id,p_key,p_hash,p_audio,p_gate) RETURNING audio_analysis_jobs.job_id INTO v_id;
  INSERT INTO public.audio_analysis_job_dispatch(job_id) VALUES(v_id);
  RETURN QUERY SELECT 'queued'::text,v_id;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) TO arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_job_dispatch_claim(p_limit integer DEFAULT 2)
RETURNS TABLE(job_id uuid,generation integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp(); v_available integer; v_dispatch public.audio_analysis_job_dispatch;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  -- Recover work whose HTTP attempt disappeared before the DB lease expired.
  UPDATE public.audio_analysis_usage u SET state='canceled',finalized_at=v_now,lease_until=v_now,safe_error_code='canceled'
    FROM public.audio_analysis_jobs j WHERE u.audio_job_id=j.job_id AND j.state='running' AND j.lease_until<v_now AND j.cancel_requested AND u.state='running';
  UPDATE public.audio_analysis_jobs SET state='canceled',finished_at=v_now,lease_until=NULL,safe_error_code='canceled',audio_wav=''::bytea WHERE state='running' AND lease_until<v_now AND cancel_requested;
  UPDATE public.audio_analysis_usage u SET state='expired_charged',finalized_at=v_now,lease_until=v_now,safe_error_code='lease_expired'
    FROM public.audio_analysis_jobs j WHERE u.audio_job_id=j.job_id AND j.state='running' AND j.lease_until<v_now AND j.attempts>=3 AND u.state='running';
  UPDATE public.audio_analysis_jobs SET state='failed',finished_at=v_now,lease_until=NULL,safe_error_code='queue_wait_expired',audio_wav=''::bytea WHERE state='queued' AND created_at<=v_now-interval '15 minutes';
  UPDATE public.audio_analysis_jobs SET state='queued',started_at=NULL,lease_until=NULL WHERE state='running' AND lease_until<v_now AND attempts<3;
  UPDATE public.audio_analysis_jobs SET state='failed',finished_at=v_now,lease_until=NULL,safe_error_code='worker_lease_expired',audio_wav=''::bytea WHERE state='running' AND lease_until<v_now AND attempts>=3;
  UPDATE public.audio_analysis_job_dispatch d SET state='pending',generation=d.generation+1,next_attempt_at=v_now,lease_until=NULL,updated_at=v_now
    FROM public.audio_analysis_jobs j WHERE j.job_id=d.job_id AND d.state='running' AND j.state='queued';
  -- Redeliver queued jobs whose task was lost/exhausted. Old task deliveries are fenced by generation.
  UPDATE public.audio_analysis_job_dispatch d SET state='pending',generation=d.generation+1,next_attempt_at=v_now,lease_until=NULL,updated_at=v_now
    FROM public.audio_analysis_jobs j WHERE j.job_id=d.job_id AND d.state='sent' AND j.state='queued' AND d.updated_at<=v_now-interval '10 minutes';
  UPDATE public.audio_analysis_job_dispatch d SET state='done',lease_until=NULL,updated_at=v_now
    FROM public.audio_analysis_jobs j WHERE j.job_id=d.job_id AND j.state IN ('succeeded','failed','canceled') AND d.state<>'done';
  UPDATE public.audio_analysis_job_dispatch SET state='pending',lease_until=NULL,next_attempt_at=v_now,updated_at=v_now
    WHERE state='leased' AND lease_until<=v_now;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN RETURN; END IF;
  SELECT 2-(SELECT count(*) FROM public.audio_analysis_jobs WHERE state='running')-
    (SELECT count(*) FROM public.audio_analysis_job_dispatch d JOIN public.audio_analysis_jobs j USING(job_id) WHERE d.state IN ('leased','sent') AND j.state='queued')
    INTO v_available;
  IF v_available<=0 THEN RETURN; END IF;
  FOR v_dispatch IN SELECT x.* FROM public.audio_analysis_job_dispatch x JOIN public.audio_analysis_jobs j USING(job_id)
    WHERE x.state='pending' AND x.next_attempt_at<=v_now AND j.state='queued' AND NOT j.cancel_requested
      AND j.created_at>v_now-interval '15 minutes'
      AND NOT EXISTS(SELECT 1 FROM public.audio_analysis_jobs a WHERE a.user_id=j.user_id AND a.state='running')
      AND NOT EXISTS(SELECT 1 FROM public.audio_analysis_job_dispatch dx JOIN public.audio_analysis_jobs jx USING(job_id)
        WHERE jx.user_id=j.user_id AND dx.job_id<>j.job_id AND dx.state IN ('leased','sent') AND jx.state='queued')
    ORDER BY j.created_at,j.job_id FOR UPDATE OF x SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,0),v_available)
  LOOP
    UPDATE public.audio_analysis_job_dispatch SET state='leased',lease_until=v_now+interval '60 seconds',dispatch_attempts=dispatch_attempts+1,updated_at=v_now
      WHERE public.audio_analysis_job_dispatch.job_id=v_dispatch.job_id;
    RETURN QUERY SELECT v_dispatch.job_id,v_dispatch.generation;
  END LOOP;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_dispatch_claim(integer) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_dispatch_sent(p_job_id uuid,p_generation integer,p_task_name text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  UPDATE public.audio_analysis_job_dispatch SET state=CASE WHEN state='leased' THEN 'sent' ELSE state END,
    lease_until=NULL,task_name=p_task_name,updated_at=pg_catalog.clock_timestamp()
  WHERE job_id=p_job_id AND generation=p_generation AND state IN ('leased','running','done');
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_dispatch_sent(uuid,integer,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_dispatch_failed(p_job_id uuid,p_generation integer,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  UPDATE public.audio_analysis_job_dispatch SET state='pending',lease_until=NULL,
    next_attempt_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>LEAST(300,5*pg_catalog.power(2,LEAST(dispatch_attempts,6))::integer)),
    safe_error_code=CASE WHEN p_error ~ '^[a-z0-9_]{1,64}$' THEN p_error ELSE 'dispatch_failed' END,updated_at=pg_catalog.clock_timestamp()
  WHERE job_id=p_job_id AND generation=p_generation AND state='leased';
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_dispatch_failed(uuid,integer,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_claim_task(p_job_id uuid,p_generation integer)
RETURNS TABLE(task_result text,job_id uuid,user_id uuid,audio_wav bytea,kick_gate_mode text,attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp(); j public.audio_analysis_jobs; d public.audio_analysis_job_dispatch; c public.audio_analysis_control; n bigint;
BEGIN
  -- Keep the control-row -> dispatch-row lock order used by dispatcher claim.
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  SELECT * INTO d FROM public.audio_analysis_job_dispatch WHERE audio_analysis_job_dispatch.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR d.generation<>p_generation OR d.state='done' THEN RETURN QUERY SELECT 'stale'::text,NULL::uuid,NULL::uuid,NULL::bytea,NULL::text,NULL::integer; RETURN; END IF;
  UPDATE public.audio_analysis_usage u SET state='canceled',finalized_at=v_now,lease_until=v_now,safe_error_code='canceled'
    FROM public.audio_analysis_jobs x WHERE u.audio_job_id=x.job_id AND x.state='running' AND x.lease_until<v_now AND x.cancel_requested AND u.state='running';
  UPDATE public.audio_analysis_jobs SET state='canceled',finished_at=v_now,lease_until=NULL,safe_error_code='canceled',audio_wav=''::bytea WHERE state='running' AND lease_until<v_now AND cancel_requested;
  UPDATE public.audio_analysis_usage u SET state='expired_charged',finalized_at=v_now,lease_until=v_now,safe_error_code='lease_expired'
    FROM public.audio_analysis_jobs x WHERE u.audio_job_id=x.job_id AND x.state='running' AND x.lease_until<v_now AND x.attempts>=3 AND u.state='running';
  UPDATE public.audio_analysis_jobs SET state='failed',finished_at=v_now,lease_until=NULL,safe_error_code='worker_lease_expired',audio_wav=''::bytea WHERE state='running' AND lease_until<v_now AND attempts>=3;
  UPDATE public.audio_analysis_jobs SET state='queued',started_at=NULL,lease_until=NULL WHERE state='running' AND lease_until<v_now AND attempts<3;
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE audio_analysis_jobs.job_id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.state IN ('succeeded','failed','canceled') THEN
    UPDATE public.audio_analysis_job_dispatch SET state='done',lease_until=NULL,updated_at=v_now WHERE audio_analysis_job_dispatch.job_id=p_job_id AND generation=p_generation;
    RETURN QUERY SELECT 'terminal'::text,p_job_id,NULL::uuid,NULL::bytea,NULL::text,NULL::integer; RETURN;
  END IF;
  IF j.state='running' THEN RETURN QUERY SELECT 'busy'::text,j.job_id,j.user_id,NULL::bytea,j.kick_gate_mode,j.attempts; RETURN; END IF;
  SELECT * INTO c FROM public.audio_analysis_control WHERE singleton;
  IF NOT c.enabled OR j.cancel_requested OR j.created_at<=v_now-interval '15 minutes' THEN
    UPDATE public.audio_analysis_job_dispatch SET state='pending',generation=generation+1,next_attempt_at=v_now+interval '30 seconds',lease_until=NULL,updated_at=v_now WHERE audio_analysis_job_dispatch.job_id=p_job_id AND generation=p_generation;
    RETURN QUERY SELECT 'deferred'::text,j.job_id,j.user_id,NULL::bytea,j.kick_gate_mode,j.attempts; RETURN;
  END IF;
  SELECT pg_catalog.count(*) INTO n FROM public.audio_analysis_jobs WHERE state='running';
  IF n>=2 OR EXISTS(SELECT 1 FROM public.audio_analysis_jobs active WHERE active.user_id=j.user_id AND active.state='running') THEN
    UPDATE public.audio_analysis_job_dispatch SET state='pending',generation=generation+1,next_attempt_at=v_now+interval '30 seconds',lease_until=NULL,updated_at=v_now WHERE audio_analysis_job_dispatch.job_id=p_job_id AND generation=p_generation;
    RETURN QUERY SELECT 'deferred'::text,j.job_id,j.user_id,NULL::bytea,j.kick_gate_mode,j.attempts; RETURN;
  END IF;
  UPDATE public.audio_analysis_jobs SET state='running',started_at=v_now,lease_until=v_now+interval '15 minutes',attempts=attempts+1
    WHERE audio_analysis_jobs.job_id=p_job_id RETURNING public.audio_analysis_jobs.attempts INTO j.attempts;
  UPDATE public.audio_analysis_job_dispatch SET state='running',lease_until=NULL,updated_at=v_now WHERE audio_analysis_job_dispatch.job_id=p_job_id AND generation=p_generation;
  RETURN QUERY SELECT 'claimed'::text,j.job_id,j.user_id,j.audio_wav,j.kick_gate_mode,j.attempts;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_claim_task(uuid,integer) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_dispatch_done(p_job_id uuid,p_generation integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  UPDATE public.audio_analysis_job_dispatch SET state='done',lease_until=NULL,updated_at=pg_catalog.clock_timestamp()
    WHERE job_id=p_job_id AND generation=p_generation;
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_dispatch_done(uuid,integer) OWNER TO postgres;

DO $$ DECLARE f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'arvc_internal.audio_analysis_job_dispatch_claim(integer)'::regprocedure,
    'arvc_internal.audio_analysis_job_dispatch_sent(uuid,integer,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_dispatch_failed(uuid,integer,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_claim_task(uuid,integer)'::regprocedure,
    'arvc_internal.audio_analysis_job_dispatch_done(uuid,integer)'::regprocedure
  ] LOOP
    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres',f);
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget',f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO arvc_audio_analysis',f);
  END LOOP;
END $$;
