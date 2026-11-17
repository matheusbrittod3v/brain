import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAuditLogger } from "../../packages/audit-engine/dist/src/index.js";
import { buildApp } from "../../apps/api/dist/src/server.js";
import { runHandoffCreate } from "../../apps/cli/dist/src/commands.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("E2E handoff: ephemeral branch and dirty patch transfer between two external IDE clones", async () => {
  const root = mkdtempSync(join(tmpdir(), "noema-handoff-e2e-"));
  const bareDir = join(root, "remote.git");
  const ideA = join(root, "ide-a");
  const ideB = join(root, "ide-b");

  const app = buildApp("handoff-secret", ["sub"], new InMemoryAuditLogger());
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  const hubUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  try {
    git(root, ["init", "--bare", bareDir]);
    git(root, ["clone", bareDir, ideA]);
    git(ideA, ["config", "user.email", "dev-a@acme.dev"]);
    git(ideA, ["config", "user.name", "Dev A"]);
    writeFileSync(join(ideA, "service.ts"), "export const rateLimit = 100;\n", "utf8");
    git(ideA, ["add", "service.ts"]);
    git(ideA, ["commit", "-m", "initial"]);
    git(ideA, ["push", "origin", "HEAD"]);
    const baseCommitSha = git(ideA, ["rev-parse", "HEAD"]);
    const branch = git(ideA, ["rev-parse", "--abbrev-ref", "HEAD"]);

    // Clone into IDE B before IDE A makes dirty edits
    git(root, ["clone", bareDir, ideB]);
    git(ideB, ["config", "user.email", "dev-b@acme.dev"]);
    git(ideB, ["config", "user.name", "Dev B"]);

    // IDE A edits file (dirty working tree) and creates handoff with ephemeral branch + patch
    writeFileSync(join(ideA, "service.ts"), "export const rateLimit = 250;\n", "utf8");
    const patchContent = git(ideA, ["diff"]);
    assert.match(patchContent, /rateLimit = 250/);

    const created = await runHandoffCreate({
      hubUrl,
      apiKey: "handoff-secret",
      projectId: "sub",
      taskId: "TASK-HANDOFF-1",
      repoDir: ideA,
      repoUrl: bareDir,
      branch,
      baseCommitSha,
      modifiedFiles: ["service.ts"],
      nextSteps: ["Revisar novo rateLimit em IDE B"],
      workingTreeDirty: true,
      pushRemote: true,
      patchContent
    });

    assert.ok(created.status >= 200 && created.status < 300, `handoff failed: ${created.status} ${created.body}`);
    const handoffBody = JSON.parse(created.body);
    assert.equal(handoffBody.projectId, "sub");
    assert.equal(handoffBody.taskId, "TASK-HANDOFF-1");

    // IDE B fetches the ephemeral branch or applies the patch and verifies exact state
    if (handoffBody.ephemeralBranch) {
      git(ideB, ["fetch", "origin", handoffBody.ephemeralBranch]);
      git(ideB, ["checkout", "-B", handoffBody.ephemeralBranch, "FETCH_HEAD"]);
    } else {
      execFileSync("git", ["apply", "-"], { cwd: ideB, input: patchContent, encoding: "utf8" });
    }
    assert.equal(readFileSync(join(ideB, "service.ts"), "utf8"), "export const rateLimit = 250;\n");
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
