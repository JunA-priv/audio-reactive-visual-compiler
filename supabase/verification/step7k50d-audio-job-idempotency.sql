-- Run only in a disposable DB after migrations 042, 050b, and 050d.
-- All synthetic rows and quota state changes are rolled back.
BEGIN;
DO $$
DECLARE
  u constant uuid := '00000000-0000-4000-8000-000000000071';
  audio bytea := decode(repeat('ab',45),'hex');
  job uuid; claimed uuid; attempt1 integer; attempt2 integer;
  reservation1 uuid; reservation2 uuid; n bigint;
  job2 uuid; job3 uuid; job4 uuid; attempt3 integer; attemptCancel integer; attempt4 integer; attempt5 integer; reservation3 uuid; reservation4 uuid; reservation5 uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id=u) THEN RAISE EXCEPTION 'synthetic user exists; refusing overwrite'; END IF;
  INSERT INTO auth.users(id) VALUES(u);
  INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at)
    VALUES(u,true,5,20,1,now()-interval '1 minute',now()+interval '1 day');
  UPDATE public.audio_analysis_control SET enabled=true,service_daily_limit=10,service_monthly_limit=40,
    concurrent_limit=2,request_window_seconds=600,request_window_limit=20,lease_seconds=900 WHERE singleton;
  SELECT job_id INTO job FROM arvc_internal.audio_analysis_job_submit(u,'retry',extensions.digest(audio||convert_to('|hard','UTF8'),'sha256'),audio,'hard') WHERE result='queued';
  SELECT job_id,attempt INTO claimed,attempt1 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS DISTINCT FROM job OR attempt1<>1 THEN RAISE EXCEPTION 'initial claim attempt invalid'; END IF;

  SELECT reservation_id INTO reservation1 FROM arvc_internal.audio_analysis_job_quota_reserve(job,attempt1,u) WHERE result='reserved';
  SELECT reservation_id INTO reservation2 FROM arvc_internal.audio_analysis_job_quota_reserve(job,attempt1,u) WHERE result='reserved';
  IF reservation1 IS NULL OR reservation1 IS DISTINCT FROM reservation2 THEN RAISE EXCEPTION 'duplicate reserve created a second reservation'; END IF;
  IF arvc_internal.audio_analysis_job_quota_start(job,attempt1,reservation1)<>'started' THEN RAISE EXCEPTION 'initial quota start failed'; END IF;
  IF NOT arvc_internal.audio_analysis_job_quota_settle(job,attempt1,reservation1,'failed','injected_failure') THEN RAISE EXCEPTION 'injected attempt failure was not settled'; END IF;
  IF NOT arvc_internal.audio_analysis_job_requeue_attempt(job,attempt1) THEN RAISE EXCEPTION 'failed attempt did not requeue'; END IF;
  SELECT job_id,attempt INTO claimed,attempt2 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS DISTINCT FROM job OR attempt2<>2 THEN RAISE EXCEPTION 'retry claim attempt invalid'; END IF;
  SELECT reservation_id INTO reservation2 FROM arvc_internal.audio_analysis_job_quota_reserve(job,attempt2,u) WHERE result='reserved';
  IF reservation2 IS DISTINCT FROM reservation1 THEN RAISE EXCEPTION 'retry did not reuse the job reservation'; END IF;
  IF arvc_internal.audio_analysis_job_quota_start(job,attempt2,reservation1)<>'started' THEN RAISE EXCEPTION 'retry start did not reactivate the charged job row'; END IF;

  -- Simulate crash after successful quota settlement and before job finish.
  IF NOT arvc_internal.audio_analysis_job_quota_settle(job,attempt2,reservation1,'succeeded',NULL) THEN RAISE EXCEPTION 'success settlement failed'; END IF;
  UPDATE public.audio_analysis_jobs SET lease_until=now()-interval '1 second' WHERE job_id=job;
  SELECT job_id,attempt INTO claimed,attempt3 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS DISTINCT FROM job OR attempt3<>3 THEN RAISE EXCEPTION 'lease recovery did not fence a new attempt'; END IF;
  SELECT reservation_id INTO reservation2 FROM arvc_internal.audio_analysis_job_quota_reserve(job,attempt3,u) WHERE result='reserved';
  IF reservation2 IS DISTINCT FROM reservation1 OR arvc_internal.audio_analysis_job_quota_start(job,attempt3,reservation1)<>'started' THEN
    RAISE EXCEPTION 'post-settlement lease recovery did not reuse the reservation';
  END IF;
  IF NOT arvc_internal.audio_analysis_job_quota_settle(job,attempt3,reservation1,'succeeded',NULL) THEN RAISE EXCEPTION 'idempotent success settlement failed'; END IF;
  IF arvc_internal.audio_analysis_job_quota_settle(job,attempt2,reservation1,'failed','stale_worker') THEN RAISE EXCEPTION 'stale attempt settled quota'; END IF;
  IF arvc_internal.audio_analysis_job_finish_attempt(job,attempt2,'succeeded','{"stale":true}'::jsonb,NULL) THEN RAISE EXCEPTION 'stale attempt finished job'; END IF;
  IF NOT arvc_internal.audio_analysis_job_finish_attempt(job,attempt3,'succeeded','{"featureTimeline":{},"musicSummary":{},"analysisMetadata":{}}'::jsonb,NULL) THEN RAISE EXCEPTION 'current attempt failed to finish'; END IF;
  IF arvc_internal.audio_analysis_job_finish_attempt(job,attempt3,'succeeded','{"duplicate":true}'::jsonb,NULL) THEN RAISE EXCEPTION 'duplicate finish mutated terminal job'; END IF;
  SELECT count(*) INTO n FROM public.audio_analysis_usage WHERE audio_job_id=job;
  IF n<>1 THEN RAISE EXCEPTION 'job has % quota usage rows; expected exactly one',n; END IF;
  SELECT count(*) INTO n FROM public.audio_analysis_usage WHERE user_id=u AND started_at>=date_trunc('day',now());
  IF n<>1 THEN RAISE EXCEPTION 'retry consumed % daily quota units; expected one',n; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE audio_job_id=job AND state='succeeded') THEN RAISE EXCEPTION 'usage and job success diverged'; END IF;

  -- Kill switch must block both reserve and start. A reserved-but-not-started
  -- cancellation is released and does not count as an analysis use.
  SELECT job_id INTO job2 FROM arvc_internal.audio_analysis_job_submit(u,'cancel-before-start',
    extensions.digest(audio||convert_to('|soft','UTF8'),'sha256'),audio,'soft') WHERE result='queued';
  SELECT job_id,attempt INTO claimed,attemptCancel FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS DISTINCT FROM job2 THEN RAISE EXCEPTION 'second job did not claim'; END IF;
  SELECT reservation_id INTO reservation3 FROM arvc_internal.audio_analysis_job_quota_reserve(job2,attemptCancel,u) WHERE result='reserved';
  UPDATE public.audio_analysis_control SET enabled=false WHERE singleton;
  IF arvc_internal.audio_analysis_job_quota_start(job2,attemptCancel,reservation3)<>'disabled' THEN RAISE EXCEPTION 'kill switch did not stop worker start'; END IF;
  UPDATE public.audio_analysis_control SET enabled=true WHERE singleton;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(job2,u) WHERE result='cancel_requested') THEN RAISE EXCEPTION 'pre-start cancel marker failed'; END IF;
  IF NOT arvc_internal.audio_analysis_job_quota_release(job2,attemptCancel,reservation3) THEN RAISE EXCEPTION 'pre-start reservation was not released'; END IF;
  IF NOT arvc_internal.audio_analysis_job_finish_attempt(job2,attemptCancel,'canceled',NULL,'canceled') THEN RAISE EXCEPTION 'pre-start cancellation did not finish'; END IF;
  IF EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE audio_job_id=job2 AND started_at IS NOT NULL) THEN RAISE EXCEPTION 'pre-start cancellation was charged'; END IF;

  SELECT job_id INTO job3 FROM arvc_internal.audio_analysis_job_submit(u,'retry-exhaustion',
    extensions.digest(audio||convert_to('|middle','UTF8'),'sha256'),audio,'middle') WHERE result='queued';
  SELECT job_id,attempt INTO claimed,attempt4 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS DISTINCT FROM job3 THEN RAISE EXCEPTION 'exhaustion test job did not claim'; END IF;
  SELECT reservation_id INTO reservation4 FROM arvc_internal.audio_analysis_job_quota_reserve(job3,attempt4,u) WHERE result='reserved';
  IF arvc_internal.audio_analysis_job_quota_start(job3,attempt4,reservation4)<>'started' THEN RAISE EXCEPTION 'exhaustion test quota start failed'; END IF;
  UPDATE public.audio_analysis_jobs SET attempts=3,lease_until=now()-interval '1 second' WHERE job_id=job3;
  claimed:=NULL;
  SELECT job_id INTO claimed FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS NOT NULL THEN RAISE EXCEPTION 'retry limit returned an expired job for execution'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_jobs WHERE job_id=job3 AND state='failed' AND safe_error_code='worker_lease_expired') THEN
    RAISE EXCEPTION 'exhausted lease did not become terminal';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE audio_job_id=job3 AND state='expired_charged') THEN
    RAISE EXCEPTION 'exhausted started attempt was not settled as charged';
  END IF;

  SELECT job_id INTO job4 FROM arvc_internal.audio_analysis_job_submit(u,'cancel-after-start',
    extensions.digest(audio||convert_to('|off','UTF8'),'sha256'),audio,'off') WHERE result='queued';
  SELECT job_id,attempt INTO claimed,attempt5 FROM arvc_internal.audio_analysis_job_claim_v2();
  IF claimed IS DISTINCT FROM job4 THEN RAISE EXCEPTION 'started-cancel job did not claim'; END IF;
  SELECT reservation_id INTO reservation5 FROM arvc_internal.audio_analysis_job_quota_reserve(job4,attempt5,u) WHERE result='reserved';
  IF arvc_internal.audio_analysis_job_quota_start(job4,attempt5,reservation5)<>'started' THEN RAISE EXCEPTION 'started-cancel quota start failed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(job4,u) WHERE result='cancel_requested') THEN RAISE EXCEPTION 'started-cancel request failed'; END IF;
  IF NOT arvc_internal.audio_analysis_job_quota_settle(job4,attempt5,reservation5,'canceled','canceled') THEN RAISE EXCEPTION 'started cancellation was not settled'; END IF;
  IF NOT arvc_internal.audio_analysis_job_finish_attempt(job4,attempt5,'canceled',NULL,'canceled') THEN RAISE EXCEPTION 'started cancellation did not finish'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE audio_job_id=job4 AND state='canceled' AND started_at IS NOT NULL) THEN
    RAISE EXCEPTION 'started cancellation was not charged exactly once';
  END IF;

  IF has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_job_finish(uuid,text,jsonb,text)','EXECUTE')
    OR has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_job_requeue(uuid)','EXECUTE')
    OR has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_job_claim()','EXECUTE') THEN
    RAISE EXCEPTION 'unfenced worker RPC remains executable';
  END IF;
  IF NOT has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_job_finish_attempt(uuid,integer,text,jsonb,text)','EXECUTE')
    OR NOT has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_job_quota_settle(uuid,integer,uuid,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'attempt-fenced worker RPC is not granted';
  END IF;
END $$;
ROLLBACK;
