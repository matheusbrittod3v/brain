import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema } from "@scip-code/scip";
import { initBundledTreeSitterLanguage } from "@brain/code-intelligence";
import { analyzeGitHistory, discoverDeterministic, runProjectAutodiscovery } from "../src/index.js";

describe("project-discovery", () => {
  it("separates deterministic discovery (1.0) from multi-domain inferred drafts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-disc-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "sample", dependencies: { fastify: "^5.0.0" } })
      );
      writeFileSync(
        join(dir, "src", "app.ts"),
        `import Fastify from "fastify";\n// @brain-rule BR-1\nexport class BillingService {}\nexport function validateInvoice() {}\napp.get("/v1/ping", async () => "ok");\n`
      );
      writeFileSync(join(dir, "schema.sql"), `CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY);`);

      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.equal(report.deterministic.confidence, 1.0);
      assert.equal(report.deterministic.isInferred, false);
      assert.ok(report.deterministic.languages.includes("typescript"));
      assert.ok(report.deterministic.frameworks.includes("fastify"));
      assert.ok(report.deterministic.routes.some((r) => r.name === "/v1/ping"));
      assert.ok(report.deterministic.sqlTables.includes("invoices"));

      // Should emit drafts for 00-overview/, 01-business/, and 03-architecture/
      assert.ok(report.inferredDrafts.length >= 4);
      for (const draft of report.inferredDrafts) {
        assert.equal(draft.status, "draft");
        assert.equal(draft.isInferred, true);
      }
      assert.ok(report.inferredDrafts.some((d) => d.domainId === 1 && d.sourceUri.startsWith(".brain/00-overview/")));
      assert.ok(report.inferredDrafts.some((d) => d.domainId === 2 && d.sourceUri.startsWith(".brain/01-business/")));
      assert.ok(report.inferredDrafts.some((d) => d.domainId === 3 && d.type === "api_contract"));
      assert.ok(report.inferredDrafts.some((d) => d.domainId === 3 && d.sourceUri === ".brain/03-architecture/db-schemas.md"));
      assert.ok(report.inferredDrafts.some((d) => d.domainId === 3 && d.type === "service"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gracefully returns empty git history when directory is not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-nogit-"));
    try {
      const history = analyzeGitHistory(dir);
      assert.deepEqual(history, {
        commits: [],
        hotspots: [],
        architecturalCommits: [],
        businessCommits: []
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects root and nested gitignore rules while keeping negated source files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-gitignore-"));
    try {
      mkdirSync(join(dir, "build-output"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "build-output/\n*.gen.ts\n!src/keep.gen.ts\n");
      writeFileSync(join(dir, "src/.gitignore"), "private-secret.ts\n");
      writeFileSync(join(dir, "build-output/ignored.ts"), "export function shouldNotSeeBuildOutput() {}\n");
      writeFileSync(join(dir, "src/ignored.gen.ts"), "export function shouldNotSeeIgnoredSource() {}\n");
      writeFileSync(join(dir, "src/keep.gen.ts"), "export function shouldSeeNegatedSource() {}\n");
      writeFileSync(join(dir, "src/private-secret.ts"), "export function shouldNotSeeNestedIgnore() {}\n");
      writeFileSync(join(dir, "src/normal.ts"), "export function shouldSeeNormalSource() {}\n");

      const symbols = (await runProjectAutodiscovery(dir, "t1", "p1")).deterministic.symbols.map((symbol) => symbol.name);
      assert.equal(symbols.includes("shouldNotSeeBuildOutput"), false);
      assert.equal(symbols.includes("shouldNotSeeIgnoredSource"), false);
      assert.equal(symbols.includes("shouldSeeNegatedSource"), true);
      assert.equal(symbols.includes("shouldNotSeeNestedIgnore"), false);
      assert.equal(symbols.includes("shouldSeeNormalSource"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses Tree-sitter to distinguish Python declarations from multiline strings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tree-sitter-python-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/billing.py"), [
        'description = """',
        "def fake_invoice():",
        "    return None",
        '"""',
        "",
        '@app.get("/v1/invoices")',
        "def calculate_invoice(total: float) -> float:",
        "    return total",
        ""
      ].join("\n"));
      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.deepEqual(report.deterministic.symbols.map((symbol) => symbol.name), ["calculate_invoice", "/v1/invoices"]);
      assert.equal(report.deterministic.routes[0]?.name, "/v1/invoices");
      assert.deepEqual(report.deterministic.treeSitter.activeLanguages, ["python"]);
      assert.deepEqual(report.deterministic.treeSitter.fallbackFiles, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads and applies bundled grammars for Go, Java, Python, and Rust", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tree-sitter-languages-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/invoice.py"), "def calculate_python():\n    return 1\n");
      writeFileSync(join(dir, "src/invoice.go"), "package billing\nfunc CalculateGo() int { return 1 }\n");
      writeFileSync(join(dir, "src/Invoice.java"), "class Invoice { void calculateJava() {} }\n");
      writeFileSync(join(dir, "src/invoice.rs"), "pub fn calculate_rust() -> i32 { 1 }\n");

      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.deepEqual(report.deterministic.treeSitter.activeLanguages, ["go", "java", "python", "rust"]);
      assert.deepEqual(report.deterministic.treeSitter.fallbackFiles, []);
      for (const name of ["CalculateGo", "calculateJava", "calculate_python", "calculate_rust"]) {
        assert.ok(report.deterministic.symbols.some((symbol) => symbol.name === name), `missing ${name}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers test and infrastructure files and excludes ignored paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-test-infra-discovery-"));
    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      mkdirSync(join(dir, "infra"), { recursive: true });
      mkdirSync(join(dir, "k8s"), { recursive: true });
      mkdirSync(join(dir, "generated/tests"), { recursive: true });
      writeFileSync(join(dir, ".gitignore"), "generated/\n");
      writeFileSync(join(dir, "tests/payments.spec.ts"), "test(\"pay\", () => {});\n");
      writeFileSync(join(dir, "tests/test_refund.py"), "def test_refund():\n    assert True\n");
      writeFileSync(join(dir, "src/billing_test.go"), "package billing\nfunc TestCharge() {}\n");
      writeFileSync(join(dir, "src/lib.rs"), "#[cfg(test)]\nmod tests { #[test] fn test_charge() {} }\n");
      writeFileSync(join(dir, "Dockerfile"), "FROM node:22\n");
      writeFileSync(join(dir, "docker-compose.yml"), "services: {}\n");
      writeFileSync(join(dir, ".github/workflows/ci.yml"), "name: CI\n");
      writeFileSync(join(dir, "infra/main.tf"), "resource \"x_y\" \"z\" {}\n");
      writeFileSync(join(dir, "k8s/deployment.yaml"), "kind: Deployment\n");
      writeFileSync(join(dir, "generated/tests/hidden.spec.ts"), "test(\"hidden\", () => {});\n");
      writeFileSync(join(dir, "generated/secret.tf"), "resource \"x_y\" \"z\" {}\n");

      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.deepEqual(report.deterministic.testFiles, [
        "src/billing_test.go", "src/lib.rs", "tests/payments.spec.ts", "tests/test_refund.py"
      ]);
      assert.deepEqual(report.deterministic.infrastructureFiles, [
        ".github/workflows/ci.yml", "Dockerfile", "docker-compose.yml", "infra/main.tf", "k8s/deployment.yaml"
      ]);
      const draft = report.inferredDrafts.find((item) => item.sourceUri === ".brain/05-code/test-and-infrastructure-map.md");
      assert.ok(draft);
      assert.equal(draft.isInferred, true);
      assert.match(draft.content, /tests\/payments\.spec\.ts/);
      assert.match(draft.content, /\.github\/workflows\/ci\.yml/);
      assert.doesNotMatch(draft.content, /hidden\.spec\.ts|secret\.tf/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the deterministic extractor when a Tree-sitter grammar cannot load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tree-sitter-fallback-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/billing.py"), "def calculate_invoice(total):\n    return total\n");
      const result = await discoverDeterministic(dir, {
        treeSitterLoader: async () => { throw new Error("synthetic grammar load failure"); }
      });
      assert.deepEqual(result.treeSitter.activeLanguages, []);
      assert.deepEqual(result.treeSitter.fallbackFiles, ["src/billing.py"]);
      assert.ok(result.symbols.some((symbol) => symbol.name === "calculate_invoice"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the deterministic extractor when Tree-sitter reports syntax errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tree-sitter-parse-error-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/broken.py"), "def broken_invoice(:\n    return 1\n");
      const result = await discoverDeterministic(dir);
      assert.deepEqual(result.treeSitter.activeLanguages, ["python"]);
      assert.deepEqual(result.treeSitter.fallbackFiles, ["src/broken.py"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disposes Tree-sitter parser instances after discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-tree-sitter-dispose-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/billing.py"), "def calculate_invoice():\n    return 1\n");
      const parser = await initBundledTreeSitterLanguage("python");
      const originalDelete = parser.delete.bind(parser);
      let deleteCalls = 0;
      parser.delete = () => { deleteCalls++; originalDelete(); };

      await discoverDeterministic(dir, { treeSitterLoader: async () => parser });
      assert.equal(deleteCalls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not read a symlinked gitignore outside the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-gitignore-link-"));
    const outside = mkdtempSync(join(tmpdir(), "brain-gitignore-outside-"));
    try {
      writeFileSync(join(outside, ".gitignore"), "*.ts\n");
      symlinkSync(join(outside, ".gitignore"), join(dir, ".gitignore"));
      writeFileSync(join(dir, "inside.ts"), "export function projectSource() {}\n");
      const symbols = (await runProjectAutodiscovery(dir, "t1", "p1")).deterministic.symbols;
      assert.ok(symbols.some((symbol) => symbol.name === "projectSource"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("loads real SCIP definitions and references from the repository index", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-scip-discovery-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/billing.ts"), "export function charge() {}\n");
      mkdirSync(join(dir, ".scip"), { recursive: true });
      const index = create(IndexSchema, {
        metadata: { projectRoot: `file://${dir}`, toolInfo: { name: "scip-typescript", version: "0.5.2", arguments: [] } },
        documents: [{
          relativePath: "src/billing.ts", language: "typescript", occurrences: [
            { symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/charge().", range: [0, 16, 22], symbolRoles: 1 },
            { symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/charge().", range: [1, 0, 6], symbolRoles: 8 }
          ],
          symbols: [{
            symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/charge().",
            displayName: "charge",
            kind: 17,
            documentation: ["Charges an invoice."],
            enclosingSymbol: "",
            relationships: [{
              symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/Payment#",
              isReference: false,
              isImplementation: true,
              isTypeDefinition: false,
              isDefinition: false
            }]
          }]
        }]
      });
      writeFileSync(join(dir, ".scip/index.scip"), toBinary(IndexSchema, index));

      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.equal(report.deterministic.scip.state, "available");
      assert.equal(report.deterministic.scip.toolInfo, "scip-typescript 0.5.2");
      assert.deepEqual(report.deterministic.scip.documents[0]?.occurrences.map((occurrence) => occurrence.role), ["definition", "reference"]);
      const codeDraft = report.inferredDrafts.find((draft) => draft.sourceUri === ".brain/05-code/scip-symbol-map.md");
      assert.ok(codeDraft);
      assert.equal(codeDraft.status, "draft");
      assert.equal(codeDraft.isInferred, true);
      assert.match(codeDraft.content, /definition.*src\/billing\.ts/);
      assert.match(codeDraft.content, /reference.*src\/billing\.ts/);
      assert.match(codeDraft.content, /charge/);
      assert.match(codeDraft.content, /IMPLEMENTS.*Payment/);
      assert.match(codeDraft.content, /Charges an invoice/);
      assert.equal((codeDraft.metadata as Record<string, unknown>).scipRelationshipCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps deterministic discovery when SCIP is missing or invalid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-scip-fallback-"));
    try {
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/app.ts"), "export function calculateInvoice() {}\n");
      const missing = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.equal(missing.deterministic.scip.state, "not_found");
      assert.ok(missing.deterministic.symbols.some((symbol) => symbol.name === "calculateInvoice"));

      writeFileSync(join(dir, "index.scip"), Buffer.from([255]));
      const invalid = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.equal(invalid.deterministic.scip.state, "invalid");
      assert.ok(invalid.deterministic.scip.error);
      assert.ok(invalid.deterministic.symbols.some((symbol) => symbol.name === "calculateInvoice"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not follow symlinks outside the project during autodiscovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-symlink-root-"));
    const outside = mkdtempSync(join(tmpdir(), "brain-symlink-outside-"));
    try {
      writeFileSync(join(outside, "private.ts"), "export function outsideSecret() {}\n");
      symlinkSync(outside, join(dir, "external"), "dir");
      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.equal(report.deterministic.symbols.some((symbol) => symbol.name === "outsideSecret"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a SCIP index symlink that points outside the project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-scip-link-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "brain-scip-outside-"));
    try {
      const outsideIndex = join(outsideDir, "index.scip");
      writeFileSync(outsideIndex, JSON.stringify({ metadata: { toolInfo: "external", projectRoot: "" }, documents: [] }));
      symlinkSync(outsideIndex, join(dir, "index.scip"));
      const result = (await runProjectAutodiscovery(dir)).deterministic.scip;
      assert.equal(result.state, "invalid");
      assert.match(result.error ?? "", /symlink não permitido/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("analyzes git history hotspots and architectural/business commits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brain-git-"));
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Brain Bot",
            GIT_AUTHOR_EMAIL: "bot@brain.local",
            GIT_COMMITTER_NAME: "Brain Bot",
            GIT_COMMITTER_EMAIL: "bot@brain.local"
          }
        });

      git(["init"]);
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src", "billing.ts"), "export function calc() { return 1; }\n");
      git(["add", "."]);
      git(["commit", "-m", "feat: initial billing rule"]);

      writeFileSync(join(dir, "src", "billing.ts"), "export function calc() { return 2; }\n");
      writeFileSync(join(dir, "src", "gateway.ts"), "export class ApiGateway {}\n");
      git(["add", "."]);
      git(["commit", "-m", "arch: add api gateway service"]);

      const report = await runProjectAutodiscovery(dir, "t1", "p1");
      assert.equal(report.gitHistory.commits.length, 2);
      assert.equal(report.gitHistory.hotspots[0]?.filePath, "src/billing.ts");
      assert.equal(report.gitHistory.hotspots[0]?.changes, 2);
      assert.equal(report.gitHistory.architecturalCommits.length, 1);
      assert.equal(report.gitHistory.businessCommits.length, 1);

      const archDraft = report.inferredDrafts.find((d) => d.sourceUri === ".brain/03-architecture/services-and-hotspots.md");
      assert.ok(archDraft);
      assert.ok(archDraft.content.includes("src/billing.ts (2 alterações)"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
