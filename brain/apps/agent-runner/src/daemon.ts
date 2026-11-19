import { executeRunnerTaskWithOllama } from "./local-executors.js";
import { DESTRUCTIVE_COMMANDS, type ModelUsage, type RunnerTask } from "./queue.js";
import { runSandboxedCommand } from "./sandbox.js";

export interface RunnerDaemonTask {
  taskId: string;
  projectId: string;
  instruction: string;
}

export interface RunnerDaemonTaskSource {
  claimNextRunnerTask(projectId?: string): RunnerDaemonTask | undefined | Promise<RunnerDaemonTask | undefined>;
  completeRunnerTask(
    taskId: string,
    status: "completed" | "failed" | "escalated",
    resultSummary?: string,
    resultMetadata?: Record<string, unknown>
  ): void | Promise<void>;
}

export interface RunnerDaemonOptions {
  taskSource: RunnerDaemonTaskSource;
  projectId?: string;
  tenantId?: string;
  pollIntervalMs?: number;
  executeTask?: (task: RunnerTask) => Promise<RunnerTask>;
  onTaskComplete?: (task: RunnerTask) => void;
  onError?: (error: unknown) => void;
}

export interface RunnerDaemonHandle {
  stop(): Promise<void>;
  isRunning(): boolean;
  processedCount(): number;
}

export function startRunnerDaemon(opts: RunnerDaemonOptions): RunnerDaemonHandle {
  const pollIntervalMs = Math.max(10, opts.pollIntervalMs ?? 1000);
  const tenantId = opts.tenantId ?? process.env.BRAIN_TENANT_ID ?? "default-org";
  const executeTask = opts.executeTask ?? ((task: RunnerTask) => executeRunnerTaskWithOllama(task));

  let running = true;
  let processed = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  const scheduleNext = () => {
    if (!running) return;
    timer = setTimeout(() => {
      inFlight = tick().finally(() => {
        inFlight = undefined;
        scheduleNext();
      });
    }, pollIntervalMs);
  };

  const tick = async () => {
    if (!running) return;
    try {
      const claimed = await opts.taskSource.claimNextRunnerTask(opts.projectId);
      if (!claimed) return;

      const task: RunnerTask = {
        taskId: claimed.taskId,
        tenantId,
        projectId: claimed.projectId,
        instruction: claimed.instruction,
        priority: "normal",
        draftOnly: true,
        maxSteps: 10,
        timeoutSeconds: 120,
        status: DESTRUCTIVE_COMMANDS.test(claimed.instruction) ? "escalated" : "running",
        ...(DESTRUCTIVE_COMMANDS.test(claimed.instruction)
          ? { resultSummary: "Bloqueado pelo guardrail de execução (comando destrutivo)." }
          : {}),
        createdAt: new Date().toISOString()
      };

      let completed: RunnerTask;
      try {
        completed = task.status === "escalated" ? task : await executeTask(task);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await opts.taskSource.completeRunnerTask(claimed.taskId, "failed", `Runner execution failed: ${message}`);
        processed += 1;
        opts.onError?.(err);
        return;
      }
      await opts.taskSource.completeRunnerTask(
        claimed.taskId,
        completed.status === "completed" ? "completed" : completed.status === "escalated" ? "escalated" : "failed",
        completed.resultSummary,
        completed.modelUsage ? { modelUsage: completed.modelUsage } : undefined
      );
      processed += 1;
      opts.onTaskComplete?.(completed);
    } catch (err) {
      opts.onError?.(err);
    }
  };

  inFlight = tick().finally(() => {
    inFlight = undefined;
    scheduleNext();
  });

  return {
    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight) {
        await inFlight;
      }
    },
    isRunning() {
      return running;
    },
    processedCount() {
      return processed;
    }
  };
}

export class FinOpsBudgetTracker {
  private readonly usageByScope = new Map<string, number>();

  constructor(private readonly dailyTokenLimit = 100_000) {}

  recordTokens(tenantId: string, projectId: string, tokens: number): { allowed: boolean; used: number; limit: number } {
    const key = `${tenantId}:${projectId}`;
    const next = (this.usageByScope.get(key) ?? 0) + tokens;
    this.usageByScope.set(key, next);
    return { allowed: next <= this.dailyTokenLimit, used: next, limit: this.dailyTokenLimit };
  }

  getUsed(tenantId: string, projectId: string): number {
    return this.usageByScope.get(`${tenantId}:${projectId}`) ?? 0;
  }
}

export interface RunnerAgentStepRecord {
  step: number;
  action: "tool_call" | "propose";
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
}

function parseRunnerStructuredAction(raw: string):
  | { action: "tool_call"; tool: string; arguments: Record<string, unknown> }
  | { action: "propose"; title?: string; content: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.action === "tool_call" && typeof parsed.tool === "string" && parsed.tool.trim()) {
        const args = parsed.arguments && typeof parsed.arguments === "object" && !Array.isArray(parsed.arguments)
          ? (parsed.arguments as Record<string, unknown>)
          : {};
        return { action: "tool_call", tool: parsed.tool.trim(), arguments: args };
      }
      if (parsed.action === "propose" && typeof parsed.content === "string") {
        return {
          action: "propose",
          title: typeof parsed.title === "string" ? parsed.title : undefined,
          content: parsed.content
        };
      }
    } catch {
      // Fall back to plain-text proposal
    }
  }
  return { action: "propose", content: raw };
}

export async function executeRunnerAgentLoop(
  task: RunnerTask,
  opts: {
    callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
    callModel?: (input: { task: RunnerTask; context: unknown; step?: number; toolHistory?: RunnerAgentStepRecord[] }) => Promise<{ response: string; usage?: ModelUsage }>;
    budgetTracker?: FinOpsBudgetTracker;
    recordBudgetUsage?: (tenantId: string, projectId: string, tokens: number) => Promise<{ allowed: boolean; used: number; limit: number }>;
    confidenceThreshold?: number;
    workspaceCwd?: string;
  }
): Promise<RunnerTask> {
  if (task.status === "escalated") return task;
  task.status = "running";
  let consecutiveFailures = 0;
  let cachedContext: unknown;
  const toolHistory: RunnerAgentStepRecord[] = [];
  let lastResponse = "";

  for (let step = 1; step <= task.maxSteps; step += 1) {
    try {
      if (step === 1 || cachedContext === undefined) {
        cachedContext = await opts.callTool("brain_context_build", {
          projectId: task.projectId,
          task: task.instruction,
          tokenBudget: 3000
        });
        const contextTokens = cachedContext && typeof cachedContext === "object" && "tokenUsage" in cachedContext && Number.isFinite((cachedContext as { tokenUsage?: unknown }).tokenUsage)
          ? Number((cachedContext as { tokenUsage: number }).tokenUsage)
          : 0;
        if ((opts.budgetTracker || opts.recordBudgetUsage) && contextTokens > 0) {
          const budget = opts.recordBudgetUsage
            ? await opts.recordBudgetUsage(task.tenantId, task.projectId, contextTokens)
            : opts.budgetTracker!.recordTokens(task.tenantId, task.projectId, contextTokens);
          if (!budget.allowed) {
            task.status = "escalated";
            task.resultSummary = `Cota de contexto excedida (${budget.used}/${budget.limit} tokens); tarefa escalada.`;
            return task;
          }
        }
      }

      const generated = opts.callModel
        ? await opts.callModel({ task, context: cachedContext, step, toolHistory })
        : { response: JSON.stringify(cachedContext).slice(0, 1000) };
      if (generated.usage) {
        task.modelUsage = generated.usage;
        const stepTokens = generated.usage.totalTokens ?? 0;
        if ((opts.budgetTracker || opts.recordBudgetUsage) && stepTokens > 0) {
          const budget = opts.recordBudgetUsage
            ? await opts.recordBudgetUsage(task.tenantId, task.projectId, stepTokens)
            : opts.budgetTracker!.recordTokens(task.tenantId, task.projectId, stepTokens);
          if (!budget.allowed) {
            task.status = "escalated";
            task.resultSummary = `Cota de tokens excedida no passo ${step} (${budget.used}/${budget.limit} tokens); tarefa escalada.`;
            return task;
          }
        }
      }

      lastResponse = generated.response;
      const parsed = parseRunnerStructuredAction(generated.response);
      if (parsed.action === "tool_call" && step < task.maxSteps) {
        let toolResult: unknown;
        if (parsed.tool === "run_sandboxed_command") {
          if (task.draftOnly) {
            toolResult = { blocked: true, reason: "draftOnly=true não permite execução de comandos." };
          } else {
            const cmd = String(parsed.arguments.command ?? "");
            toolResult = await runSandboxedCommand(cmd, opts.workspaceCwd ?? process.cwd());
          }
        } else {
          toolResult = await opts.callTool(parsed.tool, { projectId: task.projectId, ...parsed.arguments });
        }
        toolHistory.push({ step, action: "tool_call", tool: parsed.tool, arguments: parsed.arguments, result: toolResult });
        consecutiveFailures = 0;
        continue;
      }

      const proposalTitle = parsed.action === "propose" && parsed.title
        ? parsed.title.slice(0, 120)
        : `[bot-draft] ${task.instruction.slice(0, 80)}`;
      const proposalContent = (parsed.action === "propose" ? parsed.content : lastResponse).slice(0, 8000);
      await opts.callTool("brain_change_propose", {
        projectId: task.projectId,
        title: proposalTitle,
        content: proposalContent
      });
      task.status = "completed";
      task.resultSummary = `[bot-draft] Concluído no passo ${step}/${task.maxSteps} (${toolHistory.length} tool call(s)).`;
      return task;
    } catch (err) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2 || step === task.maxSteps) {
        task.status = "escalated";
        task.resultSummary = `Escalado após ${consecutiveFailures} falha(s): ${err instanceof Error ? err.message : String(err)}`;
        return task;
      }
    }
  }
  return task;
}

