CREATE TABLE IF NOT EXISTS public.runner_token_usage_daily (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  usage_date date NOT NULL,
  used_tokens integer NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, usage_date)
);
ALTER TABLE public.runner_token_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_token_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY runner_token_usage_daily_tenant_policy ON public.runner_token_usage_daily
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ',')));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.runner_token_usage_daily TO brain_app;
