import {
  startRunnerDaemon,
  executeRunnerTaskHybrid,
  executeRunnerTaskWithAnthropic,
  executeRunnerTaskWithAppleFm,
  executeRunnerTaskWithOllama,
  executeRunnerTaskWithOpenAI,
  type RunnerDaemonOptions,
  type RunnerDaemonTaskSource,
  type RunnerDaemonHandle
} from "@noema/agent-runner";
import type { EdgeDatabase } from "./edge-db.js";

export function createEdgeRunnerTaskSource(db: EdgeDatabase): RunnerDaemonTaskSource {
  return {
    claimNextRunnerTask(projectId) {
      db.claimDueCronJobs();
      const task = db.claimNextRunnerTask(projectId);
      return task ? { taskId: task.taskId, projectId: task.projectId, instruction: task.instruction } : undefined;
    },
    completeRunnerTask(taskId, status, resultSummary, metadata) {
      const usage = metadata?.modelUsage;
      db.completeRunnerTask(taskId, status, resultSummary, usage && typeof usage === "object"
        ? usage as Record<string, unknown>
        : undefined);
    }
  };
}

export function startEdgeRunner(
  db: EdgeDatabase,
  options: Omit<RunnerDaemonOptions, "taskSource" | "executeTask"> & {
    model?: string;
    provider?: "ollama" | "apple-fm" | "openai" | "anthropic";
    hybrid?: boolean;
    executeTask?: RunnerDaemonOptions["executeTask"];
  } = {}
): RunnerDaemonHandle {
  const { model, provider, hybrid, ...daemonOptions } = options;
  const resolveExecutor = (): RunnerDaemonOptions["executeTask"] => {
    if (hybrid) {
      const localProvider = provider === "apple-fm" ? "apple-fm" : "ollama";
      const cloudProvider = provider === "anthropic" ? "anthropic" : "openai";
      return (task) =>
        executeRunnerTaskHybrid(task, {
          localProvider,
          cloudProvider,
          ollamaModel: model,
          cloudOpts: model ? { model } : undefined
        });
    }
    if (provider === "apple-fm") return (task) => executeRunnerTaskWithAppleFm(task);
    if (provider === "openai") return (task) => executeRunnerTaskWithOpenAI(task, model ? { model } : {});
    if (provider === "anthropic") return (task) => executeRunnerTaskWithAnthropic(task, model ? { model } : {});
    return (task) => executeRunnerTaskWithOllama(task, process.env.OLLAMA_BASE_URL, model);
  };
  return startRunnerDaemon({
    ...daemonOptions,
    taskSource: createEdgeRunnerTaskSource(db),
    ...(options.executeTask ? {} : { executeTask: resolveExecutor() })
  });
}

export interface RunnerSignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  removeListener(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export async function waitForRunnerShutdown(
  runner: RunnerDaemonHandle,
  signals: RunnerSignalSource = process
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signals.removeListener("SIGINT", stop);
      signals.removeListener("SIGTERM", stop);
      void runner.stop().then(resolve, reject);
    };
    signals.once("SIGINT", stop);
    signals.once("SIGTERM", stop);
  });
}
