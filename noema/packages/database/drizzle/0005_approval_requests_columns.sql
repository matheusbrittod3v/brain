ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS proposal_id text,
  ADD COLUMN IF NOT EXISTS item_json jsonb,
  ADD COLUMN IF NOT EXISTS review_note text,
  ADD COLUMN IF NOT EXISTS pr_url text;
--> statement-breakpoint
ALTER TABLE public.approval_requests
  ALTER COLUMN actor_type SET DEFAULT 'human';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_ar_tenant_project_proposal
  ON public.approval_requests (tenant_id, project_id, proposal_id)
  WHERE proposal_id IS NOT NULL;

