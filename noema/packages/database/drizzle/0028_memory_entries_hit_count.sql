ALTER TABLE public.memory_entries ADD COLUMN IF NOT EXISTS hit_count integer NOT NULL DEFAULT 0;

