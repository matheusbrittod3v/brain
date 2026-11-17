CREATE TABLE IF NOT EXISTS public.policy_epoch_states (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  actor_id text NOT NULL,
  epoch integer NOT NULL DEFAULT 1 CHECK (epoch > 0),
  revocation_fingerprint text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, actor_id)
);
ALTER TABLE public.policy_epoch_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.policy_epoch_states FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_epoch_states_owner_policy ON public.policy_epoch_states FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND actor_id = current_setting('app.current_actor_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND actor_id = current_setting('app.current_actor_id', true));
GRANT SELECT, INSERT, UPDATE ON public.policy_epoch_states TO brain_app;
