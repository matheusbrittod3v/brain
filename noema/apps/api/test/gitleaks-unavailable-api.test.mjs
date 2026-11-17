import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("API reports scanner outage as unavailable and blocks ingestion", async () => {
  const previous = {
    path: process.env.PATH,
    stores: process.env.NOEMA_PG_STORES,
    boss: process.env.NOEMA_PG_BOSS
  };
  const emptyPath = mkdtempSync(join(tmpdir(), "noema-no-gitleaks-"));
  process.env.PATH = emptyPath;
  process.env.NOEMA_PG_STORES = "0";
  process.env.NOEMA_PG_BOSS = "0";
  const app = buildApp("gitleaks-unavailable-test-key", ["sub"], new InMemoryAuditLogger());
  try {
    const response = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers: { authorization: "Bearer gitleaks-unavailable-test-key" },
      payload: { filePath: ".brain/04-engineering/safe.md", content: "# Safe\n\nNo secrets here." }
    });
    assert.equal(response.statusCode, 503);
    assert.match(response.json().message, /Gitleaks.*indisponível/i);
  } finally {
    await app.close();
    rmSync(emptyPath, { recursive: true, force: true });
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.stores === undefined) delete process.env.NOEMA_PG_STORES;
    else process.env.NOEMA_PG_STORES = previous.stores;
    if (previous.boss === undefined) delete process.env.NOEMA_PG_BOSS;
    else process.env.NOEMA_PG_BOSS = previous.boss;
  }
});
