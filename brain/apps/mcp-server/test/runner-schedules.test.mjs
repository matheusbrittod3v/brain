import assert from "node:assert/strict";
import test from "node:test";
import { cancelRunnerSchedule, createRunnerSchedule, listRunnerSchedules } from "../dist/runner-schedules.js";

class FakeBoss {
  static instances = [];
  schedules = [];
  deletedQueues = [];
  stopped = false;

  constructor() { FakeBoss.instances.push(this); }
  async start() {}
  async stop() { this.stopped = true; }
  async createQueue(name) { this.createdQueue = name; }
  async schedule(name, cron, data, options) {
    if (cron === "invalid") throw new Error("invalid cron");
    this.schedules.push({ name, cron, data, options });
  }
  async getSchedules() { return this.schedules; }
  async unschedule(name) { this.schedules = this.schedules.filter((schedule) => schedule.name !== name); }
  async deleteQueue(name) { this.deletedQueues.push(name); }
}

const scope = { tenantId: "tenant-a", projectId: "project-a" };
const payload = { ...scope, actorId: "actor-a", accessPolicyId: "internal-project", instruction: "Review open PRs", priority: "normal" };

test("createRunnerSchedule validates via pg-boss, cleans failed queues, and persists recurring payload in UTC", async () => {
  FakeBoss.instances = [];
  await assert.rejects(() => createRunnerSchedule(payload, "invalid", "postgres://test", () => new FakeBoss()), /invalid cron/);
  const failed = FakeBoss.instances[0];
  assert.equal(failed.deletedQueues.length, 1);
  assert.equal(failed.stopped, true);

  const scheduleId = await createRunnerSchedule(payload, "0 9 * * 1", "postgres://test", () => new FakeBoss());
  const created = FakeBoss.instances[1];
  assert.match(scheduleId, /^[0-9a-f-]{36}$/i);
  assert.equal(created.schedules[0].cron, "0 9 * * 1");
  assert.equal(created.schedules[0].options.tz, "UTC");
  assert.equal(created.schedules[0].data.scheduleId, scheduleId);
  assert.equal(created.stopped, true);
});

test("listRunnerSchedules filters by tenant and project and cancel refuses cross-project IDs", async () => {
  const boss = new FakeBoss();
  boss.schedules = [
    { name: "brain.runner-schedule-one", cron: "0 9 * * 1", data: { ...payload, scheduleId: "one" } },
    { name: "brain.runner-schedule-two", cron: "0 10 * * 1", data: { ...payload, tenantId: "tenant-b", scheduleId: "two" } },
    { name: "brain.runner-schedule-three", cron: "0 11 * * 1", data: { ...payload, projectId: "project-b", scheduleId: "three" } }
  ];
  const factory = () => boss;
  assert.deepEqual(await listRunnerSchedules(scope, "postgres://test", factory), [
    { scheduleId: "one", cron: "0 9 * * 1", instruction: "Review open PRs", priority: "normal" }
  ]);
  assert.equal(await cancelRunnerSchedule(scope, "two", "postgres://test", factory), false);
  assert.deepEqual(boss.deletedQueues, []);
  assert.equal(await cancelRunnerSchedule(scope, "one", "postgres://test", factory), true);
  assert.deepEqual(boss.deletedQueues, ["brain.runner-schedule-one"]);
});
