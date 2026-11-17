DROP POLICY IF EXISTS test_execution_results_tenant_policy ON test_execution_results;
CREATE POLICY test_execution_results_tenant_policy ON test_execution_results
  FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
