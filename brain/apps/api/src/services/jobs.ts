import { isAbsolute, resolve } from "node:path";
import PgBoss from "pg-boss";
import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";

export function mapExternalHumanActor(
  serviceContext: AuthContext,
  provider: string,
  externalUserId: string,
  projectId: string,
  accessPolicyId: string,
  actorType: "human" | "system" = "human"
): AuthContext {
  const raw = process.env.BRAIN_EXTERNAL_ACTOR_MAP_JSON;
  if (!raw) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Mapeamento de identidade externa não está configurado.", 401);
  }
  let config: unknown;
  try {
    config = JSON.parse(raw) as unknown;
  } catch {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "BRAIN_EXTERNAL_ACTOR_MAP_JSON contém JSON inválido.", 401);
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const providerMap = isRecord(config) ? config[provider] : undefined;
  const entry = (isRecord(providerMap) ? providerMap[externalUserId] : undefined) as
    | { actorId?: unknown; tenantId?: unknown; roles?: unknown; projectIds?: unknown; policyIds?: unknown }
    | undefined;
  const stringArray = (value: unknown): value is string[] =>
    Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
  if (
    !entry ||
    typeof entry.actorId !== "string" ||
    entry.actorId.length === 0 ||
    entry.tenantId !== serviceContext.tenantId ||
    !stringArray(entry.roles) ||
    !stringArray(entry.projectIds) ||
    !stringArray(entry.policyIds) ||
    !entry.projectIds.includes(projectId) ||
    !entry.policyIds.includes(accessPolicyId) ||
    !serviceContext.allowedProjects.includes(projectId)
  ) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Identidade externa não mapeada para este tenant, projeto e política.", 403);
  }
  return {
    ...serviceContext,
    actorId: entry.actorId,
    actorType,
    roles: entry.roles,
    allowedProjects: [projectId],
    allowedPolicies: entry.policyIds
  };
}

export async function enqueueRemoteGitIngestJob(payload: {
  tenantId: string;
  projectId: string;
  accessPolicyId: string;
  owner: string;
  repo: string;
  ref: string;
  branch?: string;
  beforeCommitSha?: string;
}): Promise<string | null> {
  const databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("brain.ingest-git");
  const jobId = await boss.send("brain.ingest-git", payload);
  await boss.stop();
  return jobId;
}

export function resolveGitHubRepoMapping(fullName: string): { tenantId: string; projectId: string; accessPolicyId: string } | undefined {
  const raw = process.env.BRAIN_GITHUB_REPO_MAP_JSON;
  if (!raw) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(raw) as unknown;
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_GITHUB_REPO_MAP_JSON contém JSON inválido.", 503);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_GITHUB_REPO_MAP_JSON deve ser um objeto repo→escopo.", 503);
  }
  const normalized = fullName.toLowerCase();
  const entry = Object.entries(config as Record<string, unknown>).find(([repo]) => repo.toLowerCase() === normalized)?.[1];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const mapping = entry as Record<string, unknown>;
  if ([mapping.tenantId, mapping.projectId, mapping.accessPolicyId].some((value) => typeof value !== "string" || !value.trim())) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", `Mapeamento GitHub inválido para ${fullName}.`, 503);
  }
  return {
    tenantId: mapping.tenantId as string,
    projectId: mapping.projectId as string,
    accessPolicyId: mapping.accessPolicyId as string
  };
}

export function configuredGitHubRepositories(tenantId: string, projectId: string): string[] {
  const raw = process.env.BRAIN_GITHUB_REPO_MAP_JSON;
  if (!raw) return [];
  let config: unknown;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_GITHUB_REPO_MAP_JSON contém JSON inválido.", 503);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_GITHUB_REPO_MAP_JSON deve ser um objeto repo→escopo.", 503);
  }
  return Object.entries(config as Record<string, unknown>).flatMap(([repository, value]) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const mapping = value as Record<string, unknown>;
    return mapping.tenantId === tenantId && mapping.projectId === projectId ? [repository.toLowerCase()] : [];
  });
}

export async function enqueueApprovalReminders(
  request: { tenantId: string; projectId: string; proposalId: string; item: { accessPolicyId: string }; dueAt: string },
  databaseUrl = process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL
): Promise<void> {
  if (!databaseUrl) return;
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  await boss.createQueue("brain.approval-reminder");
  const dueAt = new Date(request.dueAt);
  const leadMs = Number(process.env.BRAIN_APPROVAL_REMINDER_LEAD_HOURS ?? 24) * 3_600_000;
  const reminderAt = new Date(Math.max(Date.now(), dueAt.getTime() - leadMs));
  const payload = {
    tenantId: request.tenantId,
    projectId: request.projectId,
    proposalId: request.proposalId,
    accessPolicyId: request.item.accessPolicyId,
    dueAt: request.dueAt
  };
  await boss.send(
    "brain.approval-reminder",
    { ...payload, eventType: "reminder" },
    { startAfter: reminderAt, singletonKey: `${request.tenantId}:${request.projectId}:${request.proposalId}:reminder:${request.dueAt}` }
  );
  await boss.send(
    "brain.approval-reminder",
    { ...payload, eventType: "escalation" },
    { startAfter: dueAt, singletonKey: `${request.tenantId}:${request.projectId}:${request.proposalId}:escalation:${request.dueAt}` }
  );
  await boss.stop();
}

export function configuredProjectScope(): string[] {
  return [...new Set((process.env.BRAIN_ALLOWED_PROJECTS ?? "").split(",").map((projectId) => projectId.trim()).filter(Boolean))];
}

export function configuredPolicyScope(): string[] {
  const configured = process.env.BRAIN_ALLOWED_POLICIES;
  if (configured === undefined) return ["public-org", "internal-project", "confidential-business"];
  return [...new Set(configured.split(",").map((policyId) => policyId.trim()).filter(Boolean))];
}

export function configuredWorkspaceRoot(projectId: string): string {
  const raw = process.env.BRAIN_PROJECT_WORKSPACE_ROOTS?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_PROJECT_WORKSPACE_ROOTS must be valid JSON.", 503);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_PROJECT_WORKSPACE_ROOTS must map project IDs to absolute paths.", 503);
    }
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.some(([id, root]) => !id.trim() || typeof root !== "string" || !isAbsolute(root))) {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "BRAIN_PROJECT_WORKSPACE_ROOTS must map project IDs to absolute paths.", 503);
    }
    const projectRoot = (parsed as Record<string, string>)[projectId];
    if (projectRoot) return resolve(projectRoot);
  }
  return resolve(process.env.BRAIN_WORKSPACE_ROOT ?? process.cwd());
}

export function normalizeAuditLogRow(row: Record<string, unknown>) {
  const value = (camel: string, snake = camel) => row[camel] ?? row[snake];
  return {
    id: String(value("id") ?? `${String(value("createdAt", "created_at") ?? "")}:${String(value("actorId", "actor_id") ?? "")}:${String(value("targetId", "target_id") ?? "")}`),
    projectId: String(value("projectId", "project_id") ?? ""),
    actorId: String(value("actorId", "actor_id") ?? ""),
    actorType: String(value("actorType", "actor_type") ?? ""),
    accessPolicyId: String(value("accessPolicyId", "access_policy_id") ?? ""),
    action: String(value("action") ?? ""),
    targetType: String(value("targetType", "target_type") ?? ""),
    targetId: value("targetId", "target_id") == null ? null : String(value("targetId", "target_id")),
    createdAt: String(value("createdAt", "created_at") ?? "")
  };
}
