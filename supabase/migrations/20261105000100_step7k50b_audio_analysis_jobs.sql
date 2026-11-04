-- Step 7k-50b: durable bounded job queue for Audio Analyze.
-- Additive only. Do not apply to any shared/hosted database without approval.
-- Queue blobs are private DB data; clients can access them only through owner
-- checked RPCs. No Supabase Storage bucket or public URL is created.

CREATE TABLE public.audio_analysis_jobs (
  job_id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  request_hash bytea NOT NULL CHECK (pg_catalog.octet_length(request_hash) = 32),
  audio_wav bytea NOT NULL CHECK (pg_catalog.octet_length(audio_wav) = 0 OR pg_catalog.octet_length(audio_wav) BETWEEN 45 AND 16777216),
  kick_gate_mode text NOT NULL CHECK (kick_gate_mode IN ('off','soft','middle','hard')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed','canceled')),
  result jsonb CHECK (result IS NULL OR pg_catalog.octet_length(result::text) <= 10485760),
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz,
  cancel_requested boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  CHECK ((state = 'queued' AND started_at IS NULL AND finished_at IS NULL) OR state <> 'queued'),
  CHECK ((state = 'running' AND started_at IS NOT NULL AND lease_until IS NOT NULL AND finished_at IS NULL) OR state <> 'running'),
  CHECK ((state IN ('succeeded','failed','canceled') AND finished_at IS NOT NULL) OR state NOT IN ('succeeded','failed','canceled')),
  CHECK ((state='succeeded') = (result IS NOT NULL)),
  CHECK (state IN ('queued','running') OR pg_catalog.octet_length(audio_wav)=0),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX audio_analysis_jobs_queue ON public.audio_analysis_jobs(created_at, job_id) WHERE state='queued';
CREATE INDEX audio_analysis_jobs_user ON public.audio_analysis_jobs(user_id, created_at DESC);
CREATE INDEX audio_analysis_jobs_lease ON public.audio_analysis_jobs(lease_until) WHERE state='running';
ALTER TABLE public.audio_analysis_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_jobs FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;

-- Submission enforces an aggregate 20-job/320 MiB audio bound, at most two
-- waiting jobs per user, a 15-minute queue TTL, and content-bound idempotency.
CREATE FUNCTION arvc_internal.audio_analysis_job_submit(
  p_user_id uuid, p_key text, p_hash bytea, p_audio bytea, p_gate text
) RETURNS TABLE(result text, job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_now timestamptz := pg_catalog.clock_timestamp(); v_existing public.audio_analysis_jobs;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  IF p_user_id IS NULL OR p_key IS NULL OR p_hash IS NULL OR p_audio IS NULL OR p_gate IS NULL OR p_gate NOT IN ('off','soft','middle','hard')
    OR p_hash <> extensions.digest(p_audio || pg_catalog.convert_to('|' || p_gate,'UTF8'),'sha256') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid; RETURN;
  END IF;
  DELETE FROM public.audio_analysis_jobs WHERE created_at < v_now - interval '24 hours' AND state <> 'running';
  SELECT * INTO v_existing FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF v_existing.request_hash <> p_hash THEN RETURN QUERY SELECT 'idempotency_conflict'::text, NULL::uuid;
    ELSE RETURN QUERY SELECT 'existing'::text, v_existing.job_id; END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN
    RETURN QUERY SELECT 'disabled'::text, NULL::uuid; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled
    AND e.granted_at <= v_now AND (e.expires_at IS NULL OR e.expires_at > v_now)) THEN
    RETURN QUERY SELECT 'not_entitled'::text, NULL::uuid; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE state IN ('queued','running')) >= 20
    OR (SELECT COALESCE(pg_catalog.sum(pg_catalog.octet_length(audio_wav)),0) FROM public.audio_analysis_jobs WHERE state IN ('queued','running')) + pg_catalog.octet_length(p_audio) > 335544320 THEN
    RETURN QUERY SELECT 'queue_full'::text, NULL::uuid; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE user_id=p_user_id AND state='queued') >= 2 THEN
    RETURN QUERY SELECT 'user_queue_full'::text, NULL::uuid; RETURN;
  END IF;
  INSERT INTO public.audio_analysis_jobs(user_id,idempotency_key,request_hash,audio_wav,kick_gate_mode)
    VALUES(p_user_id,p_key,p_hash,p_audio,p_gate) RETURNING audio_analysis_jobs.job_id INTO v_id;
  RETURN QUERY SELECT 'queued'::text, v_id;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) OWNER TO postgres;

-- Claim is serialized with the control row: global workers <= 2, one active
-- job per user. Ordering is FIFO among eligible jobs; blocked same-user jobs
-- may be bypassed, so strict global FIFO is intentionally not promised.
CREATE FUNCTION arvc_internal.audio_analysis_job_claim()
RETURNS TABLE(job_id uuid,user_id uuid,audio_wav bytea,kick_gate_mode text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz := pg_catalog.clock_timestamp(); v_job public.audio_analysis_jobs;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
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
    WHERE audio_analysis_jobs.job_id=v_job.job_id;
  RETURN QUERY SELECT v_job.job_id,v_job.user_id,v_job.audio_wav,v_job.kick_gate_mode;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_claim() OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_cancel(p_job_id uuid,p_user_id uuid)
RETURNS TABLE(result text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE j public.audio_analysis_jobs;
BEGIN
  SELECT * INTO j FROM public.audio_analysis_jobs WHERE audio_analysis_jobs.job_id=p_job_id AND audio_analysis_jobs.user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'::text; RETURN; END IF;
  IF j.state='queued' THEN
    UPDATE public.audio_analysis_jobs SET state='canceled',finished_at=pg_catalog.clock_timestamp(),audio_wav=''::bytea WHERE audio_analysis_jobs.job_id=p_job_id;
    RETURN QUERY SELECT 'canceled'::text; RETURN;
  ELSIF j.state='running' THEN
    UPDATE public.audio_analysis_jobs SET cancel_requested=true WHERE audio_analysis_jobs.job_id=p_job_id;
    RETURN QUERY SELECT 'cancel_requested'::text; RETURN;
  END IF;
  RETURN QUERY SELECT 'terminal'::text;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_cancel(uuid,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_get(p_job_id uuid,p_user_id uuid)
RETURNS TABLE(job_id uuid,state text,queue_position bigint,result jsonb,safe_error_code text,cancel_requested boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT j.job_id,j.state,
    CASE WHEN j.state='queued' THEN (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs q WHERE q.state='queued' AND (q.created_at,q.job_id)<=(j.created_at,j.job_id)) ELSE 0 END,
    j.result,j.safe_error_code,j.cancel_requested
  FROM public.audio_analysis_jobs j WHERE j.job_id=p_job_id AND j.user_id=p_user_id
$$;
ALTER FUNCTION arvc_internal.audio_analysis_job_get(uuid,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_status(p_job_id uuid,p_user_id uuid)
RETURNS TABLE(job_id uuid,state text,queue_position bigint,safe_error_code text,cancel_requested boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT j.job_id,j.state,
    CASE WHEN j.state='queued' THEN (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs q WHERE q.state='queued' AND (q.created_at,q.job_id)<=(j.created_at,j.job_id)) ELSE 0 END,
    j.safe_error_code,j.cancel_requested
  FROM public.audio_analysis_jobs j WHERE j.job_id=p_job_id AND j.user_id=p_user_id
$$;
ALTER FUNCTION arvc_internal.audio_analysis_job_status(uuid,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_cancel_requested(p_job_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.audio_analysis_jobs j WHERE j.job_id=p_job_id AND j.user_id=p_user_id AND j.state='running' AND j.cancel_requested)
$$;
ALTER FUNCTION arvc_internal.audio_analysis_job_cancel_requested(uuid,uuid) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_finish(p_job_id uuid,p_state text,p_result jsonb,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer;
BEGIN
  IF p_state NOT IN ('succeeded','failed','canceled') THEN RETURN false; END IF;
  UPDATE public.audio_analysis_jobs SET state=CASE WHEN cancel_requested THEN 'canceled' ELSE p_state END,
    result=CASE WHEN p_state='succeeded' AND NOT cancel_requested THEN p_result ELSE NULL END,
    safe_error_code=CASE WHEN cancel_requested THEN 'canceled' ELSE p_error END,
    finished_at=pg_catalog.clock_timestamp(),lease_until=NULL,
    audio_wav=''::bytea
    WHERE audio_analysis_jobs.job_id=p_job_id AND audio_analysis_jobs.state='running';
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_finish(uuid,text,jsonb,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_requeue(p_job_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE changed integer; v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  UPDATE public.audio_analysis_jobs SET state='queued',started_at=NULL,lease_until=NULL
    WHERE audio_analysis_jobs.job_id=p_job_id AND audio_analysis_jobs.state='running'
      AND NOT audio_analysis_jobs.cancel_requested AND audio_analysis_jobs.attempts < 3
      AND audio_analysis_jobs.created_at > v_now - interval '15 minutes';
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN changed=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_requeue(uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_claim() FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_cancel(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_get(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_status(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_cancel_requested(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_finish(uuid,text,jsonb,text) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
REVOKE ALL ON FUNCTION arvc_internal.audio_analysis_job_requeue(uuid) FROM PUBLIC, anon, authenticated, service_role, arvc_asset_verifier, arvc_ai_budget;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text) TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_claim() TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_cancel(uuid,uuid) TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_get(uuid,uuid) TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_status(uuid,uuid) TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_cancel_requested(uuid,uuid) TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_finish(uuid,text,jsonb,text) TO arvc_audio_analysis;
GRANT EXECUTE ON FUNCTION arvc_internal.audio_analysis_job_requeue(uuid) TO arvc_audio_analysis;

COMMENT ON TABLE public.audio_analysis_jobs IS 'Step 7k-50b bounded private durable queue; audio bytes are purged at terminal state or 24h TTL.';
