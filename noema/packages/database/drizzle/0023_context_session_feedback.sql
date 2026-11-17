CREATE TABLE "context_session_items" (
	"tenant_id" text NOT NULL,
	"project_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"session_id" text NOT NULL,
	"item_id" text NOT NULL,
	"access_policy_id" text NOT NULL,
	"source_uri" text NOT NULL,
	"task_id" text,
	"hit_evidence" text[] DEFAULT '{}' NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hit_at" timestamp with time zone,
	CONSTRAINT "context_session_items_tenant_id_project_id_actor_id_session_id_item_id_pk" PRIMARY KEY("tenant_id","project_id","actor_id","session_id","item_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "context_sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD COLUMN "context_hit_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "context_session_items" ADD CONSTRAINT "context_session_items_tenant_id_project_id_item_id_knowledge_items_tenant_id_project_id_id_fk" FOREIGN KEY ("tenant_id","project_id","item_id") REFERENCES "public"."knowledge_items"("tenant_id","project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_context_session_items_subject" ON "context_session_items" USING btree ("tenant_id","project_id","actor_id","session_id");--> statement-breakpoint
CREATE INDEX "idx_context_session_items_path" ON "context_session_items" USING btree ("tenant_id","project_id","actor_id","session_id","source_uri");--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "chk_ki_context_session_counts" CHECK (context_sent_count >= 0 AND context_hit_count >= 0 AND context_hit_count <= context_sent_count);--> statement-breakpoint
ALTER TABLE "context_session_items" ADD CONSTRAINT "chk_context_session_id_length" CHECK (length(session_id) BETWEEN 1 AND 128 AND session_id !~ '[[:cntrl:]]');--> statement-breakpoint
ALTER TABLE "context_session_items" ADD CONSTRAINT "chk_context_hit_evidence" CHECK (hit_evidence <@ ARRAY['read', 'citation', 'edit']::text[]);--> statement-breakpoint
ALTER TABLE public.context_session_items ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.context_session_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY context_session_items_tenant_policy ON public.context_session_items
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
  );--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.context_session_items TO brain_app;
