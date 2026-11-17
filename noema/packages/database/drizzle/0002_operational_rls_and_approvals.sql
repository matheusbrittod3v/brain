CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"item_id" text NOT NULL,
	"domain_id" integer NOT NULL,
	"requested_by" text NOT NULL,
	"actor_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reason" text,
	"access_policy_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "hit_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_items"
  ADD CONSTRAINT "chk_ki_domain_id" CHECK (domain_id BETWEEN 1 AND 12),
  ADD CONSTRAINT "chk_ki_status" CHECK (status IN ('draft', 'approved', 'deprecated', 'superseded')),
  ADD CONSTRAINT "chk_ki_source_origin" CHECK (source_origin IN ('internal', 'external_reference')),
  ADD CONSTRAINT "chk_ki_source_kind" CHECK (source_kind IN ('git', 'api', 'connector', 'agent')),
  ADD CONSTRAINT "chk_ki_trust_level" CHECK (trust_level IN ('verified', 'self_authored', 'untrusted')),
  ADD CONSTRAINT "chk_ki_hit_count" CHECK (hit_count >= 0);
--> statement-breakpoint
ALTER TABLE "knowledge_item_versions"
  ADD CONSTRAINT "chk_kiv_domain_id" CHECK (domain_id BETWEEN 1 AND 12),
  ADD CONSTRAINT "chk_kiv_status" CHECK (status IN ('draft', 'approved', 'deprecated', 'superseded')),
  ADD CONSTRAINT "chk_kiv_source_origin" CHECK (source_origin IN ('internal', 'external_reference')),
  ADD CONSTRAINT "chk_kiv_source_kind" CHECK (source_kind IN ('git', 'api', 'connector', 'agent')),
  ADD CONSTRAINT "chk_kiv_trust_level" CHECK (trust_level IN ('verified', 'self_authored', 'untrusted'));
--> statement-breakpoint
ALTER TABLE "approval_requests"
  ADD CONSTRAINT "chk_ar_domain_id" CHECK (domain_id BETWEEN 1 AND 12),
  ADD CONSTRAINT "chk_ar_status" CHECK (status IN ('pending', 'approved', 'rejected')),
  ADD CONSTRAINT "chk_ar_actor_type" CHECK (actor_type IN ('human', 'agent', 'system'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ar_tenant_project_status ON approval_requests (tenant_id, project_id, status, access_policy_id);
--> statement-breakpoint
ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS handoffs_tenant_policy ON handoffs;
CREATE POLICY handoffs_tenant_policy ON handoffs
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  );
--> statement-breakpoint
ALTER TABLE task_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS leases_tenant_policy ON task_leases;
CREATE POLICY leases_tenant_policy ON task_leases
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  );
--> statement-breakpoint
ALTER TABLE runner_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS runner_tenant_policy ON runner_tasks;
CREATE POLICY runner_tenant_policy ON runner_tasks
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  );
--> statement-breakpoint
ALTER TABLE sync_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_changes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_tenant_policy ON sync_changes;
CREATE POLICY sync_tenant_policy ON sync_changes
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
ALTER TABLE memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_tenant_policy ON memory_entries;
CREATE POLICY memory_tenant_policy ON memory_entries
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
ALTER TABLE cross_service_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cross_service_contracts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cs_tenant_policy ON cross_service_contracts;
CREATE POLICY cs_tenant_policy ON cross_service_contracts
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND from_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND to_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND from_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND to_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  );
--> statement-breakpoint
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_requests_tenant_policy ON approval_requests;
CREATE POLICY approval_requests_tenant_policy ON approval_requests
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
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.approval_requests TO brain_app;