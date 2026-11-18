ALTER TABLE public.approval_requests
  DROP CONSTRAINT IF EXISTS chk_ar_status;

ALTER TABLE public.approval_requests
  ADD CONSTRAINT chk_ar_status
  CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested'));
