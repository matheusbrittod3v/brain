CREATE TABLE "git_ingestion_heads" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"repository" text NOT NULL,
	"branch" text NOT NULL,
	"commit_sha" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "git_ingestion_heads_tenant_id_project_id_repository_branch_pk" PRIMARY KEY("tenant_id","project_id","repository","branch")
);
--> statement-breakpoint
ALTER TABLE "git_ingestion_heads" ADD CONSTRAINT "git_ingestion_heads_commit_sha_check" CHECK ("commit_sha" ~ '^[0-9a-fA-F]{40,64}$');
--> statement-breakpoint
ALTER TABLE "git_ingestion_heads" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "git_ingestion_heads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "git_ingestion_heads_scope_policy" ON "git_ingestion_heads" FOR ALL
  USING (
    "tenant_id" = current_setting('app.current_tenant_id', true)
    AND "project_id" = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND "access_policy_id" = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.current_tenant_id', true)
    AND "project_id" = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND "access_policy_id" = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
  );
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "git_ingestion_heads" TO brain_app;
