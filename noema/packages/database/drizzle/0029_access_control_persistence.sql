CREATE TABLE public.custom_access_policies (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"access_policy_id" text DEFAULT 'internal-project' NOT NULL,
	"policy_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"allowed_roles" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_access_policies_tenant_id_project_id_policy_id_pk" PRIMARY KEY("tenant_id","project_id","policy_id")
);
--> statement-breakpoint
CREATE TABLE public.project_access_members (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"access_policy_id" text DEFAULT 'internal-project' NOT NULL,
	"actor_id" text NOT NULL,
	"roles" text[] NOT NULL,
	"allowed_policies" text[] NOT NULL,
	"synced_with_keycloak" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_access_members_tenant_id_project_id_actor_id_pk" PRIMARY KEY("tenant_id","project_id","actor_id")
);
--> statement-breakpoint
CREATE TABLE public.temporary_access_grants (
	"grant_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"access_policy_id" text DEFAULT 'internal-project' NOT NULL,
	"actor_id" text NOT NULL,
	"roles" text[] NOT NULL,
	"policy_ids" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "temporary_access_grants_tenant_id_project_id_grant_id_pk" PRIMARY KEY("tenant_id","project_id","grant_id")
);
--> statement-breakpoint
CREATE INDEX idx_custom_access_policies_scope ON public.custom_access_policies USING btree (tenant_id, project_id);--> statement-breakpoint
CREATE INDEX idx_project_access_members_scope ON public.project_access_members USING btree (tenant_id, project_id);--> statement-breakpoint
CREATE INDEX idx_temporary_access_grants_active ON public.temporary_access_grants USING btree (tenant_id, project_id, expires_at);--> statement-breakpoint
ALTER TABLE public.custom_access_policies ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.custom_access_policies FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY custom_access_policies_admin_scope ON public.custom_access_policies FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = 'internal-project'
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = 'internal-project'
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));--> statement-breakpoint
ALTER TABLE public.project_access_members ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.project_access_members FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY project_access_members_admin_scope ON public.project_access_members FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = 'internal-project'
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = 'internal-project'
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));--> statement-breakpoint
ALTER TABLE public.temporary_access_grants ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.temporary_access_grants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY temporary_access_grants_admin_scope ON public.temporary_access_grants FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = 'internal-project'
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = 'internal-project'
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ',')));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_access_policies, public.project_access_members, public.temporary_access_grants TO brain_app;
