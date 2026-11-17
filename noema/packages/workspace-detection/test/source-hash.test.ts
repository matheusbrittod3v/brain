import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findChangedWorkspaceSources, hashWorkspaceSources } from "../src/index.js";

test("hashes workspace sources, detects only changes since baseline, and rejects escaping paths", async () => {
  const parent = mkdtempSync(join(tmpdir(), "noema-source-hash-"));
  const root = join(parent, "workspace");
  const outside = join(parent, "private.txt");
  mkdirSync(root);
  writeFileSync(outside, "private data");
  mkdirSync(join(root, ".brain"));
  writeFileSync(join(root, ".brain", "rule.md"), "version one");
  symlinkSync(outside, join(root, "escape.txt"));

  try {
    const sourceUris = [".brain/rule.md", "../private.txt", "escape.txt", "https://example.test/rule.md", ".brain/missing.md"];
    const baseline = await hashWorkspaceSources(root, sourceUris);
    assert.deepEqual(baseline.map((source) => source.sourceUri), [".brain/rule.md"]);
    assert.match(baseline[0]!.sourceHash, /^[a-f0-9]{64}$/);
    assert.deepEqual(await findChangedWorkspaceSources(root, baseline), []);

    writeFileSync(join(root, ".brain", "rule.md"), "version two");
    assert.deepEqual(await findChangedWorkspaceSources(root, baseline), [".brain/rule.md"]);

    rmSync(join(root, ".brain", "rule.md"));
    assert.deepEqual(await findChangedWorkspaceSources(root, baseline), [".brain/rule.md"], "deletion after delivery counts as a change");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
