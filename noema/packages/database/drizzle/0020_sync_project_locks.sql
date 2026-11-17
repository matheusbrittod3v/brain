CREATE TABLE IF NOT EXISTS public.sync_project_locks (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);

ALTER TABLE public.sync_project_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_project_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_project_locks_scope_policy ON public.sync_project_locks;
CREATE POLICY sync_project_locks_scope_policy ON public.sync_project_locks FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sync_project_locks TO brain_app;
