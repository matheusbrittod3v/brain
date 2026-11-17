import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TemporalKnowledgeEngine } from "../src/index.js";
import type { AuthContext } from "@noema/auth";
import type { KnowledgeItem } from "@noema/core";

const ctx: AuthContext = {
  tenantId: "t1",
  actorId: "u1",
  actorType: "human",
  roles: ["developer"],
  allowedProjects: ["p1"],
  allowedPolicies: ["internal-project"]
};

function makeItem(version: number, validFrom: string, validUntil?: string, hash = `h${version}`): KnowledgeItem {
  return {
    id: "BR-1",
    tenantId: "t1",
    projectId: "p1",
    domainId: 2,
    type: "business_rule",
    title: `Rule v${version}`,
    content: `Content v${version}`,
    status: "approved",
    sourceId: "git",
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: `sha-${version}`,
    sourceUri: ".brain/01-business/br-1.md",
    version,
    contentHash: hash,
    confidence: 1,
    trustLevel: "verified",
    isInferred: false,
    validFrom,
    validUntil,
    tags: [],
    accessPolicyId: "internal-project",
    relatedIds: [],
    metadata: {},
    createdAt: validFrom,
    updatedAt: validFrom
  };
}

describe("temporal-knowledge", () => {
  it("resolves point-in-time snapshots and diffs versions", () => {
    const engine = new TemporalKnowledgeEngine();
    engine.recordVersion(makeItem(1, "2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"));
    engine.recordVersion(makeItem(2, "2026-02-01T00:00:01Z"));

    const jan = engine.queryAt(ctx, { projectId: "p1", atTimestamp: "2026-01-15T00:00:00Z" });
    const mar = engine.queryAt(ctx, { projectId: "p1", atTimestamp: "2026-03-01T00:00:00Z" });
    assert.equal(jan[0]?.version, 1);
    assert.equal(mar[0]?.version, 2);

    const diff = engine.diffSnapshots(jan, mar);
    assert.deepEqual(diff.modified, ["BR-1"]);
  });
});

