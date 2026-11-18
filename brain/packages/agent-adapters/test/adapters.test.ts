import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIdeAdapter, type SupportedIde } from "../src/index.js";

describe("agent-adapters", () => {
  it("generates thin MCP + instruction adapters for all supported IDEs", () => {
    const ides: SupportedIde[] = ["antigravity", "cursor", "claude-code", "codex", "kiro", "vscode", "jetbrains"];
    const dir = mkdtempSync(join(tmpdir(), "brain-adapters-"));
    try {
      for (const ide of ides) {
        const files = installIdeAdapter(dir, ide, { mcpUrl: "http://localhost:3001/mcp" });
        assert.equal(files.length, 2);
        for (const f of files) {
          assert.ok(existsSync(f));
        }
        const mcpRaw = readFileSync(files[0]!, "utf8");
        assert.ok(mcpRaw.includes("streamable-http"));
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

