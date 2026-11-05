-- Run only on a disposable database after all migrations through Step 7k-52.
-- Synthetic identities, jobs, quota rows, and cleanup records roll back.
BEGIN;
DO $$
DECLARE
  u1 constant uuid:='00000000-0000-4000-8000-0000000000a1';
  u2 constant uuid:='00000000-0000-4000-8000-0000000000a2';
  legacy_wav bytea:=decode(repeat('aa',64),'hex');
  storage_wav bytea:=decode(repeat('bb',64),'hex');
  cap_wav bytea:=decode(repeat('cc',45),'hex');
  legacy_job uuid; storage_job uuid; candidate uuid:='00000000-0000-4000-8000-0000000000b2';
  cap_candidate uuid:='00000000-0000-4000-8000-0000000000b4'; cap_key text;
  key text; request_hash bytea; generation_n integer; attempt_n integer; task_result text; claim_state text;
  claimed uuid; owner uuid; payload bytea; reservation uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM auth.users WHERE id IN (u1,u2)) THEN RAISE EXCEPTION 'synthetic users already exist'; END IF;
  INSERT INTO auth.users(id) VALUES(u1),(u2);
  INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at)
    VALUES(u1,true,10,100,1,now()-interval '1 minute',now()+interval '1 day'),(u2,true,10,100,1,now()-interval '1 minute',now()+interval '1 day');
  UPDATE public.audio_analysis_control SET enabled=true,service_daily_limit=10,service_monthly_limit=100,
    concurrent_limit=2,request_window_seconds=600,request_window_limit=20,lease_seconds=900 WHERE singleton;

  SELECT job_id INTO legacy_job FROM arvc_internal.audio_analysis_job_submit(
    u1,'legacy-row',extensions.digest(legacy_wav||convert_to('|hard','UTF8'),'sha256'),legacy_wav,'hard') WHERE result='queued';
  IF legacy_job IS NULL OR NOT EXISTS(SELECT 1 FROM public.audio_analysis_jobs WHERE job_id=legacy_job AND audio_bytes=64 AND audio_object_key IS NULL) THEN
    RAISE EXCEPTION 'legacy bytea insert/count compatibility failed';
  END IF;
  SELECT object_key INTO cap_key FROM arvc_internal.audio_analysis_storage_intent(
    u1,'cap-one',extensions.digest(cap_wav||convert_to('|off','UTF8'),'sha256'),cap_candidate,45,'off') WHERE result='upload';
  IF cap_key IS NULL OR NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_storage_intent(
    u1,'cap-two',extensions.digest(cap_wav||convert_to('|off','UTF8'),'sha256'),'00000000-0000-4000-8000-0000000000b5',45,'off') WHERE result='user_queue_full') THEN
    RAISE EXCEPTION 'per-user queued-plus-upload-intent capacity was not enforced';
  END IF;

  SELECT result,job_id,object_key INTO task_result,storage_job,key FROM arvc_internal.audio_analysis_storage_intent(
    u2,'storage-row',extensions.digest(storage_wav||convert_to('|soft','UTF8'),'sha256'),candidate,64,'soft');
  IF task_result<>'upload' OR storage_job<>candidate OR key<>u2::text||'/'||candidate::text||'.wav' THEN RAISE EXCEPTION 'storage intent path/scope invalid'; END IF;
  request_hash:=extensions.digest(storage_wav||convert_to('|soft','UTF8'),'sha256');
  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_job_submit_storage(u2,'storage-row',request_hash,candidate,'soft') WHERE result='queued') THEN RAISE EXCEPTION 'Storage job registration failed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_jobs WHERE job_id=candidate AND audio_wav=''::bytea AND audio_object_key=key AND audio_bytes=64) THEN RAISE EXCEPTION 'new job did not reference private Storage object'; END IF;
  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_storage_intent(u2,'storage-row',request_hash,'00000000-0000-4000-8000-0000000000b3',64,'soft') WHERE result='existing' AND job_id=candidate AND object_key=key) THEN
    RAISE EXCEPTION 'idempotent Storage submit changed object identity';
  END IF;
  IF EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_job_status(candidate,u1)) THEN RAISE EXCEPTION 'foreign owner read a stored job'; END IF;
  IF (SELECT public FROM storage.buckets WHERE id='arvc-audio-analysis') THEN RAISE EXCEPTION 'audio bucket is public'; END IF;
  IF has_table_privilege('anon','public.audio_analysis_storage_intents','SELECT') OR has_table_privilege('authenticated','public.audio_analysis_storage_cleanup','SELECT') THEN
    RAISE EXCEPTION 'private storage metadata table ACL is too broad';
  END IF;
  IF has_function_privilege('anon','arvc_internal.audio_analysis_storage_intent(uuid,text,bytea,uuid,integer,text)','EXECUTE')
     OR NOT has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_storage_intent(uuid,text,bytea,uuid,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'storage intent RPC ACL is not restricted';
  END IF;

  CREATE TEMP TABLE storage_dispatch(job_id uuid,generation integer) ON COMMIT DROP;
  INSERT INTO storage_dispatch SELECT * FROM arvc_internal.audio_analysis_job_dispatch_claim(2);
  SELECT generation INTO generation_n FROM storage_dispatch WHERE job_id=legacy_job;
  SELECT q.task_result,q.job_id,q.user_id,q.audio_wav,q.attempt INTO claim_state,claimed,owner,payload,attempt_n
    FROM arvc_internal.audio_analysis_job_claim_task(legacy_job,generation_n) q;
  IF claim_state<>'claimed' OR claimed<>legacy_job OR owner<>u1 OR payload<>legacy_wav OR attempt_n<>1 THEN RAISE EXCEPTION 'legacy bytea dual-read failed'; END IF;
  SELECT generation INTO generation_n FROM storage_dispatch WHERE job_id=storage_job;
  SELECT q.task_result,q.job_id,q.user_id,q.audio_wav,q.attempt INTO claim_state,claimed,owner,payload,attempt_n
    FROM arvc_internal.audio_analysis_job_claim_task(storage_job,generation_n) q;
  IF claim_state<>'claimed' OR claimed<>storage_job OR owner<>u2 OR payload<>''::bytea OR attempt_n<>1 THEN RAISE EXCEPTION 'Storage-backed task claim failed'; END IF;
  SELECT q.object_key,q.request_hash INTO key,request_hash FROM arvc_internal.audio_analysis_job_storage_ref(storage_job,attempt_n) q;
  IF key<>u2::text||'/'||storage_job::text||'.wav' OR request_hash<>extensions.digest(storage_wav||convert_to('|soft','UTF8'),'sha256') THEN RAISE EXCEPTION 'attempt-fenced Storage reference failed'; END IF;

  IF NOT arvc_internal.audio_analysis_job_requeue_attempt(storage_job,attempt_n) THEN RAISE EXCEPTION 'retry did not requeue Storage job'; END IF;
  IF EXISTS(SELECT 1 FROM public.audio_analysis_storage_cleanup WHERE object_key=key) THEN RAISE EXCEPTION 'retry incorrectly scheduled audio deletion'; END IF;
  PERFORM * FROM arvc_internal.audio_analysis_job_dispatch_claim(1);
  SELECT generation INTO generation_n FROM public.audio_analysis_job_dispatch WHERE job_id=storage_job;
  SELECT q.task_result,q.attempt INTO claim_state,attempt_n FROM arvc_internal.audio_analysis_job_claim_task(storage_job,generation_n) q;
  IF claim_state<>'claimed' OR attempt_n<>2 THEN RAISE EXCEPTION 'Storage retry did not advance attempt fencing'; END IF;
  SELECT reservation_id INTO reservation FROM arvc_internal.audio_analysis_job_quota_reserve(storage_job,attempt_n,u2) WHERE result='reserved';
  IF reservation IS NULL OR arvc_internal.audio_analysis_job_quota_start(storage_job,attempt_n,reservation)<>'started'
     OR NOT arvc_internal.audio_analysis_job_quota_settle(storage_job,attempt_n,reservation,'succeeded',NULL)
     OR NOT arvc_internal.audio_analysis_job_finish_attempt(storage_job,attempt_n,'succeeded','{"featureTimeline":{},"musicSummary":{},"analysisMetadata":{}}'::jsonb,NULL) THEN
    RAISE EXCEPTION 'Storage job quota/result lifecycle failed';
  END IF;
  IF (SELECT count(*) FROM public.audio_analysis_usage WHERE audio_job_id=storage_job)<>1 THEN RAISE EXCEPTION 'Storage retries duplicated quota reservation'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_storage_cleanup WHERE object_key=key AND audio_bytes=64 AND user_id=u2) THEN RAISE EXCEPTION 'terminal transition did not enqueue object cleanup'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_jobs WHERE job_id=storage_job AND audio_object_key IS NULL AND audio_bytes=0 AND state='succeeded') THEN RAISE EXCEPTION 'terminal row retained live Storage accounting'; END IF;
  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_storage_cleanup_claim(10) WHERE object_key=key) THEN RAISE EXCEPTION 'cleanup claim failed'; END IF;
  IF NOT arvc_internal.audio_analysis_storage_cleanup_failed(key,'storage_delete_failed') THEN RAISE EXCEPTION 'cleanup retry scheduling failed'; END IF;
  UPDATE public.audio_analysis_storage_cleanup SET next_attempt_at=now()-interval '1 second' WHERE object_key=key;
  PERFORM * FROM arvc_internal.audio_analysis_storage_cleanup_claim(10);
  IF NOT arvc_internal.audio_analysis_storage_cleanup_done(key) THEN RAISE EXCEPTION 'cleanup completion failed'; END IF;

  -- Simulate Storage success followed by a lost/failed DB commit. The durable
  -- intent eventually becomes a delete task, while existing jobs stay intact.
  UPDATE public.audio_analysis_storage_intents SET created_at=now()-interval '25 hours' WHERE object_key=cap_key;
  PERFORM * FROM arvc_internal.audio_analysis_storage_cleanup_claim(10);
  IF NOT EXISTS(SELECT 1 FROM public.audio_analysis_storage_cleanup WHERE object_key=cap_key AND audio_bytes=45) THEN RAISE EXCEPTION 'expired orphan upload was not queued for cleanup'; END IF;
  UPDATE public.audio_analysis_storage_cleanup SET next_attempt_at=now()-interval '1 second' WHERE object_key=cap_key;
  PERFORM * FROM arvc_internal.audio_analysis_storage_cleanup_claim(10);
  IF NOT arvc_internal.audio_analysis_storage_cleanup_done(cap_key) THEN RAISE EXCEPTION 'orphan cleanup completion failed'; END IF;

  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(legacy_job,u1) WHERE result='cancel_requested') THEN RAISE EXCEPTION 'legacy running cancel failed'; END IF;
  IF NOT arvc_internal.audio_analysis_job_finish_attempt(legacy_job,1,'canceled',NULL,'canceled') THEN RAISE EXCEPTION 'legacy cancellation finish failed'; END IF;
END $$;
ROLLBACK;
