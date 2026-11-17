import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../dist/src/server.js";

test("people can save personal notification preferences and disabled approval notices are suppressed", async () => {
  const app = buildApp("preferences-test-key", ["sub"], new InMemoryAuditLogger());
  const headers = { authorization: "Bearer preferences-test-key" };
  try {
    const initial = await app.inject({ method: "GET", url: "/v1/projects/sub/notification-preferences", headers });
    assert.equal(initial.statusCode, 200);
    assert.ok(initial.json().preferences.channels.includes("slack"));

    const saved = await app.inject({
      method: "PUT", url: "/v1/projects/sub/notification-preferences", headers,
      payload: { channels: ["slack"], categories: ["runner_question"], frequency: "immediate" }
    });
    assert.equal(saved.statusCode, 200);

    const proposal = await app.inject({
      method: "POST", url: "/v1/projects/sub/change/propose", headers,
      payload: { title: "Preference test proposal", content: "Used to verify that disabled categories suppress outbound messages." }
    });
    assert.equal(proposal.statusCode, 200);
    const notify = await app.inject({
      method: "POST", url: `/v1/projects/sub/proposals/${proposal.json().proposalId}/notify`, headers,
      payload: { channel: "slack", webhookUrl: "https://example.invalid/webhook" }
    });
    assert.equal(notify.statusCode, 200);
    assert.equal(notify.json().suppressed, true);
    assert.equal(notify.json().delivered, false);

    const reset = await app.inject({ method: "DELETE", url: "/v1/projects/sub/notification-preferences", headers });
    assert.equal(reset.statusCode, 200);
    assert.deepEqual(reset.json().preferences.categories, ["approval", "runner_question"]);
  } finally {
    await app.close();
  }
});
