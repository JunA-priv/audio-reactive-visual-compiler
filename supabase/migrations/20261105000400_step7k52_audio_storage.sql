-- Step 7k-52: move new queue audio to a private Storage bucket while keeping
-- legacy bytea rows readable until they naturally reach terminal state.
ALTER TABLE public.audio_analysis_jobs
  ADD COLUMN audio_object_key text,
  ADD COLUMN audio_bytes integer NOT NULL DEFAULT 0;
UPDATE public.audio_analysis_jobs SET audio_bytes=pg_catalog.octet_length(audio_wav);
ALTER TABLE public.audio_analysis_jobs
  ADD CONSTRAINT audio_analysis_jobs_object_key_shape CHECK (
    audio_object_key IS NULL OR audio_object_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$'
  ),
  ADD CONSTRAINT audio_analysis_jobs_audio_bytes_bound CHECK (audio_bytes BETWEEN 0 AND 16777216),
  ADD CONSTRAINT audio_analysis_jobs_active_audio_reference CHECK (
    state NOT IN ('queued','running') OR pg_catalog.octet_length(audio_wav)>0 OR audio_object_key IS NOT NULL
  );
CREATE INDEX audio_analysis_jobs_object_key ON public.audio_analysis_jobs(audio_object_key) WHERE audio_object_key IS NOT NULL;
CREATE FUNCTION arvc_internal.audio_analysis_legacy_audio_bytes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.audio_object_key IS NULL THEN NEW.audio_bytes:=pg_catalog.octet_length(NEW.audio_wav); END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_legacy_audio_bytes() OWNER TO postgres;
CREATE TRIGGER audio_analysis_legacy_audio_bytes_insert BEFORE INSERT ON public.audio_analysis_jobs
FOR EACH ROW EXECUTE FUNCTION arvc_internal.audio_analysis_legacy_audio_bytes();
CREATE TRIGGER audio_analysis_legacy_audio_bytes_update BEFORE UPDATE OF audio_wav,audio_object_key ON public.audio_analysis_jobs
FOR EACH ROW EXECUTE FUNCTION arvc_internal.audio_analysis_legacy_audio_bytes();

CREATE TABLE public.audio_analysis_storage_intents (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (pg_catalog.octet_length(request_hash)=32),
  job_id uuid NOT NULL UNIQUE,
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$'),
  audio_bytes integer NOT NULL CHECK (audio_bytes BETWEEN 45 AND 16777216),
  kick_gate_mode text NOT NULL CHECK (kick_gate_mode IN ('off','soft','middle','hard')),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY(user_id,idempotency_key)
);
ALTER TABLE public.audio_analysis_storage_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_storage_intents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_storage_intents FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget,arvc_audio_analysis;

CREATE TABLE public.audio_analysis_storage_cleanup (
  object_key text PRIMARY KEY CHECK (object_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$'),
  user_id uuid NOT NULL,
  audio_bytes integer NOT NULL DEFAULT 0 CHECK (audio_bytes BETWEEN 0 AND 16777216),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_until timestamptz,
  safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE INDEX audio_analysis_storage_cleanup_due ON public.audio_analysis_storage_cleanup(next_attempt_at) WHERE lease_until IS NULL;
ALTER TABLE public.audio_analysis_storage_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audio_analysis_storage_cleanup FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.audio_analysis_storage_cleanup FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget,arvc_audio_analysis;

CREATE FUNCTION arvc_internal.audio_analysis_storage_intent(
  p_user_id uuid,p_key text,p_hash bytea,p_job_id uuid,p_audio_bytes integer,p_gate text
) RETURNS TABLE(result text,job_id uuid,object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp(); j public.audio_analysis_jobs; i public.audio_analysis_storage_intents;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  IF p_user_id IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 128 OR p_hash IS NULL OR pg_catalog.octet_length(p_hash)<>32
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
  SELECT * INTO i FROM public.audio_analysis_storage_intents WHERE user_id=p_user_id AND idempotency_key=p_key;
  IF FOUND THEN
    IF i.created_at<=v_now-interval '24 hours' THEN RETURN QUERY SELECT 'expired'::text,NULL::uuid,NULL::text; RETURN; END IF;
    IF i.request_hash<>p_hash OR i.audio_bytes<>p_audio_bytes OR i.kick_gate_mode<>p_gate THEN
      RETURN QUERY SELECT 'idempotency_conflict'::text,NULL::uuid,NULL::text;
    ELSIF NOT EXISTS(SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN
      RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text;
    ELSIF NOT EXISTS(SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)) THEN
      RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid,NULL::text;
    ELSE RETURN QUERY SELECT 'upload'::text,i.job_id,i.object_key; END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid,NULL::text; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)) THEN
    RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  IF (SELECT pg_catalog.count(*) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))
       +(SELECT pg_catalog.count(*) FROM public.audio_analysis_storage_intents WHERE created_at>v_now-interval '24 hours')>=20
    OR (SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_jobs WHERE state IN ('queued','running'))
       +(SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_storage_intents)
       +(SELECT COALESCE(pg_catalog.sum(audio_bytes),0) FROM public.audio_analysis_storage_cleanup)+p_audio_bytes>335544320 THEN
    RETURN QUERY SELECT 'queue_full'::text,NULL::uuid,NULL::text; RETURN;
  END IF;
  -- One running + two queued jobs per user, each at the existing 16 MiB
  -- request limit, gives a hard 48 MiB upper bound per user.
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
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_intent(uuid,text,bytea,uuid,integer,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_submit_storage(
  p_user_id uuid,p_key text,p_hash bytea,p_job_id uuid,p_gate text
) RETURNS TABLE(result text,job_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp(); i public.audio_analysis_storage_intents; v_existing public.audio_analysis_jobs;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  IF p_user_id IS NULL OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 128 OR p_hash IS NULL OR pg_catalog.octet_length(p_hash)<>32
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
  SELECT * INTO i FROM public.audio_analysis_storage_intents WHERE user_id=p_user_id AND idempotency_key=p_key FOR UPDATE;
  IF NOT FOUND OR i.created_at<=v_now-interval '24 hours' OR i.job_id<>p_job_id OR i.request_hash<>p_hash OR i.kick_gate_mode<>p_gate THEN RETURN QUERY SELECT 'invalid'::text,NULL::uuid; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_control WHERE singleton AND enabled) THEN RETURN QUERY SELECT 'disabled'::text,NULL::uuid; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_entitlements e WHERE e.user_id=p_user_id AND e.enabled AND e.granted_at<=v_now AND (e.expires_at IS NULL OR e.expires_at>v_now)) THEN
    RETURN QUERY SELECT 'not_entitled'::text,NULL::uuid; RETURN;
  END IF;
  INSERT INTO public.audio_analysis_jobs(job_id,user_id,idempotency_key,request_hash,audio_wav,audio_bytes,audio_object_key,kick_gate_mode)
    VALUES(p_job_id,p_user_id,p_key,p_hash,''::bytea,i.audio_bytes,i.object_key,p_gate);
  INSERT INTO public.audio_analysis_job_dispatch(job_id) VALUES(p_job_id);
  DELETE FROM public.audio_analysis_storage_intents WHERE public.audio_analysis_storage_intents.job_id=p_job_id;
  RETURN QUERY SELECT 'queued'::text,p_job_id;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_job_submit_storage(uuid,text,bytea,uuid,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_job_storage_ref(p_job_id uuid,p_attempt integer)
RETURNS TABLE(object_key text,request_hash bytea)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT j.audio_object_key,j.request_hash FROM public.audio_analysis_jobs j
  WHERE j.job_id=p_job_id AND j.state='running' AND j.attempts=p_attempt
    AND j.lease_until>pg_catalog.clock_timestamp() AND NOT j.cancel_requested
$$;
ALTER FUNCTION arvc_internal.audio_analysis_job_storage_ref(uuid,integer) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_storage_cleanup_claim(p_limit integer DEFAULT 20)
RETURNS TABLE(object_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_key text;
BEGIN
  PERFORM 1 FROM public.audio_analysis_control WHERE singleton FOR UPDATE;
  FOR v_key IN SELECT c.object_key FROM public.audio_analysis_storage_cleanup c
    WHERE c.next_attempt_at<=pg_catalog.clock_timestamp() AND (c.lease_until IS NULL OR c.lease_until<=pg_catalog.clock_timestamp())
    ORDER BY c.next_attempt_at FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(p_limit,0),100)
  LOOP
    UPDATE public.audio_analysis_storage_cleanup SET lease_until=pg_catalog.clock_timestamp()+interval '2 minutes',attempts=attempts+1
    WHERE public.audio_analysis_storage_cleanup.object_key=v_key;
    object_key:=v_key;
    RETURN NEXT;
  END LOOP;
  -- Upload intents are retained for 24h so a client can safely retry after an
  -- ambiguous DB response. Once expired, enqueue their objects for idempotent delete.
  INSERT INTO public.audio_analysis_storage_cleanup(object_key,user_id,audio_bytes)
    SELECT i.object_key,i.user_id,i.audio_bytes FROM public.audio_analysis_storage_intents i WHERE i.created_at<=pg_catalog.clock_timestamp()-interval '24 hours'
    ON CONFLICT ON CONSTRAINT audio_analysis_storage_cleanup_pkey DO NOTHING;
  DELETE FROM public.audio_analysis_storage_intents WHERE created_at<=pg_catalog.clock_timestamp()-interval '24 hours';
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_cleanup_claim(integer) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_storage_cleanup_done(p_key text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM public.audio_analysis_storage_cleanup WHERE public.audio_analysis_storage_cleanup.object_key=p_key;
  RETURN true;
END
$$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_cleanup_done(text) OWNER TO postgres;
CREATE FUNCTION arvc_internal.audio_analysis_storage_cleanup_failed(p_key text,p_error text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  UPDATE public.audio_analysis_storage_cleanup SET lease_until=NULL,
    next_attempt_at=pg_catalog.clock_timestamp()+pg_catalog.make_interval(secs=>LEAST(3600,30*pg_catalog.power(2,LEAST(attempts,7))::integer)),
    safe_error_code=CASE WHEN p_error ~ '^[a-z0-9_]{1,64}$' THEN p_error ELSE 'storage_delete_failed' END
    WHERE object_key=p_key;
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n=1;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_cleanup_failed(text,text) OWNER TO postgres;

CREATE FUNCTION arvc_internal.audio_analysis_storage_terminal_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.state IN ('queued','running') AND NEW.state IN ('succeeded','failed','canceled') AND OLD.audio_object_key IS NOT NULL THEN
    INSERT INTO public.audio_analysis_storage_cleanup(object_key,user_id,audio_bytes) VALUES(OLD.audio_object_key,OLD.user_id,OLD.audio_bytes) ON CONFLICT(object_key) DO NOTHING;
    NEW.audio_object_key:=NULL; NEW.audio_bytes:=0;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_terminal_cleanup() OWNER TO postgres;
CREATE TRIGGER audio_analysis_storage_terminal_cleanup BEFORE UPDATE OF state ON public.audio_analysis_jobs
FOR EACH ROW EXECUTE FUNCTION arvc_internal.audio_analysis_storage_terminal_cleanup();
CREATE FUNCTION arvc_internal.audio_analysis_storage_deleted_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF OLD.audio_object_key IS NOT NULL THEN
    INSERT INTO public.audio_analysis_storage_cleanup(object_key,user_id,audio_bytes) VALUES(OLD.audio_object_key,OLD.user_id,OLD.audio_bytes) ON CONFLICT(object_key) DO NOTHING;
  END IF;
  RETURN OLD;
END $$;
ALTER FUNCTION arvc_internal.audio_analysis_storage_deleted_cleanup() OWNER TO postgres;
CREATE TRIGGER audio_analysis_storage_deleted_cleanup AFTER DELETE ON public.audio_analysis_jobs
FOR EACH ROW EXECUTE FUNCTION arvc_internal.audio_analysis_storage_deleted_cleanup();

DO $$ DECLARE f regprocedure; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'arvc_internal.audio_analysis_storage_intent(uuid,text,bytea,uuid,integer,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_submit_storage(uuid,text,bytea,uuid,text)'::regprocedure,
    'arvc_internal.audio_analysis_job_storage_ref(uuid,integer)'::regprocedure,
    'arvc_internal.audio_analysis_storage_cleanup_claim(integer)'::regprocedure,
    'arvc_internal.audio_analysis_storage_cleanup_done(text)'::regprocedure,
    'arvc_internal.audio_analysis_storage_cleanup_failed(text,text)'::regprocedure
  ] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,arvc_asset_verifier,arvc_ai_budget',f);
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO arvc_audio_analysis',f);
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM storage.buckets WHERE id='arvc-audio-analysis') THEN
    RAISE EXCEPTION 'arvc-audio-analysis bucket already exists; inspect it before applying this migration';
  END IF;
  INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
    VALUES('arvc-audio-analysis','arvc-audio-analysis',false,16777216,ARRAY['audio/wav']::text[]);
END $$;
CREATE POLICY arvc_audio_analysis_owner_read ON storage.objects FOR SELECT TO authenticated
  USING(bucket_id='arvc-audio-analysis' AND (storage.foldername(name))[1]=auth.uid()::text);

COMMENT ON COLUMN public.audio_analysis_jobs.audio_wav IS 'Legacy bytea retained for queued jobs created before Step 7k-52; new submissions use private Storage.';
COMMENT ON COLUMN public.audio_analysis_jobs.audio_object_key IS 'Private arvc-audio-analysis object key; cleared at terminal transition after cleanup is queued.';
