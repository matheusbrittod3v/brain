import assert from "node:assert/strict";
import test from "node:test";
import { assertProjectAccess, authenticateApiKey } from "../dist/index.js";

test("authenticateApiKey stores an explicit trusted project scope", () => {
  const configuredScope = ["project-a", "project-b"];
  const context = authenticateApiKey("Bearer local-secret", "local-secret", "tenant-a", configuredScope);

  assert.deepEqual(context.allowedProjects, configuredScope);
  configuredScope.push("project-c");
  assert.deepEqual(context.allowedProjects, ["project-a", "project-b"]);
  assert.doesNotThrow(() => assertProjectAccess(context, "project-a"));
});

test("missing project scope denies the requested project instead of deriving access", () => {
  const context = authenticateApiKey("local-secret", "local-secret");

  assert.deepEqual(context.allowedProjects, []);
  assert.throws(() => assertProjectAccess(context, "project-a"), {
    code: "BRAIN_ERR_POLICY_DENIED",
    statusCode: 403
  });
});

test("a literal asterisk is an exact project id, never a wildcard", () => {
  const context = authenticateApiKey("local-secret", "local-secret", "tenant-a", ["*"]);

  assert.doesNotThrow(() => assertProjectAccess(context, "*"));
  assert.throws(() => assertProjectAccess(context, "project-a"), {
    code: "BRAIN_ERR_POLICY_DENIED",
    statusCode: 403
  });
});
