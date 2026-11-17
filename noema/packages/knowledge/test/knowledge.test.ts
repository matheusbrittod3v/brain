import test from "node:test";
import assert from "node:assert/strict";
import { parseKnowledgeFile, normalizePosixPath } from "../src/index.js";

test("normalizes Windows paths to POSIX", () => {
  assert.equal(normalizePosixPath(".brain\\01-business\\BR-001.yaml"), ".brain/01-business/BR-001.yaml");
});

test("parses YAML business rule into KnowledgeItem", () => {
  const raw = `
id: BR-SUB-014
type: business_rule
title: Cancelamento de assinatura
status: approved
owner: product-team
version: 3
access_policy: internal-project
description: Cliente autorizado pode cancelar assinatura.
`;
  const item = parseKnowledgeFile({
    tenantId: "acme",
    projectId: "subscription-platform",
    filePath: ".brain/01-business/business-rules/BR-SUB-014.yaml",
    rawContent: raw,
    commitSha: "abc1234"
  });

  assert.equal(item.id, "BR-SUB-014");
  assert.equal(item.domainId, 2);
  assert.equal(item.type, "business_rule");
  assert.equal(item.status, "approved");
  assert.equal(item.sourceVersion, "abc1234");
  assert.equal(item.trustLevel, "verified");
});

