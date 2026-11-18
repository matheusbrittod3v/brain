CREATE TABLE IF NOT EXISTS public.approval_reminder_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  proposal_id text NOT NULL,
  access_policy_id text NOT NULL,
  due_at timestamptz NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('reminder', 'escalation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_approval_reminder_event UNIQUE (tenant_id, project_id, proposal_id, due_at, event_type)
);
ALTER TABLE public.approval_reminder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_reminder_events FORCE ROW LEVEL SECURITY;
CREATE POLICY approval_reminder_events_policy ON public.approval_reminder_events FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.approval_reminder_events TO brain_app;
