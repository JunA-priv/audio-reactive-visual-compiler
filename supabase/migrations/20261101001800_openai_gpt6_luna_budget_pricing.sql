-- OpenAI provider migration: preserve existing request/token/budget limits while
-- switching the single allowed provider model and its standard API price snapshot.
-- Apply only to an explicitly approved local environment after reviewing target.
-- Do not apply to Hosted Supabase as part of this change.

ALTER TABLE public.ai_budget_control
  DROP CONSTRAINT ai_budget_control_model_check;

UPDATE public.ai_budget_control
SET model = 'gpt-6-luna',
    pricing_version = 'gpt-6-luna-standard-2026-11-01',
    input_microusd_per_million = 100000,
    output_microusd_per_million = 500000,
    updated_at = pg_catalog.clock_timestamp()
WHERE singleton;

ALTER TABLE public.ai_budget_control
  ADD CONSTRAINT ai_budget_control_model_check
  CHECK (model = 'gpt-6-luna');
