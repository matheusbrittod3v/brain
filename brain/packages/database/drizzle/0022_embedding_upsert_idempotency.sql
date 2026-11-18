WITH ranked_embeddings AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY tenant_id, project_id, knowledge_item_id, source_version, chunk_index, embedding_model
      ORDER BY created_at DESC, id DESC
    ) AS row_number
  FROM public.knowledge_embeddings
)
DELETE FROM public.knowledge_embeddings AS embedding
USING ranked_embeddings AS ranked
WHERE embedding.id = ranked.id
  AND ranked.row_number > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ke_item_version_chunk_model_unique
  ON public.knowledge_embeddings (
    tenant_id, project_id, knowledge_item_id, source_version, chunk_index, embedding_model
  );
