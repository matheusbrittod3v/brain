import test from "node:test";
import assert from "node:assert/strict";
import { scanForSecrets, chunkMarkdown } from "../src/index.js";

test("detects leaked secrets before ingestion", () => {
  const res = scanForSecrets("token=ghp_1234567890abcdefghij1234567890");
  assert.equal(res.clean, false);
  assert.ok(res.findings.includes("GitHub Token"));
});

test("runs Gitleaks by default before declaring content clean", () => {
  let invoked = false;
  const res = scanForSecrets("ordinary content", {
    gitleaksRunner: () => { invoked = true; }
  });
  assert.equal(invoked, true);
  assert.equal(res.engine, "gitleaks");
  assert.equal(res.clean, true);
});

test("fails closed when Gitleaks cannot run and the failure cannot be ignored", () => {
  const res = scanForSecrets("ordinary content", {
    ignoreRules: ["Gitleaks Scanner Failure"],
    gitleaksRunner: () => { throw new Error("gitleaks not installed"); }
  });
  assert.equal(res.clean, false);
  assert.equal(res.engine, "unavailable");
  assert.ok(res.findings.includes("Gitleaks Scanner Failure"));
});

test("chunks markdown by H2/H3 sections", () => {
  const md = "# Doc\n\n## Secao 1\nTexto um.\n\n## Secao 2\nTexto dois.";
  const chunks = chunkMarkdown(md);
  assert.equal(chunks.length, 3);
  assert.ok(chunks[1].text.startsWith("## Secao 1"));
});

