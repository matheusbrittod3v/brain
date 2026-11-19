import test from "node:test";
import assert from "node:assert/strict";
import { parseKnowledgeFile } from "../src/index.js";

test("parses new domain types such as glossary_term, product_capability, runbook, and acceptance_criteria", () => {
  const types = [
    "glossary_term",
    "product_capability",
    "data_model",
    "use_case",
    "journey",
    "risk_control",
    "slo_target",
    "runbook",
    "incident_postmortem",
    "pending_decision",
    "implementation_pattern",
    "limit_constraint",
    "role_responsibility",
    "compatibility_matrix",
    "code_vocabulary",
    "experiment_record",
    "known_exception",
    "mock_data_sample",
    "external_dependency",
    "acceptance_criteria"
  ] as const;

  for (const type of types) {
    const yamlDoc = [
      `id: ITEM-${type.toUpperCase()}`,
      `title: Sample ${type}`,
      `type: ${type}`,
      `status: approved`,
      `summary: Validating parser support for ${type}`
    ].join("\n");

    const parsed = parseKnowledgeFile({
      tenantId: "default-org",
      projectId: "brain",
      filePath: `.brain/04-engineering/${type}.yaml`,
      rawContent: yamlDoc
    });

    assert.equal(parsed.type, type);
    assert.equal(parsed.status, "approved");
    assert.equal(parsed.id, `ITEM-${type.toUpperCase()}`);
  }
});
