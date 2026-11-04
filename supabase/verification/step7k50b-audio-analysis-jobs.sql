-- Run only against a disposable database after migrations 042, 050b, and 050d.
-- Every synthetic Auth/quota/job row is rolled back at the end.
BEGIN;
DO $$
DECLARE
  u1 constant uuid := '00000000-0000-4000-8000-000000000051';
  u2 constant uuid := '00000000-0000-4000-8000-000000000052';
  u3 constant uuid := '00000000-0000-4000-8000-000000000053';
  w1 bytea := decode(repeat('11',45),'hex');
  w2 bytea := decode(repeat('22',45),'hex');
  w3 bytea := decode(repeat('33',45),'hex');
  j1 uuid; j2 uuid; j3 uuid; c1 uuid; c2 uuid; c3 uuid;
  r1 uuid; r2 uuid; r3 uuid; rq uuid; a1 integer; a2 integer; a3 integer;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN (u1,u2,u3)) THEN
    RAISE EXCEPTION 'synthetic test identities already exist; refusing to overwrite';
  END IF;
  INSERT INTO auth.users(id) VALUES (u1),(u2),(u3);
  INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at)
    VALUES (u1,true,10,100,1,now()-interval '1 minute',now()+interval '1 day'),
           (u2,true,10,100,1,now()-interval '1 minute',now()+interval '1 day'),
           (u3,true,10,100,1,now()-interval '1 minute',now()+interval '1 day');
  UPDATE public.audio_analysis_control SET enabled=true,service_daily_limit=10,service_monthly_limit=100,
    concurrent_limit=2,request_window_seconds=600,request_window_limit=20,lease_seconds=900 WHERE singleton;

  SELECT job_id INTO j1 FROM arvc_internal.audio_analysis_job_submit(u1,'one',extensions.digest(w1||convert_to('|hard','UTF8'),'sha256'),w1,'hard') WHERE result='queued';
  PERFORM pg_catalog.pg_sleep(0.01);
  SELECT job_id INTO j2 FROM arvc_internal.audio_analysis_job_submit(u2,'two',extensions.digest(w2||convert_to('|soft','UTF8'),'sha256'),w2,'soft') WHERE result='queued';
  -- Same key and same content is idempotent; changed content is rejected.
  IF (SELECT job_id FROM arvc_internal.audio_analysis_job_submit(u1,'one',extensions.digest(w1||convert_to('|hard','UTF8'),'sha256'),w1,'hard')) <> j1 THEN
    RAISE EXCEPTION 'idempotent resubmission changed job identity';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_submit(u1,'one',extensions.digest(w3||convert_to('|hard','UTF8'),'sha256'),w3,'hard') WHERE result='idempotency_conflict') THEN
    RAISE EXCEPTION 'same key with changed content was not rejected';
  END IF;
  SELECT job_id INTO j3 FROM arvc_internal.audio_analysis_job_submit(u1,'three',extensions.digest(w3||convert_to('|middle','UTF8'),'sha256'),w3,'middle') WHERE result='queued';
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_submit(u1,'four',extensions.digest(w3||convert_to('|off','UTF8'),'sha256'),w3,'off') WHERE result='user_queue_full') THEN
    RAISE EXCEPTION 'per-user waiting cap was not enforced';
  END IF;

  SELECT job_id,attempt INTO c1,a1 FROM arvc_internal.audio_analysis_job_claim_v2();
  SELECT job_id,attempt INTO c2,a2 FROM arvc_internal.audio_analysis_job_claim_v2();
  SELECT job_id,attempt INTO c3,a3 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF c1 IS NULL OR c2 IS NULL OR c1=c2 OR c3 IS NOT NULL THEN RAISE EXCEPTION 'global worker claim cap is not two'; END IF;
  IF EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_get(j1,u2)) THEN RAISE EXCEPTION 'foreign owner can read a job'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(j3,u1) WHERE result='canceled') THEN RAISE EXCEPTION 'queued cancellation failed'; END IF;
  IF NOT arvc_internal.audio_analysis_job_requeue_attempt(c1,a1) THEN RAISE EXCEPTION 'explicit capacity retry failed'; END IF;
  SELECT job_id,attempt INTO c3,a3 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF c3 IS DISTINCT FROM c1 OR a3<>2 THEN RAISE EXCEPTION 'requeued job was not claimed with the next attempt'; END IF;
  UPDATE public.audio_analysis_jobs SET lease_until=now()-interval '1 second',attempts=2 WHERE job_id=c1;
  SELECT job_id,attempt INTO c3,a3 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF c3 IS DISTINCT FROM c1 OR a3<>3 THEN RAISE EXCEPTION 'expired worker lease was not recovered with a new attempt'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(c1,u1) WHERE result='cancel_requested') THEN RAISE EXCEPTION 'running cancellation request failed'; END IF;
  IF NOT arvc_internal.audio_analysis_job_cancel_requested(c1,u1) THEN RAISE EXCEPTION 'worker cancel polling did not observe cancellation'; END IF;
  IF NOT arvc_internal.audio_analysis_job_finish_attempt(c1,a3,'succeeded','{"late":true}'::jsonb,NULL) THEN RAISE EXCEPTION 'running cancellation finish failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_status(c1,u1) WHERE state='canceled' AND safe_error_code='canceled') THEN RAISE EXCEPTION 'cancel/finish race did not preserve cancellation'; END IF;
  SELECT reservation_id INTO rq FROM arvc_internal.audio_analysis_job_quota_reserve(c2,a2,u2) WHERE result='reserved';
  IF rq IS NULL OR arvc_internal.audio_analysis_job_quota_start(c2,a2,rq)<>'started'
    OR NOT arvc_internal.audio_analysis_job_quota_settle(c2,a2,rq,'succeeded',NULL) THEN
    RAISE EXCEPTION 'success job quota lifecycle failed';
  END IF;
  IF NOT arvc_internal.audio_analysis_job_finish_attempt(c2,a2,'succeeded','{"featureTimeline":{},"musicSummary":{},"analysisMetadata":{}}'::jsonb,NULL) THEN RAISE EXCEPTION 'success finish failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_status(j2,u2) WHERE state='succeeded') THEN RAISE EXCEPTION 'owner status read failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_get(j2,u2) WHERE result IS NOT NULL) THEN RAISE EXCEPTION 'owner result read failed'; END IF;
  IF EXISTS (SELECT 1 FROM public.audio_analysis_jobs WHERE job_id IN (c1,c2,j3) AND pg_catalog.octet_length(audio_wav)<>0) THEN RAISE EXCEPTION 'terminal audio cleanup failed'; END IF;

  -- The existing quota RPC remains the execution gate: two users reserve,
  -- while a second reservation for one user and a third global reservation fail.
  SELECT reservation_id INTO r1 FROM arvc_internal.audio_analysis_reserve(u1) WHERE result='reserved';
  SELECT reservation_id INTO r2 FROM arvc_internal.audio_analysis_reserve(u2) WHERE result='reserved';
  IF r1 IS NULL OR r2 IS NULL THEN RAISE EXCEPTION 'two-user quota admission failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_reserve(u1) WHERE result='concurrency_exceeded') THEN RAISE EXCEPTION 'same-user concurrency was not limited'; END IF;
  SELECT reservation_id INTO r3 FROM arvc_internal.audio_analysis_reserve(u3) WHERE result='concurrency_exceeded';
  IF r3 IS NOT NULL THEN RAISE EXCEPTION 'global concurrency exceeded two'; END IF;
  IF arvc_internal.audio_analysis_start(r1)<>'started' OR arvc_internal.audio_analysis_start(r2)<>'started' THEN RAISE EXCEPTION 'quota start failed'; END IF;
  UPDATE public.audio_analysis_usage SET lease_until=now()-interval '1 second' WHERE reservation_id=r1;
  SELECT reservation_id INTO r3 FROM arvc_internal.audio_analysis_reserve(u3) WHERE result='reserved';
  IF r3 IS NULL THEN RAISE EXCEPTION 'expired quota lease did not free active capacity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE reservation_id=r1 AND state='expired_charged') THEN RAISE EXCEPTION 'expired worker quota was not charged'; END IF;
  IF NOT arvc_internal.audio_analysis_release(r3) OR NOT arvc_internal.audio_analysis_settle(r2,'succeeded',NULL) THEN RAISE EXCEPTION 'quota settlement/release failed'; END IF;

  IF has_table_privilege('arvc_audio_analysis','public.audio_analysis_jobs','SELECT') OR has_table_privilege('authenticated','public.audio_analysis_jobs','SELECT') THEN
    RAISE EXCEPTION 'direct job table ACL is present';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid='public.audio_analysis_jobs'::regclass) THEN RAISE EXCEPTION 'job table is not FORCE RLS'; END IF;
  IF NOT (SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid='arvc_internal.audio_analysis_job_submit(uuid,text,bytea,bytea,text)'::regprocedure) THEN
    RAISE EXCEPTION 'submit RPC is not fixed-search-path SECURITY DEFINER';
  END IF;
END $$;
ROLLBACK;
