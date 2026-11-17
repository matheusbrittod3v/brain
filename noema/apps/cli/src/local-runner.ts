import {
  startRunnerDaemon,
  executeRunnerTaskWithOllama,
  type RunnerDaemonOptions,
  type RunnerDaemonTaskSource,
  type RunnerDaemonHandle
} from "@noema/agent-runner";
import type { EdgeDatabase } from "./edge-db.js";

export function createEdgeRunnerTaskSource(db: EdgeDatabase): RunnerDaemonTaskSource {
  return {
    claimNextRunnerTask(projectId) {
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
    executeTask?: RunnerDaemonOptions["executeTask"];
  } = {}
): RunnerDaemonHandle {
  const { model, ...daemonOptions } = options;
  return startRunnerDaemon({
    ...daemonOptions,
    taskSource: createEdgeRunnerTaskSource(db),
    ...(options.executeTask ? {} : {
      executeTask: (task) => executeRunnerTaskWithOllama(task, process.env.OLLAMA_BASE_URL, model)
    })
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
