import type { HumanOpsChannel } from "@noema/connector-saas";

export const notificationCategories = ["approval", "runner_question"] as const;
export type NotificationCategory = (typeof notificationCategories)[number];
export interface NotificationPreferences {
  channels: HumanOpsChannel[];
  categories: NotificationCategory[];
  frequency: "immediate" | "daily" | "weekly";
}

const notificationChannels: HumanOpsChannel[] = ["slack", "teams", "jira", "clickup", "email"];

export function defaultNotificationPreferences(): NotificationPreferences {
  return { channels: [...notificationChannels], categories: [...notificationCategories], frequency: "immediate" };
}

export function normalizeNotificationPreferences(value: unknown): NotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preferences must be an object.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.channels) || input.channels.some((item) => typeof item !== "string" || !notificationChannels.includes(item as HumanOpsChannel))) {
    throw new Error("Invalid notification channel preference.");
  }
  if (!Array.isArray(input.categories) || input.categories.some((item) => typeof item !== "string" || !notificationCategories.includes(item as NotificationCategory))) {
    throw new Error("Invalid notification category preference.");
  }
  if (input.frequency !== "immediate" && input.frequency !== "daily" && input.frequency !== "weekly") throw new Error("Invalid notification frequency.");
  return {
    channels: [...new Set(input.channels as HumanOpsChannel[])],
    categories: [...new Set(input.categories as NotificationCategory[])],
    frequency: input.frequency
  };
}

export function nextNotificationWindow(frequency: "daily" | "weekly", now: Date, utcHour = 9): Date {
  if (!Number.isInteger(utcHour) || utcHour < 0 || utcHour > 23) throw new Error("Digest UTC hour must be between 0 and 23.");
  const target = new Date(now);
  target.setUTCHours(utcHour, 0, 0, 0);
  if (frequency === "daily") {
    if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
    return target;
  }
  const daysUntilMonday = (8 - now.getUTCDay()) % 7;
  target.setUTCDate(target.getUTCDate() + daysUntilMonday);
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 7);
  return target;
}

export function notificationPreferenceAllows(
  preferences: NotificationPreferences,
  channel: HumanOpsChannel,
  category: NotificationCategory
): boolean {
  return preferences.channels.includes(channel) && preferences.categories.includes(category);
}

export function notificationDigestGroupKey(input: {
  tenantId: string; projectId: string; actorId: string; accessPolicyId: string;
  channel: HumanOpsChannel; category: NotificationCategory; scheduledAt: Date;
}): string {
  return [input.tenantId, input.projectId, input.actorId, input.accessPolicyId, input.channel, input.category, input.scheduledAt.toISOString()].join(":");
}
