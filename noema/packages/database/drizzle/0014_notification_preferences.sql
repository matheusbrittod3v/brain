CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  actor_id text NOT NULL,
  access_policy_id text NOT NULL,
  channels text[] NOT NULL DEFAULT ARRAY['slack','teams','jira','clickup','email']::text[],
  categories text[] NOT NULL DEFAULT ARRAY['approval','runner_question']::text[],
  frequency text NOT NULL DEFAULT 'immediate' CHECK (frequency = 'immediate'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_preferences_owner UNIQUE (tenant_id, project_id, actor_id, access_policy_id)
);
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_preferences_owner_policy ON public.notification_preferences FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
    AND actor_id = current_setting('app.current_actor_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
    AND actor_id = current_setting('app.current_actor_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_preferences TO brain_app;
