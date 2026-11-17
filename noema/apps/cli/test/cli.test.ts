import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCliAuthToken,
  runDoctor,
  runHandoffCreate,
  runHookEmit,
  runHookInstall,
  runInit,
  runInitWithScip,
  runRunnerUp,
  runScaffold,
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


