ALTER TABLE public.handoffs ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE public.runner_tasks ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE public.memory_entries ADD COLUMN IF NOT EXISTS actor_id text;

CREATE INDEX IF NOT EXISTS idx_handoffs_subject ON public.handoffs (tenant_id, project_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_runner_tasks_subject ON public.runner_tasks (tenant_id, project_id, actor_id);
CREATE INDEX IF NOT EXISTS idx_memory_entries_subject ON public.memory_entries (tenant_id, project_id, actor_id);
