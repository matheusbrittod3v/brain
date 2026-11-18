ALTER TABLE public.notification_preferences
  DROP CONSTRAINT IF EXISTS notification_preferences_frequency_check;
ALTER TABLE public.notification_preferences
  ADD CONSTRAINT notification_preferences_frequency_check CHECK (frequency IN ('immediate', 'daily', 'weekly'));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  actor_id text NOT NULL,
  access_policy_id text NOT NULL,
  channel text NOT NULL,
  category text NOT NULL,
  event_key text NOT NULL,
  payload jsonb NOT NULL,
  scheduled_at timestamptz NOT NULL,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_outbox_event UNIQUE (tenant_id, project_id, actor_id, event_key)
);
CREATE INDEX IF NOT EXISTS idx_notification_outbox_pending
  ON public.notification_outbox (tenant_id, project_id, actor_id, scheduled_at)
  WHERE delivered_at IS NULL;
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY notification_outbox_owner_policy ON public.notification_outbox FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
    AND actor_id = current_setting('app.current_actor_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND project_id = ANY(string_to_array(current_setting('app.allowed_projects', true), ','))
    AND access_policy_id = ANY(string_to_array(current_setting('app.allowed_policies', true), ','))
    AND actor_id = current_setting('app.current_actor_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_outbox TO brain_app;
