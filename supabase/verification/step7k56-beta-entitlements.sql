-- Disposable database only. Verify beta bypasses per-user count caps while
-- service caps, environment scope, expiry, rate, concurrency and kill switch remain.
BEGIN;
DO $$
DECLARE
  beta_user constant uuid := '00000000-0000-4000-8000-000000000561';
  standard_user constant uuid := '00000000-0000-4000-8000-000000000562';
  uninvited_user constant uuid := '00000000-0000-4000-8000-000000000564';
  frozen_user constant uuid := '00000000-0000-4000-8000-000000000565';
  expired_user constant uuid := '00000000-0000-4000-8000-000000000566';
  reservation uuid;
  result text;
  i integer;
  intents_before bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id IN (beta_user,standard_user,uninvited_user,frozen_user,expired_user)) THEN
    RAISE EXCEPTION 'Step 7k-56 synthetic user already exists; refusing to overwrite';
  END IF;
  INSERT INTO auth.users(id) VALUES(beta_user),(standard_user),(uninvited_user),(frozen_user),(expired_user);
  INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at,access_tier,deployment_environment)
    VALUES(beta_user,true,1,1,1,now()-interval '1 minute',now()+interval '1 day','beta','local'),
          (standard_user,true,1,1,1,now()-interval '1 minute',now()+interval '1 day','standard','local'),
          (frozen_user,false,1,1,1,now()-interval '1 minute',now()+interval '1 day','beta','local'),
          (expired_user,true,1,1,1,now()-interval '1 day',now()-interval '1 minute','beta','local');
  UPDATE public.audio_analysis_control SET enabled=true,service_daily_limit=100,service_monthly_limit=1000,
    concurrent_limit=2,request_window_seconds=600,request_window_limit=100,lease_seconds=900,deployment_environment='local'
    WHERE singleton;

  -- Existing use is already above the beta user's nominal 1/day and 1/month.
  FOR i IN 1..3 LOOP
    INSERT INTO public.audio_analysis_usage(user_id,state,created_at,started_at,finalized_at,lease_until)
      VALUES(beta_user,'succeeded',now(),now(),now(),now());
  END LOOP;
  SELECT q.result,q.reservation_id INTO result,reservation FROM arvc_internal.audio_analysis_reserve(beta_user) q;
  IF result<>'reserved' OR reservation IS NULL THEN RAISE EXCEPTION 'beta daily/monthly bypass failed: %',result; END IF;
  IF arvc_internal.audio_analysis_start(reservation)<>'started' THEN RAISE EXCEPTION 'beta reservation did not start'; END IF;
  IF NOT arvc_internal.audio_analysis_settle(reservation,'succeeded',NULL) THEN RAISE EXCEPTION 'beta settlement failed'; END IF;

  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(uninvited_user) q;
  IF result<>'not_entitled' THEN RAISE EXCEPTION 'user without an invitation was admitted: %',result; END IF;
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(frozen_user) q;
  IF result<>'not_entitled' THEN RAISE EXCEPTION 'disabled beta entitlement was admitted: %',result; END IF;
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(expired_user) q;
  IF result<>'not_entitled' THEN RAISE EXCEPTION 'expired beta entitlement was admitted: %',result; END IF;

  -- Standard accounts retain the configured per-user cap.
  INSERT INTO public.audio_analysis_usage(user_id,state,created_at,started_at,finalized_at,lease_until)
    VALUES(standard_user,'succeeded',now(),now(),now(),now());
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(standard_user) q;
  IF result<>'quota_exceeded' THEN RAISE EXCEPTION 'standard user limit was bypassed: %',result; END IF;

  -- System-level cap is still enforced for beta accounts.
  UPDATE public.audio_analysis_control SET service_daily_limit=4 WHERE singleton;
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(beta_user) q;
  IF result<>'quota_exceeded' THEN RAISE EXCEPTION 'beta bypassed service daily cap: %',result; END IF;
  UPDATE public.audio_analysis_control SET service_daily_limit=100,deployment_environment='hosted' WHERE singleton;
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(beta_user) q;
  IF result<>'not_entitled' THEN RAISE EXCEPTION 'cross-environment entitlement was accepted: %',result; END IF;
  SELECT count(*) INTO intents_before FROM public.audio_analysis_storage_intents;
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_storage_intent(
    beta_user,'wrong-environment',extensions.digest(decode(repeat('ab',45),'hex')||convert_to('|off','UTF8'),'sha256'),
    '00000000-0000-4000-8000-000000000563',45,'off') q;
  IF result<>'not_entitled' OR (SELECT count(*) FROM public.audio_analysis_storage_intents)<>intents_before THEN
    RAISE EXCEPTION 'cross-environment entitlement reached Storage reservation: %',result;
  END IF;
  UPDATE public.audio_analysis_control SET deployment_environment='local',enabled=false WHERE singleton;
  SELECT q.result INTO result FROM arvc_internal.audio_analysis_reserve(beta_user) q;
  IF result<>'disabled' THEN RAISE EXCEPTION 'kill switch did not fail closed: %',result; END IF;

  IF has_table_privilege('anon','public.audio_analysis_entitlements','SELECT')
     OR has_table_privilege('authenticated','public.audio_analysis_entitlements','UPDATE')
     OR has_table_privilege('service_role','public.audio_analysis_control','UPDATE')
     OR has_function_privilege('authenticated','arvc_internal.audio_analysis_reserve(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'beta migration broadened application privileges';
  END IF;
  IF NOT has_function_privilege('arvc_audio_analysis','arvc_internal.audio_analysis_environment_matches(text)','EXECUTE')
     OR has_function_privilege('authenticated','arvc_internal.audio_analysis_environment_matches(text)','EXECUTE') THEN
    RAISE EXCEPTION 'environment check RPC ACL is too broad or unavailable to the audio service';
  END IF;
END $$;
ROLLBACK;
