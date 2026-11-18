-- Bootstrap administrativo instala extensões antes de executar migrations.

-- Índices de busca lexical (FTS) e filtros
CREATE INDEX IF NOT EXISTS idx_ki_tags ON knowledge_items USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_ki_filter ON knowledge_items (tenant_id, project_id, domain_id, type, status, access_policy_id);

-- Índices de pré-filtragem vetorial exata (pgvector >= 0.8; HNSW omitido até benchmarks e validação de isolamento) e grafo
CREATE INDEX IF NOT EXISTS idx_ke_policy ON knowledge_embeddings (tenant_id, project_id, access_policy_id, embedding_model);
CREATE INDEX IF NOT EXISTS idx_kr_from ON knowledge_relations (tenant_id, from_project_id, from_item_id, relation_type, to_policy_id);
CREATE INDEX IF NOT EXISTS idx_kr_to ON knowledge_relations (tenant_id, to_project_id, to_item_id, relation_type, from_policy_id);

-- Row-Level Security (RLS) obrigatória em todas as 7 tabelas multi-tenant
-- API usa role sem BYPASSRLS e define app.current_tenant_id, app.allowed_projects e app.allowed_policies na transação.
-- Workers internos e migrations usam role dedicada brain_system com BYPASSRLS auditado.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS org_tenant_policy ON organizations;
CREATE POLICY org_tenant_policy ON organizations
  FOR ALL
  USING (id = current_setting('app.current_tenant_id', true))
  WITH CHECK (id = current_setting('app.current_tenant_id', true));

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_tenant_policy ON projects;
CREATE POLICY project_tenant_policy ON projects
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  );

ALTER TABLE knowledge_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ki_tenant_policy ON knowledge_items;
CREATE POLICY ki_tenant_policy ON knowledge_items
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

ALTER TABLE knowledge_item_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kiv_tenant_policy ON knowledge_item_versions;
CREATE POLICY kiv_tenant_policy ON knowledge_item_versions
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

ALTER TABLE knowledge_embeddings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ke_tenant_policy ON knowledge_embeddings;
CREATE POLICY ke_tenant_policy ON knowledge_embeddings
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

ALTER TABLE knowledge_relations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS kr_tenant_policy ON knowledge_relations;
CREATE POLICY kr_tenant_policy ON knowledge_relations
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND from_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND to_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND from_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
    AND to_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND from_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND to_project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND from_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
    AND to_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  );

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS audit_tenant_policy ON audit_logs;
CREATE POLICY audit_tenant_policy ON audit_logs
  FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND coalesce(project_id, '__org__') = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND coalesce(project_id, '__org__') = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  );

-- O bootstrap configura USAGE no schema e defaults SELECT/INSERT para futuras tabelas.
-- Migrations rodam como brain_system, dono destas tabelas; grants atuais são explícitos.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organizations, public.projects,
  public.knowledge_items, public.knowledge_item_versions, public.knowledge_embeddings,
  public.knowledge_relations TO brain_app;
REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM brain_app;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO brain_app;

-- Tabelas operacionais (handoffs, leases, runner_tasks, sync_changes, memory_entries, cross_service_contracts)
CREATE TABLE IF NOT EXISTS public.sync_project_locks (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id)
);
ALTER TABLE sync_project_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_project_locks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_project_locks_scope_policy ON sync_project_locks;
CREATE POLICY sync_project_locks_scope_policy ON sync_project_locks FOR ALL
  USING (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sync_project_locks TO brain_app;

ALTER TABLE IF EXISTS handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS handoffs FORCE ROW LEVEL SECURITY;
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

ALTER TABLE IF EXISTS task_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS task_leases FORCE ROW LEVEL SECURITY;
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

ALTER TABLE IF EXISTS runner_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS runner_tasks FORCE ROW LEVEL SECURITY;
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

ALTER TABLE IF EXISTS sync_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS sync_changes FORCE ROW LEVEL SECURITY;
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

ALTER TABLE IF EXISTS memory_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS memory_entries FORCE ROW LEVEL SECURITY;
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

ALTER TABLE IF EXISTS context_session_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS context_session_items FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS context_session_items_tenant_policy ON context_session_items;
CREATE POLICY context_session_items_tenant_policy ON context_session_items
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
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.context_session_items TO brain_app;

ALTER TABLE IF EXISTS cross_service_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS cross_service_contracts FORCE ROW LEVEL SECURITY;
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

ALTER TABLE IF EXISTS approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS approval_requests FORCE ROW LEVEL SECURITY;
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
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.approval_requests TO brain_app;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

ALTER TABLE IF EXISTS git_ingestion_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS git_ingestion_heads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS git_ingestion_heads_scope_policy ON git_ingestion_heads;
CREATE POLICY git_ingestion_heads_scope_policy ON git_ingestion_heads
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
DO $$ BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.git_ingestion_heads TO brain_app;
EXCEPTION WHEN undefined_table THEN NULL;
END $$;
