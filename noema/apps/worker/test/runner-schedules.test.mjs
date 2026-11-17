import assert from "node:assert/strict";
import test from "node:test";
import { materializeScheduledRunnerTask, refreshRunnerScheduleWorkers } from "../dist/src/index.js";

test("scheduled Runner firings use deterministic task IDs and retain trusted scope", async () => {
  const saved = [];
  const result = await materializeScheduledRunnerTask({
    scheduleId: "schedule-1", tenantId: "tenant-a", projectId: "project-a", actorId: "actor-a",
    accessPolicyId: "internal-project", instruction: "Review open PRs", priority: "high"
  }, "pgboss-job-1", {
    async saveScheduledRunnerTask(ctx, task) { saved.push({ ctx, task }); }
  });
  assert.equal(result.taskId, "RUN-pgboss-job-1");
  assert.equal(saved[0].ctx.tenantId, "tenant-a");
  assert.equal(saved[0].ctx.actorId, "actor-a");
  assert.deepEqual(saved[0].ctx.allowedProjects, ["project-a"]);
  assert.deepEqual(saved[0].ctx.allowedPolicies, ["internal-project"]);
  assert.equal(saved[0].task.priority, "high");
});

test("worker discovers new cron queues, registers consumers, and unregisters cancelled schedules", async () => {
  const callbacks = new Map();
  const offWorkCalls = [];
  const boss = {
    schedules: [{ name: "noema.runner-schedule-s1", data: {} }],
    async getSchedules() { return this.schedules; },
    async work(name, _options, callback) { callbacks.set(name, callback); },
    async offWork(name) { offWorkCalls.push(name); callbacks.delete(name); }
  };
  const registered = await refreshRunnerScheduleWorkers(boss, { async saveScheduledRunnerTask() {} });
  assert.ok(registered.has("noema.runner-schedule-s1"));
  assert.equal(callbacks.has("noema.runner-schedule-s1"), true);

  boss.schedules = [];
  await refreshRunnerScheduleWorkers(boss, { async saveScheduledRunnerTask() {} }, registered);
  assert.deepEqual(offWorkCalls, ["noema.runner-schedule-s1"]);
  assert.equal(registered.size, 0);
});
