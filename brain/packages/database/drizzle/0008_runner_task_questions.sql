CREATE TABLE runner_task_questions (
  question_id text NOT NULL,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  access_policy_id text NOT NULL,
  question text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  response text,
  response_idempotency_key text,
  answered_by text,
  created_at timestamptz DEFAULT now() NOT NULL,
  answered_at timestamptz,
  CONSTRAINT runner_task_questions_pk PRIMARY KEY (tenant_id, project_id, question_id),
  CONSTRAINT runner_task_questions_status_check CHECK (status IN ('pending', 'answered')),
  CONSTRAINT runner_task_questions_answer_check CHECK (
    (status = 'pending' AND response IS NULL AND response_idempotency_key IS NULL AND answered_by IS NULL AND answered_at IS NULL)
    OR
    (status = 'answered' AND response IS NOT NULL AND response_idempotency_key IS NOT NULL AND answered_by IS NOT NULL AND answered_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX idx_rtq_task_status ON runner_task_questions (tenant_id, project_id, task_id, status);
--> statement-breakpoint
CREATE UNIQUE INDEX runner_task_one_pending_question_uq ON runner_task_questions (tenant_id, project_id, task_id) WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE runner_task_questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_task_questions FORCE ROW LEVEL SECURITY;
CREATE POLICY runner_task_questions_tenant_policy ON runner_task_questions
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
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.runner_task_questions TO brain_app;
