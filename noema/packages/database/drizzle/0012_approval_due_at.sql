ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS due_at timestamptz;

UPDATE public.approval_requests
SET due_at = created_at + interval '72 hours'
WHERE due_at IS NULL;

ALTER TABLE public.approval_requests
  ALTER COLUMN due_at SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_pending_due_at
  ON public.approval_requests (tenant_id, project_id, due_at)
  WHERE status = 'pending';
