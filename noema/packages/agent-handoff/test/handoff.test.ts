import test from "node:test";
import assert from "node:assert/strict";
import { HandoffStore } from "../src/index.js";
import type { AuthContext } from "@noema/auth";

test("creates handoff, detects branch divergence and warns on concurrent lease", () => {
  const store = new HandoffStore();
  const agCtx: AuthContext = {
    tenantId: "acme",
    actorId: "antigravity-user",
    actorType: "agent",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };
  const codexCtx: AuthContext = {
    ...agCtx,
    actorId: "codex-user"
  };

  const ho = store.createHandoff(agCtx, {
    fromAgent: "antigravity",
    projectId: "sub",
    taskId: "TASK-482",
    repoUrl: "https://github.com/acme/sub",
    branch: "feat/cancel",
    baseCommitSha: "abc1234",
    workingTreeDirty: false,
    modifiedFiles: ["src\\sub.ts"],
    testsExecuted: ["sub.spec.ts"],
    decisions: ["ADR-021"],
    nextSteps: ["Implementar endpoint"]
  });

  assert.equal(ho.modifiedFiles[0], "src/sub.ts");

  // Primeiro resume adquire lease
  store.resumeHandoff(agCtx, { projectId: "sub", handoffId: ho.handoffId });
  // Segundo ator recebe warning de lease + divergência de branch
  const resumed = store.resumeHandoff(codexCtx, {
    projectId: "sub",
    handoffId: ho.handoffId,
    currentBranch: "main"
  });

  assert.equal(resumed.warnings.length, 2);
});

