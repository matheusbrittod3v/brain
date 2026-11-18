ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS assigned_to text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_tenant_project_assignee_status
  ON public.approval_requests (tenant_id, project_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;
