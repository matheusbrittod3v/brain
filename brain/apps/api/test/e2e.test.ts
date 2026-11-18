import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { buildApp } from "../src/server.js";

test("end-to-end API: ingest rule + code anchor -> build ContextPack with citations", async () => {
  const app = buildApp("test-secret-key", ["sub"], new InMemoryAuditLogger());

  // 1. Ingest business rule
  const ingestRule = await app.inject({
    method: "POST",
    url: "/v1/projects/sub/ingest",
    headers: { authorization: "Bearer test-secret-key" },
    payload: {
      filePath: ".brain/01-business/BR-SUB-014.yaml",
      content: `
id: BR-SUB-014
type: business_rule
title: Cancelamento de assinatura
status: approved
access_policy: internal-project
description: Cliente autorizado pode cancelar assinatura.
`
    }
  });
  assert.equal(ingestRule.statusCode, 200);

  // 2. Ingest code with @brain-rule anchor
  const ingestCode = await app.inject({
    method: "POST",
    url: "/v1/projects/sub/ingest",
    headers: { authorization: "Bearer test-secret-key" },
    payload: {
      filePath: "src/subscription.service.ts",
      content: "// @brain-rule BR-SUB-014\nexport function cancelSubscription() {}"
    }
  });
  assert.equal(ingestCode.statusCode, 200);
  assert.equal(ingestCode.json().anchorsCount, 1);

  // 3. Build ContextPack
  const ctxRes = await app.inject({
    method: "POST",
    url: "/v1/projects/sub/context",
    headers: { authorization: "Bearer test-secret-key" },
    payload: { task: "Implementar cancelamento de assinatura", explain: true }
  });
  assert.equal(ctxRes.statusCode, 200);
  const pack = ctxRes.json();
  assert.equal(pack.context.businessRules.length, 1);
  assert.equal(pack.sources[0].id, "BR-SUB-014");

  // 4. Reject secret leakage
  const secretRes = await app.inject({
    method: "POST",
    url: "/v1/projects/sub/ingest",
    headers: { authorization: "Bearer test-secret-key" },
    payload: {
      filePath: ".env.bad",
      content: "GITHUB_TOKEN=ghp_1234567890abcdefghij1234567890"
    }
  });
  assert.equal(secretRes.statusCode, 422);
});

