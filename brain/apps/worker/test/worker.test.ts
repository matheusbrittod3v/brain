import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchOllamaEmbedding, probeOllamaEmbeddingProvider, processEmbedJob, processGitIngestJob, createWorkerShutdown, type GitIngestOptions } from "../src/index.js";

test("probeOllamaEmbeddingProvider recognizes the configured embedding model", async () => {
  const result = await probeOllamaEmbeddingProvider(
    "bge-m3",
    "http://ollama.local:11434/",
    async (input) => {
      assert.equal(String(input), "http://ollama.local:11434/api/tags");
      return new Response(JSON.stringify({ models: [{ name: "llama3:latest" }, { name: "bge-m3:latest" }] }));
    }
  );
  assert.deepEqual(result, { available: true });
});

test("probeOllamaEmbeddingProvider reports missing models and unreachable providers without throwing", async () => {
  const missing = await probeOllamaEmbeddingProvider(
    "bge-m3",
    "http://ollama.local:11434",
    async () => new Response(JSON.stringify({ models: [{ name: "llama3:latest" }] }))
  );
  const offline = await probeOllamaEmbeddingProvider(
    "bge-m3",
    "http://127.0.0.1:1",
    async () => { throw new TypeError("fetch failed"); }
  );
  assert.deepEqual(missing, { available: false, reason: "model_missing" });
  assert.deepEqual(offline, { available: false, reason: "provider_unreachable" });
});

test("fetchOllamaEmbedding uses the configured Ollama embed API, model, and endpoint", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const embedding = await fetchOllamaEmbedding("semantic input", "bge-m3-test", "http://ollama.local:11435/", async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ model: "bge-m3-test", embeddings: [[0.2, 0.4, 0.8]], prompt_eval_count: 2 }));
  });
  assert.equal(requestUrl, "http://ollama.local:11435/api/embed");
  assert.deepEqual(requestBody, { model: "bge-m3-test", input: "semantic input" });
  assert.deepEqual(embedding, [0.2, 0.4, 0.8]);
});

test("chunks content and stores embeddings per chunk", async () => {
  const saved: Array<{ chunkIndex: number; dims: number }> = [];
  const fakeRepo = {
    async getEmbeddingSource() {
      return { content: "# Título\n\n## Seção 1\nRegra A\n\n## Seção 2\nRegra B", accessPolicyId: "internal-project" };
    },
    async upsertEmbedding(_ctx: unknown, input: { chunkIndex: number; embedding: number[] }) {
      saved.push({ chunkIndex: input.chunkIndex, dims: input.embedding.length });
    }
  };

  const res = await processEmbedJob(
    {
      tenantId: "acme",
      projectId: "sub",
      itemId: "DOC-1",
      sourceVersion: "v1",
      accessPolicyId: "internal-project",
      content: "# Título\n\n## Seção 1\nRegra A\n\n## Seção 2\nRegra B"
    },
    fakeRepo,
    async () => new Array(1024).fill(0.01)
  );

  assert.equal(res.chunksIndexed, 3);
  assert.equal(saved.length, 3);
  assert.equal(saved[0].dims, 1024);
});

test("processEmbedJob rejects an item whose persisted policy differs from the job scope", async () => {
  let embeddingCalls = 0;
  let writes = 0;
  const repo = {
    async getEmbeddingSource() {
      return { content: "# Restricted", accessPolicyId: "restricted-security" };
    },
    async upsertEmbedding() {
      writes += 1;
    }
  };

  await assert.rejects(() => processEmbedJob({
    tenantId: "acme", projectId: "billing", itemId: "DOC-PRIVATE", sourceVersion: "v1",
    accessPolicyId: "internal-project", content: "# Public payload"
  }, repo, async () => {
    embeddingCalls += 1;
    return [0.1];
  }), /outside the job scope/);
  assert.equal(embeddingCalls, 0);
  assert.equal(writes, 0);
});

test("processEmbedJob audits its persisted embedding write under the item's policy", async () => {
  const audits: Array<{ action: string; targetType: string; targetId?: string; accessPolicyId: string }> = [];
  const repo = {
    async getEmbeddingSource() {
      return { content: "# Persisted", accessPolicyId: "restricted-security" };
    },
    async upsertEmbedding() {}
  };
  const result = await processEmbedJob({
    tenantId: "acme", projectId: "billing", itemId: "DOC-PRIVATE", sourceVersion: "v1",
    accessPolicyId: "restricted-security", content: "# Untrusted job copy"
  }, repo, async (text) => {
    assert.match(text, /Persisted/);
    return [0.1];
  }, async (event, ctx) => {
    assert.deepEqual(ctx.allowedProjects, ["billing"]);
    assert.deepEqual(ctx.allowedPolicies, ["restricted-security"]);
    audits.push({ action: event.action, targetType: event.targetType, targetId: event.targetId, accessPolicyId: event.accessPolicyId });
  });

  assert.equal(result.chunksIndexed, 1);
  assert.deepEqual(audits, [{ action: "upsert", targetType: "knowledge_embedding", targetId: "DOC-PRIVATE", accessPolicyId: "restricted-security" }]);
});

test("processGitIngestJob persists embeddings via replaceItemEmbeddings and @brain-rule/@brain-adr edges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-ingest-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src/billing.ts"),
      "// @brain-rule BR-001\n// @brain-adr ADR-002\nexport function charge() { return true; }\n",
      "utf8"
    );
    writeFileSync(join(dir, "README.md"), "# Billing\n\n## Rules\nCharge safely.\n", "utf8");

    const items: string[] = [];
    const replacedEmbeddings: Array<{ itemId: string; chunkCount: number }> = [];
    const edges: Array<{ fromItemId: string; toItemId: string; relationType: string }> = [];

    const repo = {
      async upsertItem(_ctx: unknown, item: { id: string }) {
        items.push(item.id);
        return { version: 1, changed: true };
      },
      async replaceItemEmbeddings(
        _ctx: unknown,
        input: { knowledgeItemId: string; chunks: ReadonlyArray<unknown> }
      ) {
        replacedEmbeddings.push({ itemId: input.knowledgeItemId, chunkCount: input.chunks.length });
        return input.chunks.length;
      }
    };

    const res = await processGitIngestJob(
      { tenantId: "acme", projectId: "billing", repoDir: dir, commitSha: "abc123" },
      repo,
      {
        embedFn: async () => [0.1, 0.2, 0.3],
        graphStore: {
          async addEdge(edge) {
            edges.push({
              fromItemId: edge.fromItemId,
              toItemId: edge.toItemId,
              relationType: edge.relationType
            });
          }
        }
      }
    );

    assert.equal(res.ingested, 2);
    assert.equal(res.errors, 0);
    assert.ok(res.chunksEmbedded >= 2);
    assert.equal(replacedEmbeddings.length, 2);
    assert.equal(res.edgesCreated, 2);
    assert.deepEqual(
      edges.map((e) => ({ toItemId: e.toItemId, relationType: e.relationType })),
      [
        { toItemId: "BR-001", relationType: "GOVERNED_BY" },
        { toItemId: "ADR-002", relationType: "DECIDED_BY" }
      ]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processGitIngestJob persists SCIP relationships between ingested source items under their project policies", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-scip-edges-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".scip"), { recursive: true });
    writeFileSync(join(dir, "src/dog.ts"), "export class Dog {}\n", "utf8");
    writeFileSync(join(dir, "src/animal.ts"), "export interface Animal {}\n", "utf8");
    writeFileSync(join(dir, ".scip/index.scip"), JSON.stringify({
      metadata: { toolInfo: "scip-typescript test", projectRoot: `file://${dir}` },
      documents: [
        { relativePath: "src/dog.ts", language: "typescript", occurrences: [{ symbol: "demo Dog#", range: [0, 13, 16], role: "definition" }], symbols: [{
          symbol: "demo Dog#", displayName: "Dog", kind: 12, documentation: [], enclosingSymbol: "",
          relationships: [{ symbol: "demo Animal#", isReference: false, isImplementation: true, isTypeDefinition: false, isDefinition: false }]
        }] },
        { relativePath: "src/animal.ts", language: "typescript", occurrences: [{ symbol: "demo Animal#", range: [0, 18, 24], role: "definition" }], symbols: [{
          symbol: "demo Animal#", displayName: "Animal", kind: 12, documentation: [], enclosingSymbol: "", relationships: []
        }] }
      ]
    }), "utf8");

    const persisted: Array<{ id: string; accessPolicyId: string; type: string; sourceUri: string; metadata?: Record<string, unknown> }> = [];
    const edges: Array<Record<string, unknown>> = [];
    let reconciledSymbolIds: string[] | undefined;
    const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", repoDir: dir }, {
      async upsertItem(_ctx, item) { persisted.push({ id: item.id, accessPolicyId: item.accessPolicyId, type: item.type, sourceUri: item.sourceUri, metadata: item.metadata }); return { version: 1, changed: true }; },
      async replaceItemEmbeddings(_ctx, input) { return input.chunks.length; }
    }, {
      embedFn: async () => [0.1],
      piiRedactFn: async (content) => content,
      graphStore: { async addEdge(edge) { edges.push(edge as unknown as Record<string, unknown>); } },
      retireScipSymbolsExcept: async (_ctx, input) => { reconciledSymbolIds = [...input.retainedItemIds]; return 0; }
    });

    assert.equal(result.errors, 0);
    assert.equal(result.edgesCreated, 4);
    assert.deepEqual(persisted.map((item) => item.id).filter((id) => id.startsWith("SCIP-")).sort(), [
      `SCIP-${createHash("sha256").update("demo Animal#").digest("hex").slice(0, 24)}`,
      `SCIP-${createHash("sha256").update("demo Dog#").digest("hex").slice(0, 24)}`
    ].sort());
    assert.equal(persisted.filter((item) => item.id.startsWith("SCIP-")).length, 2);
    assert.deepEqual(reconciledSymbolIds, [
      `SCIP-${createHash("sha256").update("demo Animal#").digest("hex").slice(0, 24)}`,
      `SCIP-${createHash("sha256").update("demo Dog#").digest("hex").slice(0, 24)}`
    ].sort());
    assert.deepEqual(persisted.filter((item) => !item.id.startsWith("SCIP-")).map((item) => item.id).sort(), ["src/animal.ts", "src/dog.ts"]);
    assert.ok(persisted.filter((item) => item.type === "code_symbol").every((item) => item.sourceUri.startsWith("src/")));
    assert.deepEqual(edges.find((edge) => edge.fromItemId === "src/dog.ts" && edge.toItemId === "src/animal.ts"), {
      tenantId: "acme", fromProjectId: "billing", toProjectId: "billing",
      fromItemId: "src/dog.ts", toItemId: "src/animal.ts",
      fromPolicyId: "internal-project", toPolicyId: "internal-project",
      relationType: "IMPLEMENTS", isInferred: false, confidence: 1,
      evidenceUri: ".scip/index.scip",
      metadata: { source: "scip", symbolMappings: [{
        fromSymbol: "demo Dog#", toSymbol: "demo Animal#", kind: "IMPLEMENTS",
        flags: { isReference: false, isImplementation: true, isTypeDefinition: false, isDefinition: false }
      }] }
    });
    assert.ok(edges.some((edge) => edge.relationType === "IMPLEMENTS" && String(edge.fromItemId).startsWith("SCIP-") && String(edge.toItemId).startsWith("SCIP-")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git ingestion persists and embeds only redacted source content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-pii-"));
  try {
    writeFileSync(join(dir, "README.md"), "Contact jane@example.test for billing help.", "utf8");
    let persisted = "";
    let embeddedText = "";
    const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", repoDir: dir }, {
      async upsertItem(_ctx, item) { persisted = item.content; return { version: 1, changed: true }; },
      async replaceItemEmbeddings(_ctx, input) { return input.chunks.length; }
    }, {
      embedFn: async (text) => { embeddedText += text; return [0.1]; },
      piiRedactFn: async (text) => text.replace("jane@example.test", "[EMAIL]")
    });
    assert.equal(result.errors, 0);
    assert.doesNotMatch(persisted, /jane@example\.test/);
    assert.match(persisted, /\[EMAIL\]/);
    assert.doesNotMatch(embeddedText, /jane@example\.test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Git redaction failure leaves the source unpersisted and its checkpoint unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-pii-fail-"));
  try {
    writeFileSync(join(dir, "README.md"), "Contact jane@example.test.", "utf8");
    let upserts = 0;
    let advances = 0;
    const commitSha = "a".repeat(40);
    const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", owner: "acme", repo: "billing", ref: commitSha, branch: "main", commitSha }, {
      async upsertItem() { upserts++; return { version: 1, changed: true }; }
    }, {
      secretScanFn: () => ({ clean: true, findings: [], ignoredFindings: [], engine: "gitleaks" }),
      piiRedactFn: async () => { throw new Error("AI Worker unavailable"); },
      fetchFn: async (url) => {
        const target = String(url);
        if (target.endsWith("/repos/acme/billing")) return Response.json({ private: true });
        if (target.includes(`/commits/${commitSha}`)) return Response.json({ sha: commitSha });
        if (target.includes(`/git/trees/${commitSha}`)) return Response.json({
          sha: "tree-sha", truncated: false, tree: [{ path: "README.md", type: "blob", sha: "blob-sha" }]
        });
        return Response.json({ sha: "blob-sha", encoding: "base64", content: Buffer.from("Contact jane@example.test").toString("base64") });
      },
      gitState: {
        async withGitIngestionLock<T>(_ctx: unknown, _input: unknown, fn: () => Promise<T>) { return fn(); },
        async getGitHubRefHead() { return undefined; },
        async getGitIngestionHead() { return undefined; },
        async advanceGitIngestionHead() { advances++; return true; }
      } as unknown as GitIngestOptions["gitState"]
    });
    assert.equal(upserts, 0);
    assert.equal(result.errors, 1);
    assert.equal(result.checkpointAdvanced, false);
    assert.equal(advances, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processGitIngestJob audits each changed item with its own access policy scope", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-audit-scope-"));
  try {
    mkdirSync(join(dir, ".brain/01-business"), { recursive: true });
    writeFileSync(join(dir, ".brain/01-business/BR-PRIVATE.yaml"), [
      "id: BR-PRIVATE", "type: business_rule", "title: Private rule", "status: draft",
      "access_policy: restricted-security", "description: Synthetic restricted rule."
    ].join("\n"), "utf8");
    const auditEvents: Array<{ action: string; targetType: string; targetId?: string; accessPolicyId: string }> = [];
    const auditScopes: Array<{ allowedProjects: readonly string[]; allowedPolicies: readonly string[] }> = [];
    const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", repoDir: dir }, {
      async upsertItem() { return { version: 1, changed: true }; }
    }, {
      embedFn: async () => [0.5],
      secretScanFn: () => ({ clean: true, findings: [], ignoredFindings: [], engine: "gitleaks" }),
      auditFn: async (event: typeof auditEvents[number], ctx: typeof auditScopes[number]) => {
        auditEvents.push(event);
        auditScopes.push({ allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies });
      }
    } as Parameters<typeof processGitIngestJob>[2]);

    assert.equal(result.errors, 0);
    assert.deepEqual(auditEvents.map(({ action, targetType, targetId, accessPolicyId }) => ({ action, targetType, targetId, accessPolicyId })), [{
      action: "create", targetType: "knowledge_item", targetId: "BR-PRIVATE", accessPolicyId: "restricted-security"
    }]);
    assert.deepEqual(auditScopes, [{ allowedProjects: ["billing"], allowedPolicies: ["internal-project", "restricted-security"] }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processGitIngestJob keeps derived data recoverable on an unchanged reingest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-idempotency-"));
  try {
    writeFileSync(join(dir, "doc.md"), "# Stable\n\nSame content.\n", "utf8");
    const savedHashes = new Map<string, string>();
    let embeddingWrites = 0;
    let edgeWrites = 0;
    const repo = {
      async upsertItem(_ctx: unknown, item: { id: string; contentHash: string }) {
        const changed = savedHashes.get(item.id) !== item.contentHash;
        savedHashes.set(item.id, item.contentHash);
        return { version: 1, changed };
      },
      async replaceItemEmbeddings() {
        embeddingWrites += 1;
        return 1;
      }
    };
    writeFileSync(join(dir, "src.ts"), "// @brain-rule BR-1\nexport const stable = true;\n", "utf8");
    const opts = {
      embedFn: async () => [0.1, 0.2],
      graphStore: { async addEdge() { edgeWrites += 1; } }
    };
    await processGitIngestJob({ tenantId: "acme", projectId: "billing", repoDir: dir }, repo, opts);
    const repeated = await processGitIngestJob({ tenantId: "acme", projectId: "billing", repoDir: dir }, repo, opts);
    assert.equal(embeddingWrites, 4);
    assert.equal(edgeWrites, 2);
    assert.equal(repeated.ingested, 0);
    assert.equal(repeated.chunksEmbedded, 2);
    assert.equal(repeated.edgesCreated, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processGitIngestJob fetches remote GitHub files without cloning and records repository plus commit provenance", async () => {
  const saved: Array<{ id: string; sourceVersion: string; sourceUri: string; sourceOrigin: string; status: string; trustLevel: string; metadata: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const repo = {
    async upsertItem(_ctx: unknown, item: { id: string; sourceVersion: string; sourceUri: string; sourceOrigin: string; status: string; trustLevel: string; metadata?: Record<string, unknown> }) {
      saved.push({ id: item.id, sourceVersion: item.sourceVersion, sourceUri: item.sourceUri, sourceOrigin: item.sourceOrigin, status: item.status, trustLevel: item.trustLevel, metadata: item.metadata ?? {} });
      return { version: 1, changed: true };
    }
  };
  const edges: unknown[] = [];
  const res = await processGitIngestJob(
    { tenantId: "acme", projectId: "billing", owner: "acme", repo: "billing", ref: "main" },
    repo,
    {
      embedFn: async () => [0.1, 0.2],
      graphStore: { async addEdge(edge: unknown) { edges.push(edge); } },
      fetchFn: async (url) => {
        const target = String(url);
        if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: false }), { status: 200 });
        calls.push(target);
        if (target.includes("/commits/main")) return new Response(JSON.stringify({ sha: "commit-sha-1" }), { status: 200 });
        if (target.includes("/git/trees/")) return new Response(JSON.stringify({
          sha: "tree-sha-1", truncated: false,
          tree: [{ path: ".brain/01-business/BR-REMOTE.yaml", type: "blob", sha: "blob-1" }]
        }), { status: 200 });
        return new Response(JSON.stringify({ sha: "blob-1", encoding: "base64", content: Buffer.from(
          "id: BR-REMOTE\ntype: business_rule\ntitle: Remote Rule\nstatus: approved\naccess_policy: internal-project\ndescription: Fetched from GitHub.\n"
        ).toString("base64") }), { status: 200 });
      }
    }
  );
  assert.equal(res.ingested, 1);
  assert.equal(res.errors, 0);
  assert.deepEqual(saved, [{
    id: "external:acme/billing:BR-REMOTE", sourceVersion: "commit-sha-1",
    sourceUri: "external/acme/billing/.brain/01-business/BR-REMOTE.yaml",
    sourceOrigin: "external_reference", status: "draft", trustLevel: "untrusted",
    metadata: { id: "BR-REMOTE", type: "business_rule", title: "Remote Rule", status: "approved", access_policy: "internal-project", description: "Fetched from GitHub.", sourceRepository: "acme/billing" }
  }]);
  assert.ok(calls.some((url) => url.includes("/git/trees/commit-sha-1?recursive=1")));
  assert.equal(edges.length, 0);
});

test("processGitIngestJob fetches a remote SCIP index and creates policy-scoped symbol items", async () => {
  const index = JSON.stringify({
    metadata: { toolInfo: "scip-typescript test", projectRoot: "" },
    documents: [{ relativePath: "src/payments.ts", language: "typescript", occurrences: [
      { symbol: "demo charge().", range: [2, 0, 6], role: "definition" }
    ], symbols: [{ symbol: "demo charge().", displayName: "charge", kind: 17, documentation: ["Charges an invoice."], enclosingSymbol: "", relationships: [] }] }]
  });
  const saved: Array<{ id: string; type: string; sourceUri: string; accessPolicyId: string; metadata?: Record<string, unknown> }> = [];
  const requested: string[] = [];
  const edges: unknown[] = [];
  const result = await processGitIngestJob(
    { tenantId: "acme", projectId: "billing", owner: "acme", repo: "billing", ref: "main" },
    { async upsertItem(_ctx, item) { saved.push({ id: item.id, type: item.type, sourceUri: item.sourceUri, accessPolicyId: item.accessPolicyId, metadata: item.metadata }); return { version: 1, changed: true }; } },
    {
      embedFn: async () => [0.1],
      fetchFn: async (url) => {
        const target = String(url);
        requested.push(target);
        if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: true }), { status: 200 });
        if (target.includes("/commits/main")) return new Response(JSON.stringify({ sha: "commit-sha-1" }), { status: 200 });
        if (target.includes("/git/trees/")) return new Response(JSON.stringify({
          sha: "tree-sha-1", truncated: false,
          tree: [
            { path: "src/payments.ts", type: "blob", sha: "source-blob" },
            { path: ".scip/index.scip", type: "blob", sha: "scip-blob" }
          ]
        }), { status: 200 });
        const isIndex = target.includes(".scip/index.scip");
        const text = isIndex ? index : "export function charge() { return true; }";
        return new Response(JSON.stringify({ sha: isIndex ? "scip-blob" : "source-blob", encoding: "base64", content: Buffer.from(text).toString("base64") }), { status: 200 });
      }
    }
  );
  assert.equal(result.errors, 0);
  assert.equal(saved.filter((item) => item.type === "code_symbol").length, 1, JSON.stringify({ saved, result, requested }));
  assert.deepEqual(saved.find((item) => item.type === "code_symbol"), {
    id: `SCIP-${createHash("sha256").update("demo charge().").digest("hex").slice(0, 24)}`,
    type: "code_symbol", sourceUri: "src/payments.ts", accessPolicyId: "internal-project",
    metadata: {
      source: "scip", symbol: "demo charge().", language: "typescript", filePath: "src/payments.ts",
      definitionRange: [2, 0, 6], kind: 17, enclosingSymbol: "", sourceRepository: "acme/billing"
    }
  });
  assert.equal(edges.length, 0);
});

test("processGitIngestJob uses a matching checkpoint for changed files and advances it only after success", async () => {
  const base = "a".repeat(40);
  const head = "b".repeat(40);
  const calls: string[] = [];
  let advanced = false;
  const state = {
    async withGitIngestionLock(_ctx: unknown, _input: unknown, run: () => Promise<unknown>) { return run(); },
    async getGitHubRefHead() { return { commitSha: head }; },
    async getGitIngestionHead() { return { commitSha: base }; },
    async advanceGitIngestionHead(_ctx: unknown, input: { commitSha: string; expectedPreviousCommitSha?: string }) {
      advanced = input.commitSha === head && input.expectedPreviousCommitSha === base;
      return advanced;
    }
  };
  const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", owner: "acme", repo: "billing", ref: head, branch: "main", beforeCommitSha: base, commitSha: head }, {
    async upsertItem() { return { version: 1, changed: true }; }
  }, {
    gitState: state as never,
    embedFn: async () => [0.1],
    fetchFn: async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: true }), { status: 200 });
      if (target.includes("/compare/")) return new Response(JSON.stringify({ status: "ahead", files: [{ filename: "docs/rule.md", sha: "blob-1", status: "modified" }] }), { status: 200 });
      return new Response(JSON.stringify({ sha: "blob-1", encoding: "base64", content: Buffer.from("# Rule\n\nIncremental content.\n").toString("base64") }), { status: 200 });
    }
  });
  assert.equal(result.ingestionMode, "incremental");
  assert.equal(result.checkpointAdvanced, true);
  assert.equal(advanced, true);
  assert.ok(calls.some((url) => url.includes("/compare/")));
  assert.ok(!calls.some((url) => url.includes("/git/trees/")));
});

test("processGitIngestJob retires a deleted path after an incremental compare", async () => {
  const base = "c".repeat(40);
  const head = "d".repeat(40);
  let retired: readonly string[] = [];
  const state = {
    async withGitIngestionLock(_ctx: unknown, _input: unknown, run: () => Promise<unknown>) { return run(); },
    async getGitHubRefHead() { return { commitSha: head }; },
    async getGitIngestionHead() { return { commitSha: base }; },
    async advanceGitIngestionHead() { return true; }
  };
  const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", owner: "acme", repo: "billing", ref: head, branch: "main", beforeCommitSha: base, commitSha: head }, {
    async upsertItem() { return { version: 1, changed: true }; }
  }, {
    gitState: state as never,
    retireGitSources: async (_ctx, input) => { retired = input.sourceUris; return 1; },
    fetchFn: async (url) => {
      const target = String(url);
      if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: false }), { status: 200 });
      return new Response(JSON.stringify({ status: "ahead", files: [{ filename: "docs/old.md", status: "removed" }] }), { status: 200 });
    }
  });
  assert.equal(result.ingestionMode, "incremental");
  assert.deepEqual(retired, ["external/acme/billing/docs/old.md"]);
});

test("processGitIngestJob leaves the ingestion checkpoint unchanged when a changed file fails", async () => {
  const base = "e".repeat(40);
  const head = "f".repeat(40);
  let advances = 0;
  const state = {
    async withGitIngestionLock(_ctx: unknown, _input: unknown, run: () => Promise<unknown>) { return run(); },
    async getGitHubRefHead() { return { commitSha: head }; },
    async getGitIngestionHead() { return { commitSha: base }; },
    async advanceGitIngestionHead() { advances += 1; return true; }
  };
  const result = await processGitIngestJob({ tenantId: "acme", projectId: "billing", owner: "acme", repo: "billing", ref: head, branch: "main", beforeCommitSha: base, commitSha: head }, {
    async upsertItem() { throw new Error("synthetic persistence failure"); }
  }, {
    gitState: state as never,
    fetchFn: async (url) => {
      const target = String(url);
      if (target.endsWith("/repos/acme/billing")) return new Response(JSON.stringify({ private: true }), { status: 200 });
      if (target.includes("/compare/")) return new Response(JSON.stringify({ status: "ahead", files: [{ filename: "docs/rule.md", sha: "blob-1", status: "modified" }] }), { status: 200 });
      return new Response(JSON.stringify({ sha: "blob-1", encoding: "base64", content: Buffer.from("# Rule\n\nchanged\n").toString("base64") }), { status: 200 });
    }
  });
  assert.equal(result.errors, 1);
  assert.equal(result.checkpointAdvanced, false);
  assert.equal(advances, 0);
});

test("processGitIngestJob reports per-file failures and continues ingesting later files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-file-errors-"));
  try {
    writeFileSync(join(dir, "a.md"), "# First\n\nFirst body.\n", "utf8");
    writeFileSync(join(dir, "b.md"), "# Second\n\nSecond body.\n", "utf8");
    const saved: string[] = [];
    const fileErrors: string[] = [];
    const repo = {
      async upsertItem(_ctx: unknown, item: { id: string }) {
        if (item.id === "a.md") throw new Error("synthetic write failure");
        saved.push(item.id);
        return { version: 1, changed: true };
      }
    };

    const result = await processGitIngestJob(
      { tenantId: "acme", projectId: "billing", repoDir: dir },
      repo,
      {
        embedFn: async () => [0.1],
        onFileError: (path, error) => fileErrors.push(`${path}:${String(error)}`)
      }
    );

    assert.equal(result.errors, 1);
    assert.equal(result.ingested, 1);
    assert.deepEqual(saved, ["b.md"]);
    assert.match(fileErrors[0]!, /a\.md:Error: synthetic write failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processGitIngestJob reports unavailable Gitleaks as a file error instead of a secret finding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-scanner-unavailable-"));
  try {
    writeFileSync(join(dir, "doc.md"), "# Safe document\n\nNo credential here.\n", "utf8");
    const writes: string[] = [];
    const fileErrors: string[] = [];
    const result = await processGitIngestJob(
      { tenantId: "acme", projectId: "billing", repoDir: dir },
      { async upsertItem(_ctx: unknown, item: { id: string }) { writes.push(item.id); return { version: 1, changed: true }; } },
      {
        secretScanFn: () => ({ clean: false, findings: ["Gitleaks Scanner Failure"], ignoredFindings: [], engine: "unavailable" }),
        onFileError: (_path, error) => fileErrors.push(error instanceof Error ? error.message : String(error))
      }
    );
    assert.equal(result.ingested, 0);
    assert.equal(result.skippedSecrets, 0);
    assert.equal(result.errors, 1);
    assert.equal(writes.length, 0);
    assert.match(fileErrors[0] ?? "", /Gitleaks.*unavailable/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processGitIngestJob degrades gracefully with warning when Ollama is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-fallback-"));
  try {
    writeFileSync(join(dir, "doc.md"), "# Doc\n\n## Section\nBody\n", "utf8");
    const warnings: string[] = [];
    const repo = {
      async upsertItem() {
        return { version: 1, changed: true };
      },
      async replaceItemEmbeddings() {
        return 0;
      }
    };

    const res = await processGitIngestJob(
      { tenantId: "acme", projectId: "billing", repoDir: dir },
      repo,
      {
        embedFn: async () => {
          throw new Error("ECONNREFUSED");
        },
        onWarning: (msg) => warnings.push(msg)
      }
    );

    assert.equal(res.ingested, 1);
    assert.equal(res.chunksEmbedded, 0);
    assert.equal(res.errors, 0);
    assert.equal(res.warnings.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(res.warnings[0]!, /Ollama indisponível/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker shutdown stops intake before queue and closes all resources exactly once", async () => {
  const events: string[] = [];
  let releaseQueue!: () => void;
  let markQueueStarted!: () => void;
  const queueStop = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const queueStarted = new Promise<void>((resolve) => { markQueueStarted = resolve; });
  const shutdown = createWorkerShutdown({
    stopAccepting: () => { events.push("stop-accepting"); },
    stopQueue: async () => { events.push("stop-queue"); markQueueStarted(); await queueStop; },
    closeConnections: async () => { events.push("close-connections"); }
  });

  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");
  await queueStarted;
  assert.deepEqual(events, ["stop-accepting", "stop-queue"]);
  releaseQueue();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["stop-accepting", "stop-queue", "close-connections"]);
});

test("worker shutdown closes connections even when queue stop fails", async () => {
  const events: string[] = [];
  const shutdown = createWorkerShutdown({
    stopAccepting: () => { events.push("stop-accepting"); },
    stopQueue: async () => { events.push("stop-queue"); throw new Error("pg-boss stop failed"); },
    closeConnections: async () => { events.push("close-connections"); }
  });
  await assert.rejects(shutdown("SIGTERM"), /pg-boss stop failed/);
  assert.deepEqual(events, ["stop-accepting", "stop-queue", "close-connections"]);
});
