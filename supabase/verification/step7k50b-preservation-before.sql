-- CI fixture only: run after 042 and before 050b in a disposable database.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE id='00000000-0000-4000-8000-000000000061') THEN
    RAISE EXCEPTION 'sentinel Auth user already exists; refusing to overwrite';
  END IF;
END $$;
INSERT INTO auth.users(id) VALUES ('00000000-0000-4000-8000-000000000061');
INSERT INTO public.audio_analysis_entitlements(user_id,enabled,daily_limit,monthly_limit,concurrent_limit,granted_at,expires_at)
VALUES ('00000000-0000-4000-8000-000000000061',true,3,30,1,now()-interval '1 day',now()+interval '30 days');
INSERT INTO public.audio_analysis_usage(reservation_id,user_id,state,created_at,started_at,finalized_at,lease_until,safe_error_code)
VALUES ('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000061','succeeded',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day','migration_sentinel');
UPDATE public.audio_analysis_control SET enabled=false,service_daily_limit=5,service_monthly_limit=60,concurrent_limit=1,request_window_seconds=12,request_window_limit=7,lease_seconds=900 WHERE singleton;
COMMIT;
