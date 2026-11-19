import {
  executeRunnerAgentLoop,
  executeRunnerTaskWithAppleFm,
  generateWithVercelAiSdk,
  startRunnerDaemon
} from "@brain/agent-runner";
import type { PgOperationalRepository } from "@brain/database";

export function startWorkerRunnerDaemon(opRepo: PgOperationalRepository): void {
  const apiBaseUrl = (process.env.BRAIN_API_URL ?? `http://localhost:${process.env.PORT ?? 3333}`).replace(/\/$/, "");
  const apiKey = process.env.BRAIN_LOCAL_API_KEY;
  if (!apiKey) return;

  const dailyTokenLimit = Number(process.env.BRAIN_RUNNER_DAILY_TOKEN_LIMIT ?? 100_000);
  startRunnerDaemon({
    pollIntervalMs: Number(process.env.BRAIN_RUNNER_POLL_MS ?? 2000),
    taskSource: {
      async claimNextRunnerTask() {
        const claimed = await opRepo.claimNextRunnerTask();
        return claimed ?? undefined;
      },
      async completeRunnerTask(taskId, status, resultSummary, resultMetadata) {
        await opRepo.completeRunnerTask(taskId, status, resultSummary, resultMetadata);
      }
    },
    executeTask: (task) =>
      executeRunnerAgentLoop(task, {
        recordBudgetUsage: (tenantId, projectId, tokens) => opRepo.recordRunnerTokenUsage(tenantId, projectId, tokens, dailyTokenLimit),
        ...(process.env.BRAIN_RUNNER_MODEL_EXECUTION === "apple-fm" || process.env.BRAIN_RUNNER_MODEL_EXECUTION === "fm"
          ? {
              callModel: async ({ task: runnerTask, context }) => {
                const enrichedTask = {
                  ...runnerTask,
                  instruction: `${runnerTask.instruction}\n\nAuthorized Context Pack (JSON):\n${JSON.stringify(context)}`
                };
                const generated = await executeRunnerTaskWithAppleFm(enrichedTask);
                return {
                  response: (generated.resultSummary ?? "").replace(/^\[bot-draft\]\s*/, ""),
                  usage: generated.modelUsage
                };
              }
            }
          : {
              callModel: async ({ task: runnerTask, context }) => {
                const isSecondary = runnerTask.instruction.startsWith("[role:secondary]");
                const cleanInstruction = runnerTask.instruction.replace(/^\[role:(primary|secondary)\]\s*/i, "");
                let primary = { provider: "codex", model: "default" };
                let secondary = { provider: "ollama", model: process.env.OLLAMA_MODEL || "gemma2:2b" };
                let fallbacks = [{ provider: "ollama", model: process.env.OLLAMA_MODEL || "gemma2:2b" }];
                try {
                  const rRes = await fetch(`${apiBaseUrl}/v1/projects/${encodeURIComponent(runnerTask.projectId)}/runner/routing`, {
                    headers: { authorization: `Bearer ${apiKey}` }
                  });
                  if (rRes.ok) {
                    const rData = (await rRes.json()) as { primary?: typeof primary; secondary?: typeof secondary; fallbacks?: typeof fallbacks };
                    if (rData.primary) primary = rData.primary;
                    if (rData.secondary) secondary = rData.secondary;
                    if (rData.fallbacks) fallbacks = rData.fallbacks;
                  }
                } catch {
                  // Use default codex -> ollama chain
                }
                const chosen = isSecondary ? secondary : primary;
                const res = await generateWithVercelAiSdk({
                  provider: chosen.provider,
                  model: chosen.model,
                  fallbacks,
                  system: "Você é o Brain Runner. Responda de forma objetiva e em draft-only usando o contexto autorizado.",
                  prompt: `${cleanInstruction}\n\nAuthorized Context Pack (JSON):\n${JSON.stringify(context)}`
                });
                return {
                  response: res.text,
                  usage: {
                    provider: res.provider || chosen.provider,
                    model: res.model || chosen.model,
                    inputTokens: res.usage.inputTokens,
                    outputTokens: res.usage.outputTokens,
                    totalTokens: res.usage.totalTokens,
                    durationMs: null,
                    providerCostUsd: null,
                    costBasis: "unknown" as const
                  }
                };
              }
            }),
        callTool: async (toolName, args) => {
          const headers = {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          };
          if (toolName === "brain_context_build") {
            const res = await fetch(`${apiBaseUrl}/v1/projects/${encodeURIComponent(String(args.projectId))}/context`, {
              method: "POST",
              headers,
              body: JSON.stringify({ task: args.task, tokenBudget: args.tokenBudget ?? 3000 })
            });
            if (!res.ok) throw new Error(`Context API HTTP ${res.status}`);
            return res.json();
          }
          if (toolName === "brain_change_propose") {
            const res = await fetch(`${apiBaseUrl}/v1/projects/${encodeURIComponent(String(args.projectId))}/change/propose`, {
              method: "POST",
              headers,
              body: JSON.stringify({ title: args.title, content: args.content })
            });
            if (!res.ok) throw new Error(`Proposals API HTTP ${res.status}`);
            return res.json();
          }
          throw new Error(`Tool '${toolName}' não suportada pelo Brain Runner loop.`);
        }
      })
  });
}

