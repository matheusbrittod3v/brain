import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  AgentToolRegistry,
  buildSkillsSystemPrompt,
  ChannelRegistry,
  compactConversationHistory,
  HeartbeatScheduler,
  PROVIDER_REGISTRY,
  calculateCostFromTokens,
  generateWithVercelAiSdk,
  getRecentUsageLogs,
  getUsageSummary,
  loadSkillsFromDirectory,
  recordModelUsage,
  registerLlmProvider,
  runCliProvider,
  truncateToolOutput
} from "../dist/src/index.js";

test("truncateToolOutput preserves head and tail when oversized", () => {
  const long = "A".repeat(100) + "B".repeat(100);
  const truncated = truncateToolOutput(long, 60);
  assert.ok(truncated.includes("[truncated"));
  assert.ok(truncated.startsWith("AAAA"));
  assert.ok(truncated.endsWith("BBBB"));
});

test("compactConversationHistory summarizes dropped turns and keeps system + recent", async () => {
  const messages = [
    { role: "system", content: "System rules" },
    ...Array.from({ length: 12 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn message ${i} ` + "x".repeat(400)
    }))
  ];
  const res = await compactConversationHistory(messages, { maxTokens: 200, keepRecentMessages: 4 });
  assert.equal(res.compacted, true);
  assert.equal(res.droppedCount, 8);
  assert.equal(res.messages[0]?.role, "system");
  assert.ok(res.messages[1]?.content.includes("[Compacted History (8 earlier messages)]"));
  assert.equal(res.messages.length, 6);
});

test("AgentToolRegistry enforces CASL authorization before converting/executing tools", async () => {
  const registry = new AgentToolRegistry();
  registry.register({
    name: "approve_rule",
    description: "Approve business rule",
    inputSchema: z.object({ ruleId: z.string() }),
    caslAction: "approve",
    caslSubject: "Proposal",
    execute: async ({ ruleId }) => `approved:${ruleId}`
  });

  const viewerCtx = {
    tenantId: "default-org",
    actorId: "usr_viewer",
    actorType: "human",
    roles: ["viewer"],
    allowedProjects: ["brain"],
    allowedPolicies: ["internal-project"]
  };
  const adminCtx = { ...viewerCtx, actorId: "usr_admin", roles: ["admin"] };

  assert.equal(registry.authorize(registry.get("approve_rule"), viewerCtx, "brain").allowed, false);
  assert.equal(registry.authorize(registry.get("approve_rule"), adminCtx, "brain").allowed, true);

  const aiTools = registry.toVercelAiTools(adminCtx, "brain");
  const out = await aiTools.approve_rule.execute({ ruleId: "BR-1" }, { toolCallId: "tc1", messages: [] });
  assert.equal(out, "approved:BR-1");
});

test("loadSkillsFromDirectory parses SKILL.md bundles and formats system prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-skills-"));
  try {
    mkdirSync(join(dir, "git-audit"));
    writeFileSync(
      join(dir, "git-audit", "SKILL.md"),
      `---\nname: git-audit\ndescription: Audit commits\n---\nAlways check test coverage before approving.`
    );
    const skills = loadSkillsFromDirectory(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "git-audit");
    const prompt = buildSkillsSystemPrompt(skills);
    assert.ok(prompt.includes("Always check test coverage before approving."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ChannelRegistry and HeartbeatScheduler manage adapters and periodic ticks", async () => {
  const channels = new ChannelRegistry();
  const sent = [];
  channels.register({
    channelType: "telegram",
    instance: "tg-main",
    start: async () => { },
    send: async (m) => { sent.push(m.text); },
    stop: async () => { }
  });

  const adapter = channels.getByType("telegram");
  assert.ok(adapter);
  await adapter.send({ channelType: "telegram", recipientId: "u1", threadId: null, text: "hello" });
  assert.deepEqual(sent, ["hello"]);

  let ticks = 0;
  const hb = new HeartbeatScheduler(60_000, async () => { ticks += 1; });
  await hb.triggerNow();
  assert.equal(ticks, 1);
  hb.stop();
});

test("PROVIDER_REGISTRY exposes 9router/local/cloud/cli modes and fallback chain works", async () => {
  assert.equal(PROVIDER_REGISTRY["9router"]?.baseUrl, "http://localhost:20128/v1");
  assert.equal(PROVIDER_REGISTRY.lmstudio?.baseUrl, "http://localhost:1234/v1");
  assert.equal(PROVIDER_REGISTRY.openrouter?.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(PROVIDER_REGISTRY["claude-cli"]?.mode, "cli");

  registerLlmProvider("custom-local", {
    mode: "http",
    format: "openai-compatible",
    baseUrl: "http://localhost:9999/v1",
    defaultApiKey: "none"
  });
  assert.equal(PROVIDER_REGISTRY["custom-local"]?.baseUrl, "http://localhost:9999/v1");

  const cliOut = await runCliProvider(
    [process.execPath, "-e", "console.log('ok:' + process.argv[1])"],
    "ping",
    "sys"
  );
  assert.equal(cliOut.text, "ok:sys\n\nping");

  const fallbackRes = await generateWithVercelAiSdk({
    provider: "custom-local",
    model: "missing-model",
    baseUrl: "http://127.0.0.1:1/v1",
    prompt: "hello",
    fallbacks: [
      {
        provider: "claude-cli",
        model: "cli-mock",
        cliCommand: [process.execPath, "-e", "console.log('fallback-ok:' + process.argv[1])"]
      }
    ]
  });
  assert.equal(fallbackRes.text, "fallback-ok:hello");
  assert.equal(fallbackRes.provider, "claude-cli");
  assert.equal(fallbackRes.attempts, 2);
});

test("usage-tracker computes 9router-style token cost and aggregates summary logs", () => {
  const cost = calculateCostFromTokens(
    { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 500_000 },
    { input: 3.0, output: 15.0, cached: 0.3 }
  );
  // nonCachedInput = 500k * $3/1M = $1.50; cached = 500k * $0.3/1M = $0.15; output = 100k * $15/1M = $1.50 => $3.15
  assert.equal(cost, 3.15);

  recordModelUsage({
    provider: "openai",
    model: "gpt-4o",
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 0,
    totalTokens: 1500,
    latencyMs: 240,
    status: "ok"
  });
  const summary = getUsageSummary();
  assert.ok(summary.totalRequests >= 1);
  assert.ok(summary.totalTokens >= 1500);
  assert.ok(getRecentUsageLogs(10).length >= 1);
});



