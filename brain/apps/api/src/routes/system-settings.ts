import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { authenticateRequest, type AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgSystemSettingsRepository } from "@brain/database";

export function registerSystemSettingsRoutes(
  app: FastifyInstance,
  deps: {
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
    systemSettingsRepo?: PgSystemSettingsRepository;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  }
): void {
  const authOnly = (headerValue: string | undefined) =>
    authenticateRequest(headerValue, deps.configuredApiKey, "default-org", deps.allowedProjects, undefined, deps.allowedPolicies);

  app.get<{ Querystring: { category?: string } }>("/v1/system/settings", async (req) => {
    const ctx = await authOnly(req.headers.authorization);
    if (!deps.systemSettingsRepo) return { items: [] };
    const items = await deps.systemSettingsRepo.listSettings(ctx.tenantId, req.query.category, true);
    return { items };
  });

  app.put<{
    Body: { category: string; key: string; value: unknown; isSecret?: boolean };
  }>("/v1/system/settings", async (req) => {
    const ctx = await authOnly(req.headers.authorization);
    if (!ctx.roles.some((r) => ["admin", "owner", "tech-lead"].includes(r.toLowerCase()))) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Apenas administradores podem alterar configurações globais.", 403);
    }
    if (!deps.systemSettingsRepo) {
      throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "PgSystemSettingsRepository indisponível.", 503);
    }
    const { category, key, value, isSecret } = req.body ?? {};
    if (!category?.trim() || !key?.trim()) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "category e key são obrigatórios.", 400);
    }
    const saved = await deps.systemSettingsRepo.upsertSetting(
      ctx.tenantId,
      category.trim(),
      key.trim(),
      value,
      Boolean(isSecret),
      ctx.actorId
    );
    await deps.recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: ctx.allowedProjects[0] || "brain",
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "update",
      targetType: "system_setting",
      targetId: `${category}.${key}`,
      metadata: { isSecret: Boolean(isSecret) }
    }).catch(() => {});
    return { saved: { ...saved, value: saved.isSecret ? "••••••••" : saved.value } };
  });

  app.delete<{ Params: { category: string; key: string } }>("/v1/system/settings/:category/:key", async (req) => {
    const ctx = await authOnly(req.headers.authorization);
    if (!ctx.roles.some((r) => ["admin", "owner"].includes(r.toLowerCase()))) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Apenas administradores podem remover configurações globais.", 403);
    }
    if (!deps.systemSettingsRepo) return { deleted: false };
    const deleted = await deps.systemSettingsRepo.deleteSetting(ctx.tenantId, req.params.category, req.params.key);
    return { deleted };
  });
}
