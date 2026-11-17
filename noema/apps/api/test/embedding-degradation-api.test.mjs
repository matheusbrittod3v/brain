import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("API keeps ingested knowledge searchable and returns a warning when embeddings are unavailable", async () => {
  const previous = {
    stores: process.env.NOEMA_PG_STORES,
    boss: process.env.NOEMA_PG_BOSS,
    databaseUrl: process.env.DATABASE_URL
  };
  process.env.NOEMA_PG_STORES = "0";
  process.env.NOEMA_PG_BOSS = "1";
  process.env.DATABASE_URL = "postgresql://brain_app:unused@127.0.0.1:1/noema";
  const app = buildApp(
    "embedding-degradation-test-key",
    ["sub"],
    new InMemoryAuditLogger(),
    undefined,
    undefined,
    undefined,
    async () => ({ available: false, reason: "provider_unreachable" })
  );
  const headers = { authorization: "Bearer embedding-degradation-test-key" };
  const itemId = "EMBEDDING-OFFLINE-1";
  const marker = "lexical fallback remains available";
  try {
    const ingest = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: `.brain/04-engineering/${itemId}.md`,
        content: `---\nid: ${itemId}\ntitle: Offline embedding fallback\ntype: architecture_decision\nstatus: approved\naccess_policy: internal-project\n---\n\n${marker}`
      }
    });
    assert.equal(ingest.statusCode, 200);
    assert.ok(ingest.json().warnings.some((warning) => /embedding/i.test(warning)));

    const search = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/search",
      headers,
      payload: { query: marker, limit: 5 }
    });
    assert.equal(search.statusCode, 200);
    assert.ok(search.json().items.some((item) => item.id === itemId));
  } finally {
    await app.close();
    if (previous.stores === undefined) delete process.env.NOEMA_PG_STORES;
    else process.env.NOEMA_PG_STORES = previous.stores;
    if (previous.boss === undefined) delete process.env.NOEMA_PG_BOSS;
    else process.env.NOEMA_PG_BOSS = previous.boss;
    if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous.databaseUrl;
  }
});
