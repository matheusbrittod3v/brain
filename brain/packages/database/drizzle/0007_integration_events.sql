CREATE TABLE integration_events (
  tenant_id text NOT NULL,
  provider text NOT NULL,
  external_event_id text NOT NULL,
  project_id text NOT NULL,
  proposal_id text NOT NULL,
  access_policy_id text NOT NULL,
  event_hash text NOT NULL,
  status text DEFAULT 'processing' NOT NULL,
  response jsonb,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT integration_events_pk PRIMARY KEY (tenant_id, provider, external_event_id),
  CONSTRAINT integration_events_status_check CHECK (status IN ('processing', 'completed'))
);
--> statement-breakpoint
ALTER TABLE integration_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_events FORCE ROW LEVEL SECURITY;
CREATE POLICY integration_events_tenant_policy ON integration_events
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_events TO brain_app;
