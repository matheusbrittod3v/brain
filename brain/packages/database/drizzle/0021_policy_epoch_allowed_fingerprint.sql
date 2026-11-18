ALTER TABLE public.policy_epoch_states
  ADD COLUMN IF NOT EXISTS allowed_policy_fingerprint text;
