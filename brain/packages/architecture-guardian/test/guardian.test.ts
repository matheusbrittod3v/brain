import test from "node:test";
import assert from "node:assert/strict";
import { evaluateArchitectureChange, LAYER_ORDER, resolvePackageLayer } from "../src/index.js";

test("blocks inverted layer imports in enforced mode but allows in advisory", () => {
  const imports = [{ fromPkg: "core", toPkg: "retrieval", filePath: "packages/core/src/bad.ts" }];

  const enforced = evaluateArchitectureChange({ mode: "enforced", imports });
  assert.equal(enforced.passed, false);
  assert.equal(enforced.violations[0]?.ruleId, "ARCH-LAYER-VIOLATION");

  const advisory = evaluateArchitectureChange({ mode: "advisory", imports });
  assert.equal(advisory.passed, true);
  assert.equal(advisory.violations.length, 1);

  const audit = evaluateArchitectureChange({ mode: "audit", imports });
  assert.equal(audit.passed, true);
  assert.equal(audit.violations.length, 1);
});

test("LAYER_ORDER covers all L0..L4 packages and resolves apps/* to L5", () => {
  assert.equal(LAYER_ORDER.core, 0);
  assert.equal(LAYER_ORDER.database, 1);
  assert.equal(LAYER_ORDER["connector-framework"], 2);
  assert.equal(LAYER_ORDER["task-engine"], 3);
  assert.equal(LAYER_ORDER["knowledge-health"], 4);
  assert.equal(LAYER_ORDER["workflow-orchestrator"], 4);
  assert.equal(LAYER_ORDER["enterprise-views"], 4);
  assert.equal(resolvePackageLayer("apps/api"), 5);
  assert.equal(resolvePackageLayer("@brain/enterprise-views"), 4);
});

test("detects circular dependencies across packages", () => {
  const report = evaluateArchitectureChange({
    mode: "enforced",
    imports: [
      { fromPkg: "task-engine", toPkg: "impact-analysis", filePath: "packages/task-engine/src/a.ts" },
      { fromPkg: "impact-analysis", toPkg: "task-engine", filePath: "packages/impact-analysis/src/b.ts" }
    ]
  });

  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.ruleId === "ARCH-CIRCULAR-DEPENDENCY"));
});

test("enforces apps/ thin-adapter boundaries against cross-app imports and oversized files", () => {
  const report = evaluateArchitectureChange({
    mode: "enforced",
    imports: [{ fromPkg: "apps/api", toPkg: "apps/worker", filePath: "apps/api/src/server.ts" }],
    appFiles: [
      {
        filePath: "apps/api/src/fat.ts",
        content: Array.from({ length: 12 }, (_, i) => `const line${i} = ${i};`).join("\n"),
        maxLines: 5
      }
    ]
  });

  assert.equal(report.passed, false);
  assert.ok(report.violations.some((v) => v.ruleId === "ARCH-APP-BOUNDARY"));
  assert.ok(report.violations.some((v) => v.ruleId === "ARCH-THIN-ADAPTER" && v.severity === "warning"));
});
