import test from "node:test";
import assert from "node:assert/strict";
import { defaultNotificationPreferences, normalizeNotificationPreferences, notificationPreferenceAllows, nextNotificationWindow, notificationDigestGroupKey } from "../dist/src/notification-preferences.js";

test("notification preferences default to the current delivery behavior", () => {
  const preferences = defaultNotificationPreferences();
  assert.equal(notificationPreferenceAllows(preferences, "slack", "approval"), true);
  assert.equal(notificationPreferenceAllows(preferences, "email", "runner_question"), true);
});

test("notification preferences suppress channels and categories that a person disabled", () => {
  const preferences = normalizeNotificationPreferences({
    channels: ["slack"], categories: ["approval"], frequency: "immediate"
  });
  assert.equal(notificationPreferenceAllows(preferences, "slack", "approval"), true);
  assert.equal(notificationPreferenceAllows(preferences, "email", "approval"), false);
  assert.equal(notificationPreferenceAllows(preferences, "slack", "runner_question"), false);
});

test("notification preferences reject unknown channels, categories, and frequencies", () => {
  assert.throws(() => normalizeNotificationPreferences({ channels: ["carrier_pigeon"], categories: ["approval"], frequency: "immediate" }), /channel/i);
  assert.throws(() => normalizeNotificationPreferences({ channels: [], categories: [], frequency: "monthly" }), /frequency/i);
  assert.equal(normalizeNotificationPreferences({ channels: [], categories: ["approval"], frequency: "weekly" }).frequency, "weekly");
});

test("daily and weekly preferences schedule one next digest window in UTC", () => {
  const afterDailyCutoff = nextNotificationWindow("daily", new Date("2026-11-17T10:00:00.000Z"));
  assert.equal(afterDailyCutoff.toISOString(), "2026-11-18T09:00:00.000Z");
  const weekly = nextNotificationWindow("weekly", new Date("2026-11-17T10:00:00.000Z"));
  assert.equal(weekly.toISOString(), "2026-11-23T09:00:00.000Z");
});

test("digest grouping separates actors and combines items for the same delivery window", () => {
  const shared = { tenantId: "t", projectId: "p", accessPolicyId: "internal", channel: "slack", category: "approval", scheduledAt: new Date("2026-11-23T09:00:00.000Z") };
  assert.equal(notificationDigestGroupKey({ ...shared, actorId: "a" }), notificationDigestGroupKey({ ...shared, actorId: "a" }));
  assert.notEqual(notificationDigestGroupKey({ ...shared, actorId: "a" }), notificationDigestGroupKey({ ...shared, actorId: "b" }));
});
