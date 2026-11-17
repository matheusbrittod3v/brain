ALTER TABLE public.runner_tasks
  ADD COLUMN IF NOT EXISTS result_metadata jsonb;
