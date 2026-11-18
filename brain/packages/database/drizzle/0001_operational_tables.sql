CREATE TABLE "cross_service_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"from_project_id" text NOT NULL,
	"from_service" text NOT NULL,
	"relation" text NOT NULL,
	"to_project_id" text NOT NULL,
	"contract_id" text NOT NULL,
	"schema_version" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"handoff_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"from_agent" text NOT NULL,
	"repo_url" text NOT NULL,
	"branch" text NOT NULL,
	"base_commit_sha" text NOT NULL,
	"working_tree_dirty" boolean DEFAULT false NOT NULL,
	"ephemeral_branch" text,
	"modified_files" text[] DEFAULT '{}' NOT NULL,
	"tests_executed" text[] DEFAULT '{}' NOT NULL,
	"decisions" text[] DEFAULT '{}' NOT NULL,
	"next_steps" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"layer" text NOT NULL,
	"session_id" text,
	"content" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_tasks" (
	"task_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"instruction" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"draft_only" boolean DEFAULT true NOT NULL,
	"max_steps" integer DEFAULT 10 NOT NULL,
	"timeout_seconds" integer DEFAULT 120 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_changes" (
	"sync_seq" serial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"item_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_leases" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"task_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"branch" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_leases_tenant_id_project_id_task_id_pk" PRIMARY KEY("tenant_id","project_id","task_id")
);

--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.organizations, public.projects,
  public.knowledge_items, public.knowledge_item_versions, public.knowledge_embeddings,
  public.knowledge_relations, public.handoffs, public.task_leases, public.runner_tasks,
  public.sync_changes, public.memory_entries, public.cross_service_contracts TO brain_app;
REVOKE UPDATE, DELETE ON TABLE public.audit_logs FROM brain_app;
GRANT SELECT, INSERT ON TABLE public.audit_logs TO brain_app;
