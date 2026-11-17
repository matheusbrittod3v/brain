import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("local API key uses configured policy scope for ingestion", async () => {
  const previous = process.env.NOEMA_ALLOWED_POLICIES;
  process.env.NOEMA_ALLOWED_POLICIES = "public-org,internal-project";
  const app = buildApp("policy-scope-test-key", ["sub"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer policy-scope-test-key" };
  try {
    const denied = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/04-engineering/confidential.md",
        content: "---\nid: CONFIDENTIAL-1\ntitle: Confidential item\nstatus: approved\naccess_policy: confidential-business\n---\n\nMust not be ingested under the configured local policy scope."
      }
    });
    assert.equal(denied.statusCode, 403);

    const allowed = await app.inject({
      method: "POST",
      url: "/v1/projects/sub/ingest",
      headers,
      payload: {
        filePath: ".brain/04-engineering/internal.md",
        content: "---\nid: INTERNAL-1\ntitle: Internal item\nstatus: approved\naccess_policy: internal-project\n---\n\nAllowed under the configured local policy scope."
      }
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.NOEMA_ALLOWED_POLICIES;
    else process.env.NOEMA_ALLOWED_POLICIES = previous;
  }
});
