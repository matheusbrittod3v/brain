import { randomUUID } from "node:crypto";
import PgBoss from "pg-boss";

export const RUNNER_SCHEDULE_QUEUE_PREFIX = "brain.runner-schedule-";

export interface RunnerSchedulePayload {
  scheduleId?: string;
  tenantId: string;
  projectId: string;
  actorId: string;
  accessPolicyId: string;
  instruction: string;
  priority: "low" | "normal" | "high";
  maxSteps?: number;
  timeoutSeconds?: number;
}

interface RunnerScheduleRecord {
  name: string;
  cron: string;
  data?: Record<string, unknown>;
}

export interface RunnerScheduleBoss {
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  createQueue(name: string): Promise<unknown>;
  schedule(name: string, cron: string, data: object, options?: { tz?: string }): Promise<unknown>;
  getSchedules(): Promise<RunnerScheduleRecord[]>;
  unschedule(name: string): Promise<unknown>;
  deleteQueue(name: string): Promise<unknown>;
}

type RunnerScheduleBossFactory = (databaseUrl: string) => RunnerScheduleBoss;

const createPgBoss = (databaseUrl: string) => new PgBoss(databaseUrl) as unknown as RunnerScheduleBoss;

function queueName(scheduleId: string): string {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(scheduleId)) throw new Error("scheduleId inválido.");
  return `${RUNNER_SCHEDULE_QUEUE_PREFIX}${scheduleId}`;
}

export async function createRunnerSchedule(
  payload: RunnerSchedulePayload,
  cron: string,
  databaseUrl: string,
  bossFactory: RunnerScheduleBossFactory = createPgBoss
): Promise<string> {
  const scheduleId = randomUUID();
  const name = queueName(scheduleId);
  const boss = bossFactory(databaseUrl);
  let queueCreated = false;
  await boss.start();
  try {
    await boss.createQueue(name);
    queueCreated = true;
    await boss.schedule(name, cron, { ...payload, scheduleId }, { tz: "UTC" });
    return scheduleId;
  } catch (error) {
    if (queueCreated) await boss.deleteQueue(name).catch(() => undefined);
    throw error;
  } finally {
    await boss.stop();
  }
}

export async function listRunnerSchedules(
  scope: { tenantId: string; projectId: string },
  databaseUrl: string,
  bossFactory: RunnerScheduleBossFactory = createPgBoss
): Promise<Array<{ scheduleId: string; cron: string; instruction: string; priority: string }>> {
  const boss = bossFactory(databaseUrl);
  await boss.start();
  try {
    const schedules = await boss.getSchedules();
    return schedules
      .filter((schedule) => schedule.name.startsWith(RUNNER_SCHEDULE_QUEUE_PREFIX))
      .filter((schedule) => schedule.data?.tenantId === scope.tenantId && schedule.data?.projectId === scope.projectId)
      .map((schedule) => ({
        scheduleId: String(schedule.data?.scheduleId ?? schedule.name.slice(RUNNER_SCHEDULE_QUEUE_PREFIX.length)),
        cron: schedule.cron,
        instruction: String(schedule.data?.instruction ?? ""),
        priority: String(schedule.data?.priority ?? "normal")
      }))
      .sort((a, b) => a.scheduleId.localeCompare(b.scheduleId));
  } finally {
    await boss.stop();
  }
}

export async function cancelRunnerSchedule(
  scope: { tenantId: string; projectId: string },
  scheduleId: string,
  databaseUrl: string,
  bossFactory: RunnerScheduleBossFactory = createPgBoss
): Promise<boolean> {
  const name = queueName(scheduleId);
  const boss = bossFactory(databaseUrl);
  await boss.start();
  try {
    const schedule = (await boss.getSchedules()).find((entry) => entry.name === name);
    if (schedule?.data?.tenantId !== scope.tenantId || schedule.data?.projectId !== scope.projectId) return false;
    await boss.unschedule(name);
    await boss.deleteQueue(name);
    return true;
  } finally {
    await boss.stop();
  }
}
