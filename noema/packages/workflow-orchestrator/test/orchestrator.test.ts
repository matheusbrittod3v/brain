import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KnowledgeItem } from "@noema/core";
import { orchestrateLivingDocDrafts, suggestLivingDocUpdates } from "../src/index.js";

function makeAdr(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  const now = "2026-10-01T00:00:00Z";
  return {
    id: "ADR-007",
    tenantId: "t1",
    projectId: "billing",
    domainId: 3,
    type: "architecture_decision",
    title: "Gateway de Pagamentos",
    content: "Decisão arquitetural original.",
    status: "approved",
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: "v1",
    sourceUri: ".brain/03-architecture/ADR-007.md",
    version: 1,
    contentHash: "h1",
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    tags: ["payments"],
    relatedIds: [],
    accessPolicyId: "internal-project",
    metadata: { module: "checkout" },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("workflow-orchestrator", () => {
  it("suggests living doc updates and orchestrates draft proposals", () => {
    const adr = makeAdr();
    const deprecatedAdr = makeAdr({ id: "ADR-OLD", status: "deprecated" });
    const changedFiles = ["services/checkout/src/stripe.ts", "README.md"];

    const suggestions = suggestLivingDocUpdates(changedFiles, [adr, deprecatedAdr]);
    assert.equal(suggestions.length, 1);
    assert.ok(suggestions[0]?.includes("ADR-007"));

    const drafts = orchestrateLivingDocDrafts({
      changedFiles,
      items: [adr, deprecatedAdr],
      diffSummary: "Adicionado suporte a idempotência no webhook",
      authorId: "agent-1"
    });

    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.status, "draft");
    assert.equal(drafts[0]?.targetItemId, "ADR-007");
    assert.deepEqual(drafts[0]?.matchedFiles, ["services/checkout/src/stripe.ts"]);
    assert.ok(drafts[0]?.proposedContent.includes("idempotência"));
  });
});
