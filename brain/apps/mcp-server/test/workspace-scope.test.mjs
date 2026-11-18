import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InMemoryAuditLogger } from "@brain/audit-engine";
import { createBrainMcpServer, createBrainRuntime } from "../dist/index.js";

const context = {
  tenantId: "tenant-a", actorId: "agent-a", actorType: "agent", roles: ["developer"],
  allowedProjects: ["allowed-project"], allowedPolicies: ["public-org", "internal-project"]
};

async function connectedClient(runtime) {
  const server = createBrainMcpServer(runtime, context, "internal-project");
  const client = new Client({ name: "workspace-scope-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

test("brain_validate_implementation rejects absolute and parent-traversal paths outside the configured project workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-mcp-workspace-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const outside = join(dir, "outside.ts");
  writeFileSync(outside, 'import { x } from "@brain/database";\n');
  const runtime = { ...createBrainRuntime(new InMemoryAuditLogger()), workspaceRoots: { "allowed-project": workspace } };
  const { client, server } = await connectedClient(runtime);
  try {
    for (const path of [outside, "../outside.ts"]) {
      const result = await client.callTool({
        name: "brain_validate_implementation",
        arguments: { projectId: "allowed-project", diffOrPaths: [path] }
      });
      assert.equal(result.isError, true, `expected ${path} to be rejected as outside the workspace`);
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain_validate_implementation rejects workspace symlinks that resolve outside the project", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-mcp-workspace-link-"));
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const outside = join(dir, "outside.ts");
  writeFileSync(outside, 'import { x } from "@brain/database";\n');
  symlinkSync(outside, join(workspace, "linked.ts"));
  const runtime = { ...createBrainRuntime(new InMemoryAuditLogger()), workspaceRoots: { "allowed-project": workspace } };
  const { client, server } = await connectedClient(runtime);
  try {
    const result = await client.callTool({
      name: "brain_validate_implementation",
      arguments: { projectId: "allowed-project", diffOrPaths: ["linked.ts"] }
    });
    assert.equal(result.isError, true, "a symlink must not escape the configured project workspace");
  } finally {
    await Promise.all([client.close(), server.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain_validate_implementation reads relative paths from the configured project workspace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-mcp-workspace-relative-"));
  const workspace = join(dir, "workspace");
  const sourceDir = join(workspace, "packages", "core", "src");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "inside.ts"), 'import { x } from "@brain/api";\n');
  const runtime = { ...createBrainRuntime(new InMemoryAuditLogger()), workspaceRoots: { "allowed-project": workspace } };
  const { client, server } = await connectedClient(runtime);
  try {
    const result = await client.callTool({
      name: "brain_validate_implementation",
      arguments: { projectId: "allowed-project", diffOrPaths: ["packages/core/src/inside.ts"], mode: "enforced" }
    });
    assert.notEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.checkedImports, 1);
    assert.equal(payload.passed, false);
  } finally {
    await Promise.all([client.close(), server.close()]);
    rmSync(dir, { recursive: true, force: true });
  }
});
