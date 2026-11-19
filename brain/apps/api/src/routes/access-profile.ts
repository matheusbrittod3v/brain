import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgOperationalRepository } from "@brain/database";

export function registerAccessProfileRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    enforceOpa: (
      ctx: AuthContext,
      resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
    ) => Promise<void>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; limit: number }) => Promise<Array<{ item: { accessPolicyId: string } }>> };
    opRepo?: PgOperationalRepository;
    customPolicyCatalog: Map<string, { policyId: string; label: string; description: string; allowedRoles: string[]; updatedAt: string }>;
    customPolicyKey: (ctx: AuthContext, projectId: string, policyId: string) => string;
    accessMembers: Map<string, { actorId: string; roles: string[]; allowedPolicies: string[]; updatedAt: string; syncedWithKeycloak: boolean }>;
    accessMemberKey: (ctx: AuthContext, projectId: string, actorId: string) => string;
    temporaryGrants: Map<string, {
      grantId: string;
      tenantId: string;
      projectId: string;
      actorId: string;
      roles: string[];
      policyIds: string[];
      createdAt: string;
      expiresAt: string;
      grantedBy: string;
    }>;
  }
) {
  const {
    authenticateProjectRequest,
    enforceOpa,
    recordAudit,
    queryAwareRetrieval,
    opRepo,
    customPolicyCatalog,
    customPolicyKey,
    accessMembers,
    accessMemberKey,
    temporaryGrants
  } = deps;

  const requireAccessAdmin = (ctx: AuthContext) => {
    if (!ctx.roles.some((r) => ["admin", "appsec"].includes(r))) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Gestão administrativa de acesso restrita a admin/appsec.", 403);
    }
  };

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/profile", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const items = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 500 });
    const countByPolicy = new Map<string, number>();
    for (const hit of items) {
      countByPolicy.set(hit.item.accessPolicyId, (countByPolicy.get(hit.item.accessPolicyId) ?? 0) + 1);
    }
    const policyCatalog = [
      { policyId: "public-org", description: "Conhecimento compartilhado em toda a organização.", authorized: ctx.allowedPolicies.includes("public-org"), itemCount: countByPolicy.get("public-org") ?? 0 },
      { policyId: "internal-project", description: "Conhecimento interno padrão do projeto.", authorized: ctx.allowedPolicies.includes("internal-project"), itemCount: countByPolicy.get("internal-project") ?? 0 },
      { policyId: "restricted-security", description: "Conhecimento restrito (PII, pagamentos, segurança crítica).", authorized: ctx.allowedPolicies.includes("restricted-security"), itemCount: countByPolicy.get("restricted-security") ?? 0 }
    ];
    const savedPolicies = opRepo
      ? await opRepo.listCustomAccessPolicies(ctx, req.params.projectId)
      : [...customPolicyCatalog.entries()]
          .filter(([key]) => key.startsWith(`${ctx.tenantId}:${req.params.projectId}:`))
          .map(([, policy]) => policy);
    const customPolicies = savedPolicies.filter((p) => !policyCatalog.some((base) => base.policyId === p.policyId));
    const mergedCatalog = [
      ...policyCatalog.map((base) => {
        const override = savedPolicies.find((p) => p.policyId === base.policyId);
        return override ? { ...base, description: override.description, label: override.label, allowedRoles: override.allowedRoles } : base;
      }),
      ...customPolicies
        .filter((p) => !p.policyId.startsWith("role:") && !p.policyId.startsWith("user-assignment:") && !p.policyId.startsWith("user-policy:"))
        .map((p) => ({
          policyId: p.policyId,
          label: p.label,
          description: p.description,
          allowedRoles: p.allowedRoles,
          authorized: ctx.allowedPolicies.includes(p.policyId),
          itemCount: countByPolicy.get(p.policyId) ?? 0
        }))
    ];
    return {
      projectId: req.params.projectId,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      identitySource: ctx.actorId === "local-api-key" ? "local-api-key" : "jwt-claims",
      caslEnabled: true,
      betterAuthEnabled: true,
      roles: ctx.roles,
      effectivePermissions: ctx.permissions ?? [],
      allowedProjects: ctx.allowedProjects,
      allowedPolicies: ctx.allowedPolicies,
      policyCatalog: mergedCatalog,
      currentProjectAuthorized: true,
      managementAvailable: true,
      managementStorage: opRepo ? "postgres" : "process-memory",
      managementNote: opRepo
        ? "Alterações de acesso persistem em PostgreSQL (CASL + Better Auth)."
        : "Alterações locais de acesso ficam em memória e se perdem ao reiniciar."
    };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/members", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    requireAccessAdmin(ctx);
    const prefix = `${ctx.tenantId}:${req.params.projectId}:`;
    const members = opRepo
      ? await opRepo.listAccessMembers(ctx, req.params.projectId)
      : [...accessMembers.entries()].filter(([key]) => key.startsWith(prefix)).map(([, member]) => member);
    return { projectId: req.params.projectId, betterAuthEnabled: true, members };
  });

  app.put<{ Params: { projectId: string; actorId: string }; Body: { roles: string[]; allowedPolicies?: string[] } }>(
    "/v1/projects/:projectId/access/members/:actorId/roles",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      requireAccessAdmin(ctx);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (!Array.isArray(req.body.roles) || req.body.roles.length === 0) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "roles deve ser uma lista não vazia.", 400);
      }
      let syncedWithKeycloak = false;
      if (process.env.KEYCLOAK_ADMIN_URL && process.env.KEYCLOAK_ADMIN_TOKEN) {
        try {
          const res = await fetch(`${process.env.KEYCLOAK_ADMIN_URL.replace(/\/$/, "")}/users/${encodeURIComponent(req.params.actorId)}/role-mappings/realm`, {
            method: "POST",
            headers: { authorization: `Bearer ${process.env.KEYCLOAK_ADMIN_TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify(req.body.roles.map((name) => ({ name })))
          });
          syncedWithKeycloak = res.ok;
        } catch {
          syncedWithKeycloak = false;
        }
      }
      const record = {
        actorId: req.params.actorId,
        roles: [...new Set(req.body.roles)],
        allowedPolicies: req.body.allowedPolicies ? [...new Set(req.body.allowedPolicies)] : ["internal-project"],
        updatedAt: new Date().toISOString(),
        syncedWithKeycloak
      };
      if (opRepo) await opRepo.saveAccessMember(ctx, req.params.projectId, record);
      else accessMembers.set(accessMemberKey(ctx, req.params.projectId, req.params.actorId), record);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "access_member_roles",
        targetId: req.params.actorId,
        metadata: { roles: record.roles, allowedPolicies: record.allowedPolicies, syncedWithKeycloak }
      });
      return record;
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/grants", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    requireAccessAdmin(ctx);
    const now = Date.now();
    const hasProj = req.params.projectId !== "__global__" && ctx.allowedProjects.includes(req.params.projectId);
    const grants = opRepo
      ? (hasProj ? await opRepo.listTemporaryAccessGrants(ctx, req.params.projectId, new Date(now)) : [])
      : [...temporaryGrants.values()].filter((g) => g.tenantId === ctx.tenantId && g.projectId === req.params.projectId && Date.parse(g.expiresAt) > now);
    return { projectId: req.params.projectId, grants };
  });

  app.post<{ Params: { projectId: string }; Body: { actorId: string; roles?: string[]; policyIds?: string[]; ttlMinutes?: number } }>(
    "/v1/projects/:projectId/access/grants",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      requireAccessAdmin(ctx);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const ttlMinutes = Math.min(10080, Math.max(5, Number(req.body.ttlMinutes ?? 60)));
      const grantId = `GRANT-${randomUUID().slice(0, 8)}`;
      const now = new Date();
      const grant = {
        grantId,
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        actorId: req.body.actorId,
        roles: req.body.roles ?? ["developer"],
        policyIds: req.body.policyIds ?? ["internal-project"],
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
        grantedBy: ctx.actorId
      };
      const persisted = opRepo
        ? await opRepo.createTemporaryAccessGrant(ctx, {
            grantId, projectId: req.params.projectId, actorId: grant.actorId, roles: grant.roles,
            policyIds: grant.policyIds, expiresAt: new Date(grant.expiresAt), grantedBy: grant.grantedBy
          })
        : (temporaryGrants.set(grantId, grant), grant);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "temporary_access_grant",
        targetId: grantId,
        metadata: { actorId: grant.actorId, expiresAt: grant.expiresAt, roles: grant.roles, policyIds: grant.policyIds }
      });
      return { tenantId: ctx.tenantId, ...persisted };
    }
  );

  app.delete<{ Params: { projectId: string; grantId: string } }>("/v1/projects/:projectId/access/grants/:grantId", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    requireAccessAdmin(ctx);
    const grant = temporaryGrants.get(req.params.grantId);
    const revoked = opRepo
      ? await opRepo.revokeTemporaryAccessGrant(ctx, req.params.projectId, req.params.grantId)
      : Boolean(grant && grant.tenantId === ctx.tenantId && grant.projectId === req.params.projectId && temporaryGrants.delete(req.params.grantId));
    if (!revoked) throw new BrainError("BRAIN_ERR_NOT_FOUND", `Concessão '${req.params.grantId}' não encontrada.`, 404);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "revoke",
      targetType: "temporary_access_grant",
      targetId: req.params.grantId
    });
    return { revoked: true, grantId: req.params.grantId };
  });

  app.put<{ Params: { projectId: string; policyId: string }; Body: { label?: string; description: string; allowedRoles?: string[] } }>(
    "/v1/projects/:projectId/access/policies/:policyId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      requireAccessAdmin(ctx);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const entry = {
        policyId: req.params.policyId,
        label: req.body.label?.trim() || req.params.policyId,
        description: req.body.description.trim(),
        allowedRoles: req.body.allowedRoles ?? ["admin", "appsec", "tech-lead"],
        updatedAt: new Date().toISOString()
      };
      const savedEntry = opRepo
        ? await opRepo.upsertCustomAccessPolicy(ctx, req.params.projectId, entry)
        : (customPolicyCatalog.set(customPolicyKey(ctx, req.params.projectId, req.params.policyId), entry), entry);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "access_policy_catalog",
        targetId: req.params.policyId,
        metadata: { allowedRoles: savedEntry.allowedRoles }
      });
      return savedEntry;
    }
  );
}

