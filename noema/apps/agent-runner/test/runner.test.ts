import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BrainRunnerQueue,
  executeRunnerAgentLoop,
  executeRunnerTaskWithOllama,
  loadAndVerifyModelLock,
  selectModelForTask,
  startRunnerDaemon
} from "../src/index.js";
import type { AuthContext } from "@noema/auth";

test("enqueues draft-only task and escalates destructive instructions", () => {
  const queue = new BrainRunnerQueue();
  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "dev",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };

  const okTask = queue.enqueue(ctx, { projectId: "sub", instruction: "Resumir últimos 10 commits" });
  assert.equal(okTask.status, "queued");
  assert.equal(okTask.draftOnly, true);

  const blocked = queue.enqueue(ctx, { projectId: "sub", instruction: "Rodar rm -rf / no servidor" });
  assert.equal(blocked.status, "escalated");
});

test("Runner questions pause tasks and resume once with idempotent human answers", () => {
  const queue = new BrainRunnerQueue();
  const ctx: AuthContext = {
    tenantId: "acme",
    actorId: "reviewer",
    actorType: "human",
    roles: ["developer"],
    allowedProjects: ["sub"],
    allowedPolicies: ["internal-project"]
  };
  const task = queue.enqueue(ctx, { projectId: "sub", instruction: "Implement webhook retry policy" });
  const question = queue.askQuestion(ctx, task.taskId, "Which retry contract must remain stable?");
  assert.equal(task.status, "awaiting_human");
  assert.equal(question.status, "pending");
  assert.throws(() => queue.askQuestion(ctx, task.taskId, "Second pending question"), /pergunta pendente/i);

  const answer = queue.answerQuestion(ctx, task.taskId, {
    questionId: question.questionId,
    response: "Keep the v2 response shape",
    idempotencyKey: "answer-1"
  });
  assert.equal(answer.duplicate, false);
  assert.equal(answer.question.status, "answered");
  assert.equal(task.status, "queued");
  assert.equal(queue.answerQuestion(ctx, task.taskId, {
    questionId: question.questionId,
    response: "Keep the v2 response shape",
    idempotencyKey: "answer-1"
  }).duplicate, true);
  assert.throws(() => queue.answerQuestion(ctx, task.taskId, {
    questionId: question.questionId,
    response: "Use v3 instead",
    idempotencyKey: "answer-1"
  }), /já foi respondida/i);
});

test("selectModelForTask implements Model Routing Matrix", () => {
  const simple = selectModelForTask("simple");
  assert.equal(simple.tier, "local-small");
  assert.equal(simple.useStructuredOutputs, false);
  assert.equal(simple.escalateToCloud, false);

  const structured = selectModelForTask("structured");
  assert.equal(structured.tier, "local-structured");
  assert.equal(structured.useStructuredOutputs, true);
  assert.equal(structured.escalateToCloud, false);
  assert.match(structured.model, /7b/i);

  const complex = selectModelForTask("complex");
  assert.equal(complex.tier, "escalate");
  assert.equal(complex.escalateToCloud, true);
});

test("loadAndVerifyModelLock validates models.lock.json and rejects invalid entries", () => {
  const realLockPath = resolve(import.meta.dirname, "../../models.lock.json");
  const manifest = loadAndVerifyModelLock(realLockPath);
  assert.ok(manifest.models.length >= 3);

  const dir = mkdtempSync(join(tmpdir(), "noema-lock-"));
  try {
    const badLicense = join(dir, "bad-license.json");
    writeFileSync(
      badLicense,
      JSON.stringify({
        schemaVersion: "1.0.0",
        models: [
          {
            name: "gemma:2b",
            role: "runner",
            license: "GPL-3.0",
            minRamGb: 4,
            sizeMb: 1500,
            maxSizeMb: 4096,
            sha256: `sha256:${"a".repeat(64)}`
          }
        ]
      })
    );
    assert.throws(() => loadAndVerifyModelLock(badLicense), /Modelos inválidos/);

    const badSize = join(dir, "bad-size.json");
    writeFileSync(
      badSize,
      JSON.stringify({
        schemaVersion: "1.0.0",
        models: [
          {
            name: "huge:70b",
            role: "runner",
            license: "MIT",
            minRamGb: 64,
            sizeMb: 40000,
            maxSizeMb: 8192,
            sha256: `sha256:${"b".repeat(64)}`
          }
        ]
      })
    );
    assert.throws(() => loadAndVerifyModelLock(badSize), /Modelos inválidos/);

    const badDigest = join(dir, "bad-digest.json");
    writeFileSync(
      badDigest,
      JSON.stringify({
        schemaVersion: "1.0.0",
        models: [
          {
            name: "qwen:3b",
            role: "runner",
            license: "Apache-2.0",
            minRamGb: 8,
            sizeMb: 2000,
            maxSizeMb: 4096,
            sha256: "sha256:not-a-valid-hex"
          }
        ]
      })
    );
    assert.throws(() => loadAndVerifyModelLock(badDigest), /Modelos inválidos/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startRunnerDaemon polls tasks in draft-only mode and stops cleanly", async () => {
  const queue = [
    { taskId: "T-1", projectId: "sub", instruction: "Gerar draft de release notes" },
    { taskId: "T-2", projectId: "sub", instruction: "rm -rf /tmp/prod" }
  ];
  const completed: Array<{ taskId: string; status: "completed" | "failed" | "escalated" }> = [];
  let seenDraftOnly = false;

  const daemon = startRunnerDaemon({
    pollIntervalMs: 15,
    taskSource: {
      claimNextRunnerTask() {
        return queue.shift();
      },
      completeRunnerTask(taskId, status) {
        completed.push({ taskId, status });
      }
    },
    async executeTask(task) {
      seenDraftOnly = task.draftOnly;
      task.status = "completed";
      task.resultSummary = "[bot-draft] OK";
      return task;
    }
  });

  await new Promise((r) => setTimeout(r, 80));
  await daemon.stop();

  assert.equal(daemon.isRunning(), false);
  assert.equal(seenDraftOnly, true);
  assert.equal(daemon.processedCount(), 2);
  assert.deepEqual(completed, [
    { taskId: "T-1", status: "completed" },
    { taskId: "T-2", status: "escalated" }
  ]);
});

test("Ollama runner records provider-reported token usage without estimating missing counts", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> = {};
  const task = {
    taskId: "usage-1", tenantId: "acme", projectId: "billing", instruction: "Draft a plan",
    priority: "normal" as const, draftOnly: true as const, maxSteps: 1, timeoutSeconds: 30,
    status: "running" as const, createdAt: new Date(0).toISOString()
  };
  const completed = await executeRunnerTaskWithOllama(task, "http://ollama.test:11435/", "qwen-test", async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      model: "qwen-test", response: "Draft plan", prompt_eval_count: 17, eval_count: 9, total_duration: 120_000_000, done: true
    }), { status: 200 });
  });
  assert.equal(requestUrl, "http://ollama.test:11435/api/generate");
  assert.equal(requestBody.model, "qwen-test");
  assert.equal(requestBody.stream, false);
  assert.match(String(requestBody.prompt), /Tarefa e contexto autorizado/);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.modelUsage, {
    provider: "ollama", model: "qwen-test", inputTokens: 17, outputTokens: 9, totalTokens: 26,
    durationMs: 120, providerCostUsd: 0, costBasis: "self_hosted_no_api_fee"
  });

  const noCounts = await executeRunnerTaskWithOllama(task, "http://ollama.test", "qwen-test", async () => new Response(JSON.stringify({ response: "Draft" }), { status: 200 }));
  assert.equal(noCounts.modelUsage?.inputTokens, null);
  assert.equal(noCounts.modelUsage?.outputTokens, null);
  assert.equal(noCounts.modelUsage?.providerCostUsd, 0);
});

test("agent loop sends model-generated draft with measured usage and charges context tokens", async () => {
  const proposals: Array<Record<string, unknown>> = [];
  const task = {
    taskId: "loop-usage", tenantId: "acme", projectId: "billing", instruction: "Design billing retries",
    priority: "normal" as const, draftOnly: true as const, maxSteps: 1, timeoutSeconds: 30,
    status: "queued" as const, createdAt: new Date(0).toISOString()
  };
  const completed = await executeRunnerAgentLoop(task, {
    callTool: async (name, args) => {
      if (name === "brain_context_build") return { tokenUsage: 21, sources: [] };
      proposals.push(args);
      return { accepted: true };
    },
    callModel: async () => ({
      response: "Use an idempotent retry policy.",
      usage: { provider: "ollama", model: "qwen-test", inputTokens: 21, outputTokens: 7, totalTokens: 28, durationMs: 80, providerCostUsd: 0, costBasis: "self_hosted_no_api_fee" }
    })
  });
  assert.equal(completed.status, "completed");
  assert.equal(proposals[0]?.content, "Use an idempotent retry policy.");
  assert.equal(completed.modelUsage?.totalTokens, 28);
});

test("agent loop records daily token usage through persistent budget and escalates over limit", async () => {
  let persisted = 90;
  const task = {
    taskId: "loop-budget", tenantId: "acme", projectId: "billing", instruction: "Summarize invoices",
    priority: "normal" as const, draftOnly: true as const, maxSteps: 1, timeoutSeconds: 30,
    status: "queued" as const, createdAt: new Date(0).toISOString()
  };
  const result = await executeRunnerAgentLoop(task, {
    callTool: async () => ({ tokenUsage: 20 }),
    recordBudgetUsage: async (_tenant, _project, tokens) => {
      persisted += tokens;
      return { allowed: persisted <= 100, used: persisted, limit: 100 };
    }
  });
  assert.equal(persisted, 110);
  assert.equal(result.status, "escalated");
  assert.match(result.resultSummary ?? "", /110\/100/);
});

