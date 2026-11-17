CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"knowledge_item_id" text NOT NULL,
	"source_version" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"chunk_text" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"embedding_model" text DEFAULT 'bge-m3' NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_item_versions" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"item_id" text NOT NULL,
	"version" integer NOT NULL,
	"domain_id" smallint NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"status" text NOT NULL,
	"source_origin" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"owner_id" text,
	"confidence" real NOT NULL,
	"trust_level" text NOT NULL,
	"is_inferred" boolean NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"access_policy_id" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_item_versions_tenant_id_project_id_item_id_version_pk" PRIMARY KEY("tenant_id","project_id","item_id","version")
);
--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"domain_id" smallint NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"summary" text,
	"status" text NOT NULL,
	"source_id" text NOT NULL,
	"source_origin" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_version" text NOT NULL,
	"source_uri" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content_hash" text NOT NULL,
	"owner_id" text,
	"confidence" real DEFAULT 1 NOT NULL,
	"trust_level" text DEFAULT 'verified' NOT NULL,
	"is_inferred" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce(id, '') || ' ' || coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content, '')) || array_to_tsvector(tags)) STORED,
	"access_policy_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_items_tenant_id_project_id_id_pk" PRIMARY KEY("tenant_id","project_id","id")
);
--> statement-breakpoint
CREATE TABLE "knowledge_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"from_project_id" text NOT NULL,
	"to_project_id" text NOT NULL,
	"from_item_id" text NOT NULL,
	"to_item_id" text NOT NULL,
	"from_policy_id" text NOT NULL,
	"to_policy_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"is_inferred" boolean DEFAULT false NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone,
	"evidence_uri" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_relations_identity_uq" UNIQUE("tenant_id","from_project_id","to_project_id","from_item_id","to_item_id","relation_type")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"knowledge_root" text DEFAULT '.brain/' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_embeddings" ADD CONSTRAINT "ke_item_fk" FOREIGN KEY ("tenant_id","project_id","knowledge_item_id") REFERENCES "public"."knowledge_items"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_organizations_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ki_search" ON "knowledge_items" USING gin ("search_vector");
--> statement-breakpoint
-- Bootstrap administrativo instala extensões antes de executar migrations.

-- Índices de busca lexical (FTS) e filtros
CREATE INDEX IF NOT EXISTS idx_ki_tags ON knowledge_items USING GIN (tags);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ki_filter ON knowledge_items (tenant_id, project_id, domain_id, type, status, access_policy_id);

-- Índices de pré-filtragem vetorial exata (pgvector >= 0.8; HNSW omitido até benchmarks e validação de isolamento) e grafo
CREATE INDEX IF NOT EXISTS idx_ke_policy ON knowledge_embeddings (tenant_id, project_id, access_policy_id, embedding_model);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kr_from ON knowledge_relations (tenant_id, from_project_id, from_item_id, relation_type, to_policy_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_kr_to ON knowledge_relations (tenant_id, to_project_id, to_item_id, relation_type, from_policy_id);

-- Row-Level Security (RLS) obrigatória em todas as 7 tabelas multi-tenant
-- API usa role sem BYPASSRLS e define app.current_tenant_id, app.allowed_projects e app.allowed_policies na transação.
-- Workers internos e migrations usam role dedicada brain_system com BYPASSRLS auditado.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS org_tenant_policy ON organizations;
--> statement-breakpoint
CREATE POLICY org_tenant_policy ON organizations
  FOR ALL
  USING (id = current_setting('app.current_tenant_id', true))
  WITH CHECK (id = current_setting('app.current_tenant_id', true));

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS project_tenant_policy ON projects;
--> statement-breakpoint
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
--> statement-breakpoint
DROP POLICY IF EXISTS ki_tenant_policy ON knowledge_items;
--> statement-breakpoint
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
--> statement-breakpoint
DROP POLICY IF EXISTS kiv_tenant_policy ON knowledge_item_versions;
--> statement-breakpoint
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
--> statement-breakpoint
DROP POLICY IF EXISTS ke_tenant_policy ON knowledge_embeddings;
--> statement-breakpoint
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
--> statement-breakpoint
DROP POLICY IF EXISTS kr_tenant_policy ON knowledge_relations;
--> statement-breakpoint
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
--> statement-breakpoint
DROP POLICY IF EXISTS audit_tenant_policy ON audit_logs;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM brain_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.audit_logs TO brain_app;
