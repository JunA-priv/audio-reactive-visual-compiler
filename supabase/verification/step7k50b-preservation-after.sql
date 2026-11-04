-- CI fixture only: run after applying 050b in the same disposable database.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id='00000000-0000-4000-8000-000000000061') THEN RAISE EXCEPTION 'Auth user was not preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_entitlements WHERE user_id='00000000-0000-4000-8000-000000000061' AND enabled AND daily_limit=3 AND monthly_limit=30 AND concurrent_limit=1) THEN RAISE EXCEPTION 'entitlement was not preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_usage WHERE reservation_id='00000000-0000-4000-8000-000000000062' AND user_id='00000000-0000-4000-8000-000000000061' AND state='succeeded' AND safe_error_code='migration_sentinel') THEN RAISE EXCEPTION 'usage history was not preserved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.audio_analysis_control WHERE singleton AND NOT enabled AND service_daily_limit=5 AND service_monthly_limit=60 AND concurrent_limit=1 AND request_window_seconds=12 AND request_window_limit=7 AND lease_seconds=900) THEN RAISE EXCEPTION 'quota control was changed by the queue migration'; END IF;
END $$;
