import PgBoss from "pg-boss";
import type { AuthContext } from "@brain/auth";
import {
  createAppPostgresClient,
  createDatabaseClient,
  PgKnowledgeRepository,
  PgOperationalRepository
} from "@brain/database";
import { createPostgresGraphStore } from "@brain/graph";
import { initTelemetry, startSpan } from "@brain/observability";
import {
  enqueueEmbedJob,
  fetchOllamaEmbedding,
  materializeScheduledRunnerTask,
  persistWorkerAudit,
  probeOllamaEmbeddingProvider,
  processEmbedJob,
  refreshRunnerScheduleWorkers,
  type ApprovalReminderJobPayload,
  type EmbedJobPayload,
  type OllamaEmbeddingProviderStatus,
  type RunnerScheduleJobPayload
} from "./embeddings.js";
import {
  processGitIngestJob,
  type GitIngestJobPayload,
  type GitIngestOptions,
  type WorkerGraphEdgeInput,
  type WorkerGraphStore,
  type WorkerKnowledgeRepo
} from "./git-ingest.js";
import { startWorkerRunnerDaemon } from "./runner-daemon.js";

export {
  enqueueEmbedJob,
  fetchOllamaEmbedding,
  materializeScheduledRunnerTask,
  probeOllamaEmbeddingProvider,
  processEmbedJob,
  processGitIngestJob,
  refreshRunnerScheduleWorkers,
  type ApprovalReminderJobPayload,
  type EmbedJobPayload,
  type GitIngestJobPayload,
  type GitIngestOptions,
  type OllamaEmbeddingProviderStatus,
  type RunnerScheduleJobPayload,
  type WorkerGraphEdgeInput,
  type WorkerGraphStore,
  type WorkerKnowledgeRepo
};

export interface WorkerShutdownRuntime {
  stopAccepting: () => void | Promise<void>;
  stopQueue: () => void | Promise<void>;
  closeConnections: () => void | Promise<void>;
}

export function createWorkerShutdown(runtime: WorkerShutdownRuntime): (signal: string) => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;
  return (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [runtime.stopAccepting, runtime.stopQueue, runtime.closeConnections]) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        const reasons = errors.map((error) => error instanceof Error ? error.message : String(error));
        throw new AggregateError(errors, `Worker shutdown after ${signal} had cleanup failures: ${reasons.join("; ")}`);
      }
    })();
    return shutdownPromise;
  };
}

export async function startWorker(
  databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL,
  appDatabaseUrl = process.env.DATABASE_URL ?? databaseUrl
) {
  if (!databaseUrl) throw new Error("DATABASE_SYSTEM_URL ou DATABASE_URL obrigatória para iniciar @brain/worker.");
  initTelemetry("brain-worker");
  const pgBossSchema = process.env.BRAIN_PG_BOSS_SCHEMA ?? "pgboss";
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(pgBossSchema)) {
    throw new Error("BRAIN_PG_BOSS_SCHEMA must be a valid SQL identifier.");
  }
  const quotedPgBossSchema = `"${pgBossSchema}"`;
  const boss = new PgBoss({ connectionString: databaseUrl, schema: pgBossSchema });
  const { client: systemSql, db } = createDatabaseClient(databaseUrl);
  const appClient = createAppPostgresClient({ databaseUrl: appDatabaseUrl });
  const repo = new PgKnowledgeRepository(db);
  const opRepo = new PgOperationalRepository(db);

  await boss.start();
  const { client: workerSql } = createDatabaseClient(databaseUrl);
  try {
    await workerSql.unsafe(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'brain_app') THEN
          BEGIN
            GRANT USAGE ON SCHEMA ${quotedPgBossSchema} TO brain_app;
            GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quotedPgBossSchema} TO brain_app;
            GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${quotedPgBossSchema} TO brain_app;
          EXCEPTION WHEN insufficient_privilege THEN
            NULL;
          END;
        END IF;
      END $$;
    `);
  } finally {
    await workerSql.end();
  }
  const runnerScheduleConsumers = new Set<string>();
  const refreshRunnerConsumers = () => refreshRunnerScheduleWorkers(boss, opRepo, runnerScheduleConsumers);
  await refreshRunnerConsumers();
  const runnerScheduleRefresh = setInterval(() => {
    void refreshRunnerConsumers().catch((error) => {
      console.error(JSON.stringify({
        event: "runner_schedule_discovery_failed",
        error: error instanceof Error ? error.message : String(error)
      }));
    });
  }, 30_000);
  runnerScheduleRefresh.unref();
  await boss.createQueue("brain.embed-item");
  await boss.work<EmbedJobPayload>("brain.embed-item", async (jobs) => {
    for (const job of jobs) {
      const span = startSpan("worker.embed_item");
      try {
        const result = await processEmbedJob(job.data, repo, undefined, (event, ctx) => persistWorkerAudit(appClient, event, ctx));
        return result;
      } finally {
        span.end({ projectId: job.data.projectId, itemId: job.data.itemId });
      }
    }
  });

  await boss.createQueue("brain.ingest-git");
  await boss.work<GitIngestJobPayload>("brain.ingest-git", { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      const graphStore = createPostgresGraphStore(appClient, {
        tenantId: job.data.tenantId,
        allowedProjects: [job.data.projectId],
        allowedPolicies: [...new Set([job.data.accessPolicyId ?? "internal-project", "restricted-security"])]
      });
      const result = await processGitIngestJob(job.data, repo, {
        graphStore,
        gitState: opRepo,
        retireGitSources: repo.retireGitSources.bind(repo),
        retireGitSourcesExcept: repo.retireGitSourcesExcept.bind(repo),
        retireScipSymbolsExcept: repo.retireScipSymbolsExcept.bind(repo),
        enqueueEmbed: async (embedPayload) => { await boss.send("brain.embed-item", embedPayload); },
        auditFn: (event, ctx) => persistWorkerAudit(appClient, event, ctx),
        onFileError: (filePath, error) => {
          console.error(JSON.stringify({
            event: "git_ingest_file_failed",
            projectId: job.data.projectId,
            filePath,
            error: error instanceof Error ? error.message : String(error)
          }));
        }
      });
      console.log(JSON.stringify({
        event: "git_ingest_completed",
        jobId: job.id,
        projectId: job.data.projectId,
        source: job.data.owner && job.data.repo ? `${job.data.owner}/${job.data.repo}` : "local",
        commitSha: result.sourceCommitSha,
        ...result
      }));
      return result;
    }
  });

  await boss.createQueue("brain.memory-decay");
  await boss.schedule("brain.memory-decay", "0 * * * *", {
    tenantId: process.env.BRAIN_TENANT_ID ?? "default-org",
    projectId: process.env.BRAIN_PROJECT_ID ?? "default",
    accessPolicyId: "internal-project"
  });
  await boss.work<{ tenantId: string; projectId: string; accessPolicyId: string }>(
    "brain.memory-decay",
    async (jobs) => {
      for (const job of jobs) {
        const ctx: AuthContext = {
          tenantId: job.data.tenantId,
          actorId: "brain-worker",
          actorType: "system",
          roles: ["system"],
          allowedProjects: [job.data.projectId],
          allowedPolicies: [job.data.accessPolicyId]
        };
        const result = await opRepo.runMemoryDecay(ctx);
        await persistWorkerAudit(appClient, {
          tenantId: job.data.tenantId,
          projectId: job.data.projectId,
          accessPolicyId: job.data.accessPolicyId,
          actorId: ctx.actorId,
          actorType: ctx.actorType,
          action: "decay",
          targetType: "memory_decay",
          targetId: job.id,
          metadata: { source: "memory_decay", ...result }
        }, ctx);
        return result;
      }
    }
  );

  await boss.createQueue("brain.approval-reminder");
  await boss.work<ApprovalReminderJobPayload>("brain.approval-reminder", async (jobs) => {
    for (const job of jobs) {
      const payload = job.data;
      const ctx: AuthContext = { tenantId: payload.tenantId, actorId: "brain-worker", actorType: "system", roles: ["system"], allowedProjects: [payload.projectId], allowedPolicies: [payload.accessPolicyId] };
      const recorded = await opRepo.recordApprovalReminder(ctx, {
        projectId: payload.projectId,
        proposalId: payload.proposalId,
        accessPolicyId: payload.accessPolicyId,
        dueAt: new Date(payload.dueAt),
        eventType: payload.eventType
      });
      await persistWorkerAudit(appClient, {
        tenantId: payload.tenantId,
        projectId: payload.projectId,
        accessPolicyId: payload.accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: payload.eventType,
        targetType: "approval_reminder",
        targetId: payload.proposalId,
        metadata: { source: "approval_reminder", dueAt: payload.dueAt, inserted: recorded }
      }, ctx);
      return { recorded };
    }
  });

  startWorkerRunnerDaemon(opRepo);

  const shutdown = createWorkerShutdown({
    stopAccepting: () => clearInterval(runnerScheduleRefresh),
    stopQueue: () => boss.stop({ graceful: true, timeout: 30_000, wait: true }),
    closeConnections: async () => {
      const closeResults = await Promise.allSettled([
        systemSql.end({ timeout: 5 }),
        appClient.close({ timeoutSeconds: 5 })
      ]);
      const closeErrors = closeResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (closeErrors.length > 0) throw new AggregateError(closeErrors, "Worker PostgreSQL client shutdown failed.");
    }
  });
  const handleSignal = (signal: NodeJS.Signals) => {
    process.off("SIGTERM", handleSigterm);
    process.off("SIGINT", handleSigint);
    console.log(JSON.stringify({ event: "worker_shutdown_started", signal }));
    void shutdown(signal).then(() => {
      process.stdout.write(`${JSON.stringify({ event: "worker_shutdown_completed", signal })}\n`, () => process.exit(0));
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${JSON.stringify({ event: "worker_shutdown_failed", signal, error: message })}\n`, () => process.exit(1));
    });
  };
  const handleSigterm = () => handleSignal("SIGTERM");
  const handleSigint = () => handleSignal("SIGINT");
  process.once("SIGTERM", handleSigterm);
  process.once("SIGINT", handleSigint);

  return boss;
}

if (process.argv[1]?.endsWith("index.js")) {
  startWorker().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
