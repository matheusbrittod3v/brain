CREATE TABLE IF NOT EXISTS test_execution_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  access_policy_id text NOT NULL,
  provider text NOT NULL,
  run_id text NOT NULL,
  test_item_id text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[0-9a-fA-F]{40,64}$'),
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  executed_at timestamptz NOT NULL,
  received_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT test_execution_results_identity_uq UNIQUE (tenant_id, project_id, provider, run_id, test_item_id)
);
CREATE INDEX IF NOT EXISTS idx_test_execution_results_latest
  ON test_execution_results (tenant_id, project_id, test_item_id, executed_at DESC);
ALTER TABLE test_execution_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_execution_results FORCE ROW LEVEL SECURITY;
CREATE POLICY test_execution_results_tenant_policy ON test_execution_results
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
GRANT SELECT, INSERT, UPDATE, DELETE ON test_execution_results TO brain_app;
