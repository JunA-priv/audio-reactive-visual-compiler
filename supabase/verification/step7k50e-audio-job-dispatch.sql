-- Run only on a disposable DB after migrations 042, 050b, 050d and 050e.
-- All synthetic rows, quota usage, and queue changes are rolled back.
BEGIN;
DO $$
DECLARE
  u1 constant uuid := '00000000-0000-4000-8000-000000000081';
  u2 constant uuid := '00000000-0000-4000-8000-000000000082';
  u3 constant uuid := '00000000-0000-4000-8000-000000000083';
  a1 constant bytea := decode(repeat('81',45),'hex');
  a2 constant bytea := decode(repeat('82',45),'hex');
  a3 constant bytea := decode(repeat('83',45),'hex');
  j1 uuid; j2 uuid; j3 uuid; rollback_job uuid;
  gen1 integer; gen2 integer; gen3 integer; retry_gen integer; recovered_gen integer;
  task_state text; claimed_job uuid; owner_id uuid; payload bytea; gate text; attempt_n integer;
  reservation uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM auth.users WHERE id IN (u1,u2,u3)) THEN
    RAISE EXCEPTION 'synthetic users exist; refusing to overwrite';
  END IF;
  INSERT INTO auth.users(id) VALUES(u1),(u2),(u3);
  INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at)
    VALUES (u1,true,10,100,1,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 day'),
           (u2,true,10,100,1,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 day'),
           (u3,true,10,100,1,pg_catalog.clock_timestamp()-interval '1 minute',pg_catalog.clock_timestamp()+interval '1 day');
  UPDATE public.audio_analysis_control SET enabled=true,service_daily_limit=10,service_monthly_limit=100,
    concurrent_limit=2,request_window_seconds=600,request_window_limit=20,lease_seconds=900 WHERE singleton;

  SELECT job_id INTO j1 FROM arvc_internal.audio_analysis_job_submit(u1,'dispatch-one',extensions.digest(a1||convert_to('|hard','UTF8'),'sha256'),a1,'hard') WHERE result='queued';
  SELECT job_id INTO j2 FROM arvc_internal.audio_analysis_job_submit(u2,'dispatch-two',extensions.digest(a2||convert_to('|soft','UTF8'),'sha256'),a2,'soft') WHERE result='queued';
  SELECT job_id INTO j3 FROM arvc_internal.audio_analysis_job_submit(u3,'dispatch-three',extensions.digest(a3||convert_to('|middle','UTF8'),'sha256'),a3,'middle') WHERE result='queued';
  IF j1 IS NULL OR j2 IS NULL OR j3 IS NULL THEN RAISE EXCEPTION 'job submit failed'; END IF;
  IF (SELECT count(*) FROM public.audio_analysis_job_dispatch WHERE job_id IN (j1,j2,j3))<>3 THEN
    RAISE EXCEPTION 'successful submit did not atomically create one outbox row per job';
  END IF;
  -- Force an exception after submit in a PL/pgSQL subtransaction. Neither the job nor outbox row may survive.
  BEGIN
    SELECT job_id INTO rollback_job FROM arvc_internal.audio_analysis_job_submit(u1,'dispatch-rollback',extensions.digest(a1||convert_to('|off','UTF8'),'sha256'),a1,'off') WHERE result='queued';
    RAISE EXCEPTION USING ERRCODE='Z0001',MESSAGE='intentional rollback sentinel';
  EXCEPTION WHEN SQLSTATE 'Z0001' THEN NULL;
  END;
  IF EXISTS(SELECT 1 FROM public.audio_analysis_jobs WHERE user_id=u1 AND idempotency_key='dispatch-rollback')
     OR EXISTS(SELECT 1 FROM public.audio_analysis_job_dispatch WHERE job_id=rollback_job) THEN
    RAISE EXCEPTION 'job/outbox rows survived caller rollback';
  END IF;

  CREATE TEMP TABLE initial_dispatch(job_id uuid,generation integer) ON COMMIT DROP;
  INSERT INTO initial_dispatch SELECT * FROM arvc_internal.audio_analysis_job_dispatch_claim(2);
  IF (SELECT count(*) FROM initial_dispatch)<>2 OR EXISTS(SELECT 1 FROM initial_dispatch WHERE job_id=j3) THEN
    RAISE EXCEPTION 'first dispatch did not reserve two jobs and leave the third queued';
  END IF;
  IF (SELECT state FROM public.audio_analysis_job_dispatch WHERE job_id=j3)<>'pending' THEN
    RAISE EXCEPTION 'third job was not left pending';
  END IF;
  SELECT generation INTO gen1 FROM initial_dispatch WHERE job_id=j1;
  SELECT generation INTO gen2 FROM initial_dispatch WHERE job_id=j2;
  IF gen1 IS NULL OR gen2 IS NULL THEN RAISE EXCEPTION 'eligible FIFO jobs were not dispatched'; END IF;

  -- A Cloud Tasks enqueue error returns the lease to pending with backoff.
  IF NOT arvc_internal.audio_analysis_job_dispatch_failed(j1,gen1,'dispatch_failed') THEN RAISE EXCEPTION 'dispatch failure was not recorded'; END IF;
  UPDATE public.audio_analysis_job_dispatch SET next_attempt_at=pg_catalog.clock_timestamp()-interval '1 second' WHERE job_id=j1;
  -- Cancel the other leased waiter; dispatch claim should free its slot and redispatch the failed job plus job 3.
  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(j2,u2) WHERE result='canceled') THEN RAISE EXCEPTION 'queued cancel failed'; END IF;
  CREATE TEMP TABLE retry_dispatch(job_id uuid,generation integer) ON COMMIT DROP;
  INSERT INTO retry_dispatch SELECT * FROM arvc_internal.audio_analysis_job_dispatch_claim(2);
  IF (SELECT count(*) FROM retry_dispatch)<>2 OR NOT EXISTS(SELECT 1 FROM retry_dispatch WHERE job_id=j1)
     OR NOT EXISTS(SELECT 1 FROM retry_dispatch WHERE job_id=j3) THEN
    RAISE EXCEPTION 'failed enqueue or freed dispatch capacity was not recovered';
  END IF;
  SELECT generation INTO retry_gen FROM retry_dispatch WHERE job_id=j1;

  -- Disabled kill switch defers delivery and increments generation; old and duplicate task identities cannot claim it.
  UPDATE public.audio_analysis_control SET enabled=false WHERE singleton;
  SELECT task_result INTO task_state FROM arvc_internal.audio_analysis_job_claim_task(j1,retry_gen);
  IF task_state<>'deferred' THEN RAISE EXCEPTION 'disabled task did not defer'; END IF;
  SELECT task_result INTO task_state FROM arvc_internal.audio_analysis_job_claim_task(j1,retry_gen);
  IF task_state<>'stale' THEN RAISE EXCEPTION 'old dispatch generation was not fenced'; END IF;
  UPDATE public.audio_analysis_control SET enabled=true WHERE singleton;
  UPDATE public.audio_analysis_job_dispatch SET next_attempt_at=pg_catalog.clock_timestamp() WHERE job_id=j1;
  CREATE TEMP TABLE retry_after_defer(job_id uuid,generation integer) ON COMMIT DROP;
  INSERT INTO retry_after_defer SELECT * FROM arvc_internal.audio_analysis_job_dispatch_claim(1);
  SELECT generation INTO recovered_gen FROM retry_after_defer WHERE job_id=j1;
  IF recovered_gen IS NULL OR recovered_gen<=retry_gen THEN RAISE EXCEPTION 'deferred job generation was not advanced'; END IF;

  SELECT task_result,job_id,user_id,audio_wav,kick_gate_mode,attempt INTO task_state,claimed_job,owner_id,payload,gate,attempt_n
    FROM arvc_internal.audio_analysis_job_claim_task(j1,recovered_gen);
  IF task_state<>'claimed' OR claimed_job<>j1 OR owner_id<>u1 OR payload<>a1 OR gate<>'hard' OR attempt_n<>1 THEN
    RAISE EXCEPTION 'task did not claim only the requested job';
  END IF;
  SELECT task_result INTO task_state FROM arvc_internal.audio_analysis_job_claim_task(j1,recovered_gen);
  IF task_state<>'busy' THEN RAISE EXCEPTION 'duplicate active delivery was not made idempotent'; END IF;

  -- An abandoned worker lease recovers the same job under a newer dispatch generation and attempt.
  UPDATE public.audio_analysis_jobs SET lease_until=pg_catalog.clock_timestamp()-interval '1 second' WHERE job_id=j1;
  CREATE TEMP TABLE lease_recovery(job_id uuid,generation integer) ON COMMIT DROP;
  INSERT INTO lease_recovery SELECT * FROM arvc_internal.audio_analysis_job_dispatch_claim(1);
  SELECT generation INTO gen3 FROM lease_recovery WHERE job_id=j1;
  IF gen3 IS NULL OR gen3<=recovered_gen OR NOT EXISTS(SELECT 1 FROM public.audio_analysis_jobs WHERE job_id=j1 AND state='queued' AND attempts=1) THEN
    RAISE EXCEPTION 'expired worker lease was not recovered and fenced';
  END IF;
  SELECT task_result,attempt INTO task_state,attempt_n FROM arvc_internal.audio_analysis_job_claim_task(j1,gen3);
  IF task_state<>'claimed' OR attempt_n<>2 THEN RAISE EXCEPTION 'recovered delivery did not advance attempt'; END IF;

  SELECT reservation_id INTO reservation FROM arvc_internal.audio_analysis_job_quota_reserve(j1,attempt_n,u1) WHERE result='reserved';
  IF reservation IS NULL OR arvc_internal.audio_analysis_job_quota_start(j1,attempt_n,reservation)<>'started' THEN RAISE EXCEPTION 'recovered job quota start failed'; END IF;
  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(j1,u1) WHERE result='cancel_requested') THEN RAISE EXCEPTION 'running cancellation was not requested'; END IF;
  IF NOT arvc_internal.audio_analysis_job_quota_settle(j1,attempt_n,reservation,'canceled','canceled')
     OR NOT arvc_internal.audio_analysis_job_finish_attempt(j1,attempt_n,'canceled',NULL,'canceled') THEN
    RAISE EXCEPTION 'running cancellation quota/job settlement failed';
  END IF;
  -- Terminal rows are marked done and cannot be dispatched again.
  PERFORM * FROM arvc_internal.audio_analysis_job_dispatch_claim(2);
  IF (SELECT state FROM public.audio_analysis_job_dispatch WHERE job_id=j1)<>'done'
     OR (SELECT state FROM public.audio_analysis_job_dispatch WHERE job_id=j2)<>'done' THEN
    RAISE EXCEPTION 'terminal/cancelled jobs did not close their dispatch rows';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM arvc_internal.audio_analysis_job_cancel(j3,u3) WHERE result='canceled') THEN RAISE EXCEPTION 'third queued job cancellation failed'; END IF;
  PERFORM * FROM arvc_internal.audio_analysis_job_dispatch_claim(2);
  IF (SELECT state FROM public.audio_analysis_job_dispatch WHERE job_id=j3)<>'done' THEN RAISE EXCEPTION 'cancelled queued task remained dispatchable'; END IF;

  IF (SELECT count(*) FROM public.audio_analysis_usage WHERE audio_job_id=j1)<>1 THEN RAISE EXCEPTION 'retry/cancel created duplicate quota usage'; END IF;
  IF has_table_privilege('anon','public.audio_analysis_job_dispatch','SELECT')
     OR has_table_privilege('authenticated','public.audio_analysis_job_dispatch','SELECT')
     OR has_table_privilege('service_role','public.audio_analysis_job_dispatch','SELECT')
     OR has_table_privilege('arvc_audio_analysis','public.audio_analysis_job_dispatch','SELECT') THEN
    RAISE EXCEPTION 'direct dispatch table access is present';
  END IF;
  IF NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_catalog.pg_class WHERE oid='public.audio_analysis_job_dispatch'::regclass) THEN
    RAISE EXCEPTION 'dispatch table does not force RLS';
  END IF;
  IF NOT has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_job_dispatch_claim(integer)','EXECUTE')
     OR has_function_privilege('authenticated','arvc_internal.audio_analysis_job_dispatch_claim(integer)','EXECUTE') THEN
    RAISE EXCEPTION 'dispatch RPC ACL is not restricted';
  END IF;
END $$;
ROLLBACK;
