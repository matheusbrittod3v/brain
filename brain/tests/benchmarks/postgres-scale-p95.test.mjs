import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import postgres from "postgres";

const dbUrl = process.env.BRAIN_INTEGRATION_DB_URL;
const targetChunks = Number(process.env.BRAIN_BENCH_CHUNKS ?? 1000);

test(`PostgreSQL + pgvector exact vs HNSW benchmark (${targetChunks} chunks, 20 req/s)`, { skip: !dbUrl }, async () => {
  const sql = postgres(dbUrl);
  try {
    const queryVec = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? "1" : "0")).join(",")}]`;

    // 1. Exact scan concurrent 20 req/s
    const exactLatencies = [];
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const start = performance.now();
        await sql`SELECT id FROM knowledge_embeddings ORDER BY embedding <=> ${queryVec}::vector LIMIT 10`;
        exactLatencies.push(performance.now() - start);
      })
    );
    exactLatencies.sort((a, b) => a - b);
    const exactP95 = exactLatencies[Math.floor(exactLatencies.length * 0.95)];

    // 2. HNSW + iterative_scan check (Item 26 & 32)
    await sql.unsafe(
      `CREATE INDEX IF NOT EXISTS idx_ke_embedding_hnsw ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);`
    );
    const hnswLatencies = [];
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const start = performance.now();
        await sql.begin(async (tx) => {
          await tx`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`;
          await tx`SELECT id FROM knowledge_embeddings ORDER BY embedding <=> ${queryVec}::vector LIMIT 10`;
        });
        hnswLatencies.push(performance.now() - start);
      })
    );
    hnswLatencies.sort((a, b) => a - b);
    const hnswP95 = hnswLatencies[Math.floor(hnswLatencies.length * 0.95)];

    assert.ok(exactP95 < 800, `Exact p95 (${exactP95.toFixed(2)}ms) exceeded 800ms`);
    assert.ok(hnswP95 < 800, `HNSW p95 (${hnswP95.toFixed(2)}ms) exceeded 800ms`);
  } finally {
    await sql.end();
  }
});
