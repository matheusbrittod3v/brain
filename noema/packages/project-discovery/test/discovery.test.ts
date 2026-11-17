import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeGitHistory, runProjectAutodiscovery } from "../src/index.js";

describe("project-discovery", () => {
  it("separates deterministic discovery (1.0) from multi-domain inferred drafts", () => {
    const dir = mkdtempSync(join(tmpdir(), "noema-disc-"));
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

      const report = runProjectAutodiscovery(dir, "t1", "p1");
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
    const dir = mkdtempSync(join(tmpdir(), "noema-nogit-"));
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

  it("analyzes git history hotspots and architectural/business commits", () => {
    const dir = mkdtempSync(join(tmpdir(), "noema-git-"));
    try {
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Noema Bot",
            GIT_AUTHOR_EMAIL: "bot@noema.local",
            GIT_COMMITTER_NAME: "Noema Bot",
            GIT_COMMITTER_EMAIL: "bot@noema.local"
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

      const report = runProjectAutodiscovery(dir, "t1", "p1");
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
