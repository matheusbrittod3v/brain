CREATE TABLE IF NOT EXISTS public.developer_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  preferred_package_manager text,
  preferred_test_layout text,
  preferred_architecture_style text,
  coding_conventions text[] NOT NULL DEFAULT ARRAY[]::text[],
  preferred_harness text,
  opt_in_cross_project boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_developer_profiles_owner UNIQUE (tenant_id, actor_id)
);
--> statement-breakpoint
ALTER TABLE public.developer_profiles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.developer_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS developer_profiles_owner_policy ON public.developer_profiles;
--> statement-breakpoint
CREATE POLICY developer_profiles_owner_policy ON public.developer_profiles FOR ALL
  USING (tenant_id = current_setting('app.current_tenant_id', true)
    AND actor_id = current_setting('app.current_actor_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)
    AND actor_id = current_setting('app.current_actor_id', true));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.developer_profiles TO brain_app;

