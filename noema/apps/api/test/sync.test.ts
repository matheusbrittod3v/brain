import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@noema/audit-engine";
import { buildApp } from "../src/server.js";

test("sync push ingests drafts through gate and sync pull returns authorized items + revocations", async () => {
  const app = buildApp("test-secret-key", ["sub"], new InMemoryAuditLogger());

  const pushRes = await app.inject({
    method: "POST",
    url: "/v1/sync/push",
    headers: { authorization: "Bearer test-secret-key" },
    payload: {
      projectId: "sub",
      drafts: [
        {
          id: "DRAFT-1",
          title: "Regra offline de reembolso",
          content: "Reembolso integral em 7 dias.",
          accessPolicyId: "internal-project"
        }
      ]
    }
  });
  assert.equal(pushRes.statusCode, 200);
  assert.equal(pushRes.json().acceptedCount, 1);

  const pullRes = await app.inject({
    method: "POST",
    url: "/v1/sync/pull",
    headers: { authorization: "Bearer test-secret-key" },
    payload: {
      projectId: "sub",
      sinceSeq: 0,
      knownPolicies: ["internal-project", "restricted-security"]
    }
  });
  assert.equal(pullRes.statusCode, 200);
  const body = pullRes.json();
  assert.equal(body.syncMode, "snapshot", "modo em memória continua usando snapshot de compatibilidade");
  assert.deepEqual(body.revokedPolicies, ["restricted-security"]);
  assert.ok(body.items.some((i: { id: string }) => i.id === "DRAFT-1"));
  assert.equal(body.syncSeq, 0, "sem sync_changes persistido, itens da busca não podem avançar o cursor monotônico");

  const approveRes = await app.inject({
    method: "POST",
    url: "/v1/projects/sub/proposals/DRAFT-1/approve",
    headers: { authorization: "Bearer test-secret-key" }
  });
  assert.equal(approveRes.statusCode, 200);
  assert.equal(approveRes.json().status, "approved");
});
