ALTER TABLE public.task_leases ADD COLUMN IF NOT EXISTS target_files text[] NOT NULL DEFAULT ARRAY[]::text[];
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.department_finops_quotas (
  "tenant_id" text NOT NULL,
  "project_id" text NOT NULL,
  "department" text NOT NULL,
  "monthly_token_limit" integer NOT NULL,
  "monthly_usd_limit" text NOT NULL,
  "downgrade_model" text,
  "access_policy_id" text DEFAULT 'internal-project' NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "department_finops_quotas_tenant_id_project_id_department_pk" PRIMARY KEY("tenant_id","project_id","department")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.integration_fallback_owners (
  "tenant_id" text NOT NULL,
  "project_id" text NOT NULL,
  "provider" text NOT NULL,
  "fallback_owner" text NOT NULL,
  "access_policy_id" text DEFAULT 'internal-project' NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "integration_fallback_owners_tenant_id_project_id_provider_pk" PRIMARY KEY("tenant_id","project_id","provider")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.integration_reconnect_history (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "project_id" text NOT NULL,
  "provider" text NOT NULL,
  "status" text NOT NULL,
  "actor_id" text NOT NULL,
  "access_policy_id" text DEFAULT 'internal-project' NOT NULL,
  "last_reconnect_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_integration_reconnect_history_scope ON public.integration_reconnect_history USING btree (tenant_id, project_id, provider, last_reconnect_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.lgpd_shredded_subjects (
  "tenant_id" text NOT NULL,
  "project_id" text NOT NULL,
  "subject_id" text NOT NULL,
  "access_policy_id" text DEFAULT 'internal-project' NOT NULL,
  "shredded_by" text NOT NULL,
  "shredded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "lgpd_shredded_subjects_tenant_id_project_id_subject_id_pk" PRIMARY KEY("tenant_id","project_id","subject_id")
);
--> statement-breakpoint
ALTER TABLE public.department_finops_quotas ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.department_finops_quotas FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS department_finops_quotas_scope_policy ON public.department_finops_quotas;
--> statement-breakpoint
CREATE POLICY department_finops_quotas_scope_policy ON public.department_finops_quotas FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
--> statement-breakpoint
ALTER TABLE public.integration_fallback_owners ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.integration_fallback_owners FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS integration_fallback_owners_scope_policy ON public.integration_fallback_owners;
--> statement-breakpoint
CREATE POLICY integration_fallback_owners_scope_policy ON public.integration_fallback_owners FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
--> statement-breakpoint
ALTER TABLE public.integration_reconnect_history ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.integration_reconnect_history FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS integration_reconnect_history_scope_policy ON public.integration_reconnect_history;
--> statement-breakpoint
CREATE POLICY integration_reconnect_history_scope_policy ON public.integration_reconnect_history FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
--> statement-breakpoint
ALTER TABLE public.lgpd_shredded_subjects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.lgpd_shredded_subjects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS lgpd_shredded_subjects_scope_policy ON public.lgpd_shredded_subjects;
--> statement-breakpoint
CREATE POLICY lgpd_shredded_subjects_scope_policy ON public.lgpd_shredded_subjects FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.department_finops_quotas,
  public.integration_fallback_owners,
  public.integration_reconnect_history,
  public.lgpd_shredded_subjects
TO brain_app;

