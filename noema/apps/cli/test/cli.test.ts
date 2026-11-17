import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { EdgeDatabase, decryptEdgeSecret, encryptEdgeSecret } from "../src/edge-db.js";
import { startEdgeRunner, waitForRunnerShutdown } from "../src/local-runner.js";
import {
  enforceOfflineLeaseIfStored,
  resolveCliAuthToken,
  runDoctor,
  runHandoffCreate,
  runHookEmit,
  runHookInstall,
  runInit,
  runInitWithScip,
  runLocalTaskEnqueue,
  runLocalTaskList,
  runRunnerUp,
  runScaffold,
  runSyncPull,
  runSyncPush,
  runValidate,
  selectRunnerProfile
} from "../src/commands.js";

test("noema init and doctor work on existing repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-init-"));
  try {
    writeFileSync(join(dir, ".env.example"), "PORT=3000\nSECRET_MISSING=1\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/billing.ts"), "// @brain-rule BR-001\nexport function validateInvoice() {}\napp.get(\"/invoices\", () => {});\n");
    writeFileSync(join(dir, "schema.sql"), "CREATE TABLE invoices (id TEXT);\n");
    const initRes = await runInit(dir, "demo-proj");
    assert.equal(initRes.projectId, "demo-proj");
    assert.ok(existsSync(join(dir, ".brain/00-overview/vision.md")));
    assert.ok(existsSync(join(dir, ".brain/00-overview/project-summary.md")));
    assert.ok(existsSync(join(dir, ".brain/01-business/inferred-rules.md")));
    assert.ok(existsSync(join(dir, ".brain/03-architecture/api-surface.md")));
    assert.ok(existsSync(join(dir, ".brain/03-architecture/db-schemas.md")));
    assert.ok(initRes.autodiscovery.symbolCount > 0);
    assert.ok(initRes.draftsCreated.length > 0);

    const doc = runDoctor(dir, { PORT: "3000" });
    assert.deepEqual(doc.missingEnvVars, ["SECRET_MISSING"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain init applies Tree-sitter symbol extraction to Python drafts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-init-tree-sitter-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/billing.py"), [
      'description = """',
      "def fake_invoice():",
      "    return None",
      '"""',
      "",
      "def calculate_invoice(total: float) -> float:",
      "    return total",
      ""
    ].join("\n"));
    const result = await runInit(dir, "tree-sitter-demo");
    assert.equal(result.autodiscovery.symbolCount, 1);
    assert.deepEqual(result.autodiscovery.treeSitter.activeLanguages, ["python"]);
    assert.deepEqual(result.autodiscovery.treeSitter.fallbackFiles, []);
    const businessDraft = readFileSync(join(dir, ".brain/01-business/inferred-rules.md"), "utf8");
    assert.match(businessDraft, /calculate_invoice/);
    assert.doesNotMatch(businessDraft, /fake_invoice/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain init reports test and infrastructure discovery in its output and draft", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-init-test-infra-"));
  try {
    mkdirSync(join(dir, "tests"), { recursive: true });
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, "tests/payment.spec.ts"), "test(\"payment\", () => {});\n");
    writeFileSync(join(dir, "Dockerfile"), "FROM node:22\n");
    writeFileSync(join(dir, ".github/workflows/ci.yml"), "name: CI\n");
    const result = await runInit(dir, "test-infra-demo");
    assert.equal(result.autodiscovery.testFileCount, 1);
    assert.equal(result.autodiscovery.infrastructureFileCount, 2);
    assert.ok(existsSync(join(dir, ".brain/05-code/test-and-infrastructure-map.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain init never overwrites generated or user-edited project files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-init-preserve-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo" }));
    await runInit(dir, "demo");
    const draftPath = join(dir, ".brain/00-overview/project-summary.md");
    writeFileSync(draftPath, "# Human edit\n", "utf8");
    writeFileSync(join(dir, ".project-brain.json"), "{\"projectId\":\"human-edit\"}\n", "utf8");
    const second = await runInit(dir, "demo");
    assert.equal(readFileSync(draftPath, "utf8"), "# Human edit\n");
    assert.equal(readFileSync(join(dir, ".project-brain.json"), "utf8"), "{\"projectId\":\"human-edit\"}\n");
    assert.ok(second.draftsSkipped.includes(".brain/00-overview/project-summary.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("brain init --scip runs the available language indexer before materializing drafts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-init-scip-"));
  let indexedLanguage = "";
  try {
    writeFileSync(join(dir, "pyproject.toml"), "[project]\nname='demo'\n");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/main.py"), "def calculate_invoice():\n    return 1\n");
    const result = await runInitWithScip(dir, "demo", async (root, language) => {
      indexedLanguage = language;
      writeFileSync(join(root, "index.scip"), "{\"metadata\":{\"toolInfo\":\"scip-python 1\",\"projectRoot\":\"file:///demo\"},\"documents\":[{\"relativePath\":\"src/main.py\",\"language\":\"python\",\"occurrences\":[{\"symbol\":\"scip-python python demo 1 `src.main`/calculate_invoice().\",\"range\":[0,4,22],\"role\":\"definition\"}]}]}", "utf8");
      return { command: "scip-python", outputFile: join(root, "index.scip") };
    });
    assert.equal(indexedLanguage, "python");
    assert.equal(result.autodiscovery.scipState, "available");
    assert.ok(existsSync(join(dir, ".brain/05-code/scip-symbol-map.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noema scaffold creates compliant microservice structure", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-scaffold-"));
  try {
    runScaffold(join(dir, "billing"), "billing");
    assert.ok(existsSync(join(dir, "billing/.project-brain.json")));
    assert.ok(existsSync(join(dir, "billing/src/index.ts")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noema scaffold captures guided blueprint choices and applies security defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-blueprint-"));
  try {
    runScaffold(dir, "payments-api", {
      objective: "Process subscription payments",
      domain: "billing",
      criticality: "critical",
      stack: "node-ts",
      communication: "events",
      handlesPii: true,
      handlesPayments: true
    });
    const manifest = JSON.parse(readFileSync(join(dir, ".project-brain.json"), "utf8"));
    assert.equal(manifest.projectId, "payments-api");
    assert.equal(manifest.guardianMode, "advisory");
    assert.equal(manifest.accessPolicyId, "restricted-security");
    assert.equal(manifest.blueprint.domain, "billing");
    assert.equal(manifest.blueprint.criticality, "critical");
    assert.equal(manifest.blueprint.handlesPii, true);
    assert.equal(manifest.blueprint.handlesPayments, true);
    assert.equal(existsSync(join(dir, ".brain/03-architecture/decisions/ADR-001.md")), true);
    assert.equal(existsSync(join(dir, ".brain/04-engineering/security-standards.md")), true);
    assert.equal(existsSync(join(dir, "src/index.ts")), true);
    const rule = readFileSync(join(dir, ".brain/01-business/business-rules/BR-001.yaml"), "utf8");
    assert.match(rule, /pagamento/);
    assert.match(rule, /draft/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("noema scaffold creates Python starter files and rejects an empty project name", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-python-blueprint-"));
  try {
    runScaffold(dir, "catalog", { stack: "python" });
    assert.ok(existsSync(join(dir, "src/main.py")));
    assert.ok(existsSync(join(dir, "pyproject.toml")));
    assert.equal(existsSync(join(dir, "src/index.ts")), false);
    assert.throws(() => runScaffold(join(dir, "invalid"), "!!!"), /letras ou números/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("EdgeDatabase indexes FTS5 and revokes policies locally", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-edge-"));
  try {
    const db = new EdgeDatabase(join(dir, "edge.db"));
    db.upsertItem({
      id: "BR-1",
      projectId: "sub",
      title: "Cancelamento",
      content: "Regra de cancelamento de assinatura",
      accessPolicyId: "confidential-business",
      contentHash: "h1"
    });
    db.upsertItem({ id: "BR-2", projectId: "sub", title: "Outro", content: "Conteúdo restante", accessPolicyId: "public-org", contentHash: "h2" });
    db.upsertEdge("BR-1", "BR-2", "RELATED_TO");
    assert.equal(db.searchFts("cancelamento").length, 1);
    const removed = db.revokePolicies(["confidential-business"]);
    assert.equal(removed, 1);
    assert.equal(db.searchFts("cancelamento").length, 0);
    assert.equal(db.getRelatedItems("BR-1").length, 0, "policy revocation must remove graph relations touching revoked content");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runner up auto-selects hardware profile and only pulls Ollama model when pull=true", async () => {
  assert.equal(selectRunnerProfile(8 * 1024 ** 3).profile, "lite");
  assert.equal(selectRunnerProfile(16 * 1024 ** 3).profile, "standard");

  const resNoPull = await runRunnerUp({ local: true }, async () => {
    return new Response(JSON.stringify({ models: [] }), { status: 200 });
  });
  assert.equal("pulled" in resNoPull && resNoPull.pulled, false);
  assert.equal(resNoPull.status, "model_missing_use_--pull");

  let pulledModel = "";
  const res = await runRunnerUp({ local: true, pull: true }, async (url, init) => {
    if (String(url).endsWith("/api/tags")) {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    }
    pulledModel = JSON.parse(String(init?.body)).name;
    return new Response(JSON.stringify({ status: "success" }), { status: 200 });
  });
  assert.equal("pulled" in res && res.pulled, true);
  assert.ok(pulledModel.length > 0);
});

test("EdgeDatabase encrypts secrets with AES-256-GCM and syncs via HTTP", async () => {
  const enc = encryptEdgeSecret("tok_123", "master-pass");
  assert.equal(decryptEdgeSecret(enc, "master-pass"), "tok_123");

  const dir = mkdtempSync(join(tmpdir(), "noema-sync-"));
  try {
    const db = new EdgeDatabase(join(dir, "edge.db"));
    db.stageDraft("D-1", "Rascunho", "Texto");
    db.upsertItem({ id: "OLD-1", projectId: "sub", title: "Revogado", content: "Segredo", accessPolicyId: "confidential-business", contentHash: "h-old" });
    db.upsertItem({ id: "OLD-2", projectId: "sub", title: "Removido", content: "Obsoleto", accessPolicyId: "internal-project", contentHash: "h-old-2" });
    db.setSyncCursor(4, 1);
    let pullBody: Record<string, unknown> = {};

    const pullRes = await runSyncPull(
      { hubUrl: "http://localhost:3333", apiKey: "k", projectId: "sub", db },
      async (_url, init) => {
        pullBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            syncMode: "delta",
            syncSeq: 5,
            policyEpoch: 1,
            revokedPolicies: ["confidential-business"],
            tombstones: ["OLD-2"],
            items: [{ id: "BR-9", projectId: "sub", title: "Regra", content: "Ok", accessPolicyId: "internal-project", contentHash: "h9" }]
          }),
          { status: 200 }
        );
      }
    );
    assert.equal(pullRes.upserted, 1);
    assert.equal(pullRes.syncMode, "delta");
    assert.equal(pullBody.sinceSeq, 4);
    assert.equal(pullBody.policyEpoch, 1);
    assert.deepEqual(pullBody.knownPolicies, ["confidential-business", "internal-project"]);
    assert.equal(pullRes.revokedCount, 1);
    assert.deepEqual(db.searchFts("segredo"), []);
    assert.deepEqual(db.searchFts("obsoleto"), [], "delta tombstone removes a previously synced item");
    assert.equal(db.searchFts("regra")[0]?.id, "BR-9", "delta upserts the latest authorized item version");

    const pushRes = await runSyncPush(
      { hubUrl: "http://localhost:3333", apiKey: "k", projectId: "sub", db },
      async () => new Response(JSON.stringify({ acceptedCount: 1 }), { status: 200 })
    );
    assert.equal(pushRes.pushed, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync pull follows every snapshot page and atomically replaces the local snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-sync-pages-"));
  try {
    const db = new EdgeDatabase(join(dir, "edge.db"));
    db.upsertItem({ id: "STALE-1", projectId: "sub", title: "Stale", content: "Must be removed", accessPolicyId: "internal-project", contentHash: "old" });
    db.setSyncCursor(12, 1);
    const requests: Array<Record<string, unknown>> = [];
    let call = 0;
    const result = await runSyncPull(
      { hubUrl: "http://localhost:3333", apiKey: "k", projectId: "sub", db },
      async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (call > 0) assert.equal(db.searchFts("must")[0]?.id, "STALE-1", "the live Edge stays intact until every snapshot page is received");
        call += 1;
        const page = call === 1
          ? { id: "A-1", title: "Discarded page", content: "discarded page" }
          : call === 2
            ? { id: "C-1", title: "Restart page one", content: "restart first page" }
            : { id: "B-1", title: "Restart page two", content: "restart second page" };
        return new Response(JSON.stringify({
          syncMode: "snapshot",
          syncSeq: call === 2 || call === 3 ? 21 : 20,
          snapshotSeq: call === 2 || call === 3 ? 21 : 20,
          snapshotCursor: call === 1 ? "A-1" : call === 2 ? "C-1" : null,
          snapshotDone: call === 3,
          snapshotRestarted: call === 2,
          policyEpoch: call === 1 ? 2 : 3,
          revokedPolicies: [],
          tombstones: [],
          items: [{ ...page, projectId: "sub", accessPolicyId: "internal-project", contentHash: `hash-${call}` }]
        }), { status: 200 });
      }
    );
    assert.equal(call, 3);
    assert.equal(requests[1]?.snapshotCursor, "A-1");
    assert.equal(requests[2]?.snapshotCursor, "C-1");
    assert.equal(requests[2]?.policyEpoch, 3);
    assert.equal(result.upserted, 2);
    assert.deepEqual(db.getSyncCursor(), { syncSeq: 21, policyEpoch: 3 });
    assert.deepEqual(db.searchFts("must"), [], "atomic snapshot replacement discards rows absent from the Hub snapshot");
    assert.deepEqual(db.searchFts("discarded"), [], "a prior epoch page is discarded when the Hub restarts the snapshot");
    assert.equal(db.searchFts("restart")[0]?.id, "C-1");
    assert.equal(db.searchFts("second")[0]?.id, "B-1");
    assert.equal(readdirSync(dir).some((name) => name.includes(".rebuild.")), false, "completed snapshot removes temporary databases");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforceOfflineLeaseIfStored rejects expired offline lease in sync operations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-lease-"));
  try {
    const db = new EdgeDatabase(join(dir, "edge.db"));
    enforceOfflineLeaseIfStored(db); // no lease stored yet -> allowed

    db.issueOfflineLease("actor-1", "tenant-1", 1000);
    const future = new Date(Date.now() + 60_000);
    assert.throws(() => enforceOfflineLeaseIfStored(db, future), /Offline lease expirado/);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runValidate evaluates local architecture and business rule compliance", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-validate-"));
  try {
    runScaffold(dir, "billing");
    writeFileSync(
      join(dir, ".project-brain.json"),
      JSON.stringify({ guardianMode: "advisory", projectId: "billing", tenantId: "default-org", knowledgeRoot: ".brain/" })
    );
    const okRes = runValidate(dir);
    assert.equal(okRes.passed, true);

    mkdirSync(join(dir, "packages/core"), { recursive: true });
    writeFileSync(
      join(dir, "packages/core/package.json"),
      JSON.stringify({ name: "@noema/core" })
    );
    writeFileSync(
      join(dir, "packages/core/bad.ts"),
      `import { x } from "@noema/api";\nexport const v = x;\n`
    );
    writeFileSync(
      join(dir, ".project-brain.json"),
      JSON.stringify({ guardianMode: "enforced", projectId: "billing", tenantId: "default-org", knowledgeRoot: ".brain/" })
    );
    const failRes = runValidate(dir);
    assert.equal(failRes.passed, false);
    assert.ok(failRes.architecture.violations.some((v) => v.ruleId === "ARCH-LAYER-VIOLATION"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRunnerUp supports --provider (ollama, fm, openai, anthropic) and --hybrid flags", async () => {
  const prevOpenAi = process.env.OPENAI_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(() => runRunnerUp({ provider: "anthropic" }), /ANTHROPIC_API_KEY/i);
    await assert.rejects(() => runRunnerUp({ hybrid: true }), /OPENAI_API_KEY/i);

    process.env.OPENAI_API_KEY = "sk-test-key";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";

    const openai = await runRunnerUp({ provider: "openai" });
    assert.equal(openai.mode, "cloud");
    assert.equal(openai.provider, "openai");
    assert.equal(openai.status, "ready");

    const anthropic = await runRunnerUp({ provider: "anthropic" });
    assert.equal(anthropic.mode, "cloud");
    assert.equal(anthropic.provider, "anthropic");
    assert.equal(anthropic.status, "ready");

    const hybridFallback = await runRunnerUp({ hybrid: true, cloudProvider: "openai" }, async () =>
      new Response("down", { status: 503 })
    );
    assert.equal(hybridFallback.mode, "hybrid");
    assert.equal(hybridFallback.status, "cloud_fallback_ready");
    assert.equal("cloudProvider" in hybridFallback ? hybridFallback.cloudProvider : undefined, "openai");

    const ollama = await runRunnerUp({ provider: "ollama" }, async () =>
      new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b" }] }), { status: 200 })
    );
    assert.equal(ollama.mode, "local");
    assert.equal(ollama.status, "ready");

    const fm = await runRunnerUp({
      provider: "fm",
      appleFmCheck: async () => ({ available: true, macOsVersion: "27.0.1", model: "apple-foundation-model:macos-27.0.1" })
    });
    assert.equal(fm.mode, "local");
    assert.equal(fm.provider, "apple-fm");
    assert.equal(fm.status, "ready");
  } finally {
    if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAi;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  }
});

test("local task commands validate input and list persisted tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-local-task-cli-"));
  const db = new EdgeDatabase(join(dir, "edge.db"));
  try {
    assert.throws(() => runLocalTaskEnqueue(db, "sub", "  "), /instrução/i);
    const queued = runLocalTaskEnqueue(db, "sub", "  Summarize local changes  ");
    assert.equal(queued.instruction, "Summarize local changes");
    assert.deepEqual(runLocalTaskList(db, "sub").map(({ taskId, status }) => ({ taskId, status })), [
      { taskId: queued.taskId, status: "queued" }
    ]);
    assert.deepEqual(runLocalTaskList(db, "another-project"), []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local Edge Runner claims a task and persists its draft result and model usage", { timeout: 3000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-local-runner-"));
  const db = new EdgeDatabase(join(dir, "edge.db"));
  try {
    const task = db.enqueueRunnerTask("sub", "Summarize the synthetic project");
    const unrelated = db.enqueueRunnerTask("other-project", "Do not run in this workspace");
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const runner = startEdgeRunner(db, {
      projectId: "sub",
      pollIntervalMs: 10,
      executeTask: async (claimed) => ({
        ...claimed,
        status: "completed",
        resultSummary: "[bot-draft] Three modules and one open risk.",
        modelUsage: {
          provider: "test", model: "fixed-fixture", inputTokens: 15, outputTokens: 9,
          totalTokens: 24, durationMs: 4, providerCostUsd: 0, costBasis: "self_hosted_no_api_fee"
        }
      }),
      onTaskComplete: () => resolveCompleted()
    });
    await completed;
    await runner.stop();

    const stored = db.listRunnerTasks("sub").find((row) => row.taskId === task.taskId);
    assert.equal(stored?.status, "completed");
    assert.equal(stored?.resultSummary, "[bot-draft] Three modules and one open risk.");
    assert.deepEqual(stored?.modelUsage, {
      provider: "test", model: "fixed-fixture", inputTokens: 15, outputTokens: 9,
      totalTokens: 24, durationMs: 4, providerCostUsd: 0, costBasis: "self_hosted_no_api_fee"
    });
    assert.equal(db.listRunnerTasks("other-project").find((row) => row.taskId === unrelated.taskId)?.status, "queued");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local Edge Runner marks a rejected task failed and continues with the next queued task", { timeout: 3000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-local-runner-failure-"));
  const db = new EdgeDatabase(join(dir, "edge.db"));
  try {
    const failedTask = db.enqueueRunnerTask("sub", "Synthetic task that fails");
    const nextTask = db.enqueueRunnerTask("sub", "Synthetic task that succeeds");
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const runner = startEdgeRunner(db, {
      pollIntervalMs: 10,
      executeTask: async (claimed) => {
        if (claimed.taskId === failedTask.taskId) throw new Error("synthetic model error");
        return { ...claimed, status: "completed", resultSummary: "[bot-draft] Recovery worked." };
      },
      onTaskComplete: (task) => { if (task.taskId === nextTask.taskId) resolveCompleted(); }
    });
    await completed;
    await runner.stop();

    const stored = db.listRunnerTasks("sub");
    assert.equal(stored.find((row) => row.taskId === failedTask.taskId)?.status, "failed");
    assert.match(stored.find((row) => row.taskId === failedTask.taskId)?.resultSummary ?? "", /synthetic model error/);
    assert.equal(stored.find((row) => row.taskId === nextTask.taskId)?.status, "completed");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local Edge Runner persists destructive instructions as escalated without invoking the executor", { timeout: 3000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-local-runner-escalation-"));
  const db = new EdgeDatabase(join(dir, "edge.db"));
  try {
    const task = db.enqueueRunnerTask("sub", "Execute rm -rf /");
    let resolveCompleted!: () => void;
    const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
    const runner = startEdgeRunner(db, {
      projectId: "sub",
      pollIntervalMs: 10,
      executeTask: async () => { throw new Error("destructive task reached model executor"); },
      onTaskComplete: () => resolveCompleted()
    });
    await completed;
    await runner.stop();
    const stored = db.listRunnerTasks("sub").find((row) => row.taskId === task.taskId);
    assert.equal(stored?.status, "escalated");
    assert.match(stored?.resultSummary ?? "", /comando destrutivo/i);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local Runner shutdown stops polling on SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-local-runner-stop-"));
  const db = new EdgeDatabase(join(dir, "edge.db"));
  const signals = new EventEmitter();
  try {
    const runner = startEdgeRunner(db, { pollIntervalMs: 50, executeTask: async (task) => task });
    const stopped = waitForRunnerShutdown(runner, signals);
    signals.emit("SIGTERM");
    await stopped;
    assert.equal(runner.isRunning(), false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveCliAuthToken prefers OIDC client credentials before falling back to NOEMA_LOCAL_API_KEY", async () => {
  const oidcToken = await resolveCliAuthToken(
    {
      OIDC_TOKEN_URL: "https://idp.example/token",
      OIDC_CLIENT_ID: "cli-client",
      OIDC_CLIENT_SECRET: "secret",
      NOEMA_LOCAL_API_KEY: "fallback-key"
    },
    async () => new Response(JSON.stringify({ access_token: "oidc-jwt-123" }), { status: 200 })
  );
  assert.equal(oidcToken, "oidc-jwt-123");

  const fallbackToken = await resolveCliAuthToken({ NOEMA_LOCAL_API_KEY: "fallback-key" });
  assert.equal(fallbackToken, "fallback-key");
});

test("runHandoffCreate uses createHandoffWithSync when dirty/patch options are provided", async () => {
  let postedBody: Record<string, unknown> | undefined;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
  try {
    const res = await runHandoffCreate(
      {
        hubUrl: "http://localhost:3333",
        apiKey: "k",
        projectId: "billing",
        taskId: "TASK-99",
        repoDir: process.cwd(),
        repoUrl: "https://example/repo.git",
        branch: "feat/test",
        baseCommitSha: "deadbeef",
        modifiedFiles: ["src/index.ts"],
        nextSteps: ["run tests"],
        workingTreeDirty: true,
        patchContent: "diff --git a/src/index.ts b/src/index.ts",
        minioEndpoint: "http://minio.local:9000",
        patchSecret: "secret-pass"
      },
      async (_url, init) => {
        postedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
    );
    assert.equal(res.status, 201);
    assert.ok(typeof postedBody?.handoffId === "string");
    assert.ok(String(postedBody?.patchRef ?? "").startsWith("http://minio.local:9000/"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("runScaffold generates CI Guardians workflow and applies ADR precedents", () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-scaffold-test-"));
  try {
    const res = runScaffold(join(dir, "pay-service"), "pay-service", {
      domain: "payments",
      objective: "Processar pagamentos",
      stack: "node-ts",
      handlesPayments: true,
      appliedAdrs: [{ id: "ADR-007", title: "Idempotência em pagamentos", sourceProjectId: "core" }]
    });
    assert.equal(res.accessPolicyId, "restricted-security");
    assert.equal(res.appliedAdrCount, 1);
    assert.equal(res.ciGuardians, true);
    const workflow = readFileSync(join(dir, "pay-service/.github/workflows/noema-guardians.yml"), "utf8");
    assert.match(workflow, /noema validate/);
    const precedents = readFileSync(join(dir, "pay-service/.brain/03-architecture/decisions/ADR-PRECEDENTS.md"), "utf8");
    assert.match(precedents, /ADR-007/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runHookInstall and runHookEmit install lifecycle scripts and emit events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-hooks-test-"));
  try {
    const installed = runHookInstall(dir, { harness: "claude-code", projectId: "billing" });
    assert.equal(installed.installed, true);
    const cfg = JSON.parse(readFileSync(join(dir, ".noema/hooks.json"), "utf8")) as { projectId: string; harness: string };
    assert.equal(cfg.projectId, "billing");
    assert.equal(cfg.harness, "claude-code");

    let calledUrl = "";
    const emitted = await runHookEmit(
      {
        hubUrl: "http://localhost:3333",
        apiKey: "k",
        projectId: "billing",
        harness: "claude-code",
        event: "session_end",
        sessionId: "s-1",
        summary: "Done"
      },
      async (url) => {
        calledUrl = String(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    );
    assert.equal(emitted.status, 200);
    assert.equal(calledUrl, "http://localhost:3333/v1/projects/billing/hooks/lifecycle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSyncPush blocks staged drafts containing secrets locally before upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "noema-sync-push-secret-"));
  const prevDisable = process.env.NOEMA_DISABLE_GITLEAKS;
  process.env.NOEMA_DISABLE_GITLEAKS = "1";
  try {
    const db = new EdgeDatabase(join(dir, "edge.db"));
    db.stageDraft(
      "DRAFT-SEC-1",
      "Config note",
      "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for access"
    );
    let fetchCalled = false;
    await assert.rejects(
      () => runSyncPush(
        { hubUrl: "http://localhost:3333", apiKey: "k", projectId: "billing", db },
        async () => {
          fetchCalled = true;
          return new Response(JSON.stringify({ acceptedCount: 1 }), { status: 200 });
        }
      ),
      /secret-scan|Gitleaks/i
    );
    assert.equal(fetchCalled, false);
    db.close();
  } finally {
    if (prevDisable === undefined) delete process.env.NOEMA_DISABLE_GITLEAKS;
    else process.env.NOEMA_DISABLE_GITLEAKS = prevDisable;
    rmSync(dir, { recursive: true, force: true });
  }
});
