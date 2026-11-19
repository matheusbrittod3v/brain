import { and, asc, eq, gt } from "drizzle-orm";
import {
  applyUserFineGrainedPolicy,
  applyUserRoleAssignment,
  DEFAULT_ROLES,
  resolveDefaultPermissionsForRoles,
  type AuthContext,
  type FineGrainedAction,
  type RoleDefinition,
  type SystemPermission,
  type UserFineGrainedPolicy,
  type UserRoleAssignment
} from "@brain/auth";
import { BrainError } from "@brain/core";
import { withTenantRls, type BrainDb } from "../client.js";
import {
  customAccessPolicies,
  projectAccessMembers,
  temporaryAccessGrants
} from "../schema.js";

export class PgAccessRbacRepo {
  constructor(protected readonly db: BrainDb) {}

  protected assertAccessAdminScope(ctx: AuthContext, projectId: string): void {
    if (!ctx.allowedProjects.includes(projectId) || !ctx.allowedPolicies.includes("internal-project")) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Access administration is outside the authorized project or policy scope.", 403);
    }
  }

  async listAccessMembers(ctx: AuthContext, projectId: string) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      actorId: projectAccessMembers.actorId,
      roles: projectAccessMembers.roles,
      allowedPolicies: projectAccessMembers.allowedPolicies,
      updatedAt: projectAccessMembers.updatedAt,
      syncedWithKeycloak: projectAccessMembers.syncedWithKeycloak
    }).from(projectAccessMembers).where(and(
      eq(projectAccessMembers.tenantId, ctx.tenantId),
      eq(projectAccessMembers.projectId, projectId),
      eq(projectAccessMembers.accessPolicyId, "internal-project")
    )).orderBy(asc(projectAccessMembers.actorId)));
  }

  async saveAccessMember(
    ctx: AuthContext,
    projectId: string,
    input: { actorId: string; roles: string[]; allowedPolicies: string[]; syncedWithKeycloak: boolean }
  ) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(projectAccessMembers).values({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: input.actorId,
        roles: [...new Set(input.roles)],
        allowedPolicies: [...new Set(input.allowedPolicies)],
        syncedWithKeycloak: input.syncedWithKeycloak,
        updatedAt: new Date()
      }).onConflictDoUpdate({
        target: [projectAccessMembers.tenantId, projectAccessMembers.projectId, projectAccessMembers.actorId],
        set: {
          roles: [...new Set(input.roles)],
          allowedPolicies: [...new Set(input.allowedPolicies)],
          syncedWithKeycloak: input.syncedWithKeycloak,
          updatedAt: new Date()
        }
      }).returning({
        actorId: projectAccessMembers.actorId,
        roles: projectAccessMembers.roles,
        allowedPolicies: projectAccessMembers.allowedPolicies,
        updatedAt: projectAccessMembers.updatedAt,
        syncedWithKeycloak: projectAccessMembers.syncedWithKeycloak
      });
      if (!row) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Member access record was not persisted.", 503);
      return row;
    });
  }

  async listTemporaryAccessGrants(ctx: AuthContext, projectId: string, at = new Date()) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      grantId: temporaryAccessGrants.grantId,
      projectId: temporaryAccessGrants.projectId,
      actorId: temporaryAccessGrants.actorId,
      roles: temporaryAccessGrants.roles,
      policyIds: temporaryAccessGrants.policyIds,
      expiresAt: temporaryAccessGrants.expiresAt,
      grantedBy: temporaryAccessGrants.grantedBy,
      createdAt: temporaryAccessGrants.createdAt
    }).from(temporaryAccessGrants).where(and(
      eq(temporaryAccessGrants.tenantId, ctx.tenantId),
      eq(temporaryAccessGrants.projectId, projectId),
      eq(temporaryAccessGrants.accessPolicyId, "internal-project"),
      gt(temporaryAccessGrants.expiresAt, at)
    )).orderBy(asc(temporaryAccessGrants.createdAt)));
  }

  async createTemporaryAccessGrant(ctx: AuthContext, input: {
    grantId: string; projectId: string; actorId: string; roles: string[]; policyIds: string[]; expiresAt: Date; grantedBy: string;
  }) {
    this.assertAccessAdminScope(ctx, input.projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(temporaryAccessGrants).values({
        grantId: input.grantId,
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        accessPolicyId: "internal-project",
        actorId: input.actorId,
        roles: [...new Set(input.roles)],
        policyIds: [...new Set(input.policyIds)],
        expiresAt: input.expiresAt,
        grantedBy: input.grantedBy
      }).returning({
        grantId: temporaryAccessGrants.grantId,
        projectId: temporaryAccessGrants.projectId,
        actorId: temporaryAccessGrants.actorId,
        roles: temporaryAccessGrants.roles,
        policyIds: temporaryAccessGrants.policyIds,
        expiresAt: temporaryAccessGrants.expiresAt,
        grantedBy: temporaryAccessGrants.grantedBy,
        createdAt: temporaryAccessGrants.createdAt
      });
      if (!row) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Temporary access grant was not persisted.", 503);
      return row;
    });
  }

  async revokeTemporaryAccessGrant(ctx: AuthContext, projectId: string, grantId: string): Promise<boolean> {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx.delete(temporaryAccessGrants).where(and(
        eq(temporaryAccessGrants.tenantId, ctx.tenantId),
        eq(temporaryAccessGrants.projectId, projectId),
        eq(temporaryAccessGrants.grantId, grantId),
        eq(temporaryAccessGrants.accessPolicyId, "internal-project")
      )).returning({ grantId: temporaryAccessGrants.grantId });
      return deleted.length > 0;
    });
  }

  async listCustomAccessPolicies(ctx: AuthContext, projectId: string) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => tx.select({
      policyId: customAccessPolicies.policyId,
      label: customAccessPolicies.label,
      description: customAccessPolicies.description,
      allowedRoles: customAccessPolicies.allowedRoles,
      updatedAt: customAccessPolicies.updatedAt
    }).from(customAccessPolicies).where(and(
      eq(customAccessPolicies.tenantId, ctx.tenantId),
      eq(customAccessPolicies.projectId, projectId),
      eq(customAccessPolicies.accessPolicyId, "internal-project")
    )).orderBy(asc(customAccessPolicies.policyId)));
  }

  async upsertCustomAccessPolicy(ctx: AuthContext, projectId: string, input: {
    policyId: string; label: string; description: string; allowedRoles: string[];
  }) {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const [row] = await tx.insert(customAccessPolicies).values({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        policyId: input.policyId,
        label: input.label,
        description: input.description,
        allowedRoles: [...new Set(input.allowedRoles)],
        updatedAt: new Date()
      }).onConflictDoUpdate({
        target: [customAccessPolicies.tenantId, customAccessPolicies.projectId, customAccessPolicies.policyId],
        set: {
          accessPolicyId: "internal-project",
          label: input.label,
          description: input.description,
          allowedRoles: [...new Set(input.allowedRoles)],
          updatedAt: new Date()
        }
      }).returning({
        policyId: customAccessPolicies.policyId,
        label: customAccessPolicies.label,
        description: customAccessPolicies.description,
        allowedRoles: customAccessPolicies.allowedRoles,
        updatedAt: customAccessPolicies.updatedAt
      });
      if (!row) throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Custom access policy was not persisted.", 503);
      return row;
    });
  }

  async listUserFineGrainedPolicies(ctx: AuthContext, projectId: string): Promise<UserFineGrainedPolicy[]> {
    this.assertAccessAdminScope(ctx, projectId);
    const rows = await withTenantRls(this.db, ctx, async (tx) => tx.select({
      policyId: customAccessPolicies.policyId,
      label: customAccessPolicies.label,
      description: customAccessPolicies.description,
      allowedRoles: customAccessPolicies.allowedRoles,
      updatedAt: customAccessPolicies.updatedAt
    }).from(customAccessPolicies).where(and(
      eq(customAccessPolicies.tenantId, ctx.tenantId),
      eq(customAccessPolicies.projectId, projectId),
      eq(customAccessPolicies.accessPolicyId, "internal-project")
    )).orderBy(asc(customAccessPolicies.policyId)));

    const result: UserFineGrainedPolicy[] = [];
    for (const row of rows) {
      if (!row.policyId.startsWith("user-policy:")) continue;
      const userId = row.policyId.slice("user-policy:".length);
      try {
        const parsed = JSON.parse(row.description) as Partial<UserFineGrainedPolicy>;
        result.push({
          userId,
          linkedAgentIds: Array.isArray(parsed.linkedAgentIds) ? parsed.linkedAgentIds : [],
          inheritUserPermissions: Boolean(parsed.inheritUserPermissions),
          roles: Array.isArray(row.allowedRoles) ? row.allowedRoles : [],
          allowedActions: Array.isArray(parsed.allowedActions) ? (parsed.allowedActions as FineGrainedAction[]) : ["read", "write", "create", "update"],
          allowedPolicies: Array.isArray(parsed.allowedPolicies) ? parsed.allowedPolicies : ["public-org", "internal-project"],
          allowedDomains: Array.isArray(parsed.allowedDomains) ? parsed.allowedDomains : [],
          allowedPathPrefixes: Array.isArray(parsed.allowedPathPrefixes) ? parsed.allowedPathPrefixes : [],
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: parsed.updatedBy
        });
      } catch {
        // Ignore malformed legacy entry
      }
    }
    return result;
  }

  async upsertUserFineGrainedPolicy(
    ctx: AuthContext,
    projectId: string,
    input: Omit<UserFineGrainedPolicy, "updatedAt" | "updatedBy">
  ): Promise<UserFineGrainedPolicy> {
    this.assertAccessAdminScope(ctx, projectId);
    const normalized: UserFineGrainedPolicy = {
      userId: input.userId.trim(),
      linkedAgentIds: [...new Set(input.linkedAgentIds.map((s) => s.trim()).filter(Boolean))],
      inheritUserPermissions: Boolean(input.inheritUserPermissions),
      roles: [...new Set(input.roles.map((s) => s.trim()).filter(Boolean))],
      allowedActions: [...new Set(input.allowedActions)],
      allowedPolicies: [...new Set(input.allowedPolicies.map((s) => s.trim()).filter(Boolean))],
      allowedDomains: [...new Set(input.allowedDomains.filter((d) => Number.isInteger(d) && d > 0))],
      allowedPathPrefixes: [...new Set(input.allowedPathPrefixes.map((s) => s.trim()).filter(Boolean))],
      updatedBy: ctx.actorId
    };
    const row = await this.upsertCustomAccessPolicy(ctx, projectId, {
      policyId: `user-policy:${normalized.userId}`,
      label: `User Policy: ${normalized.userId}`,
      description: JSON.stringify(normalized),
      allowedRoles: normalized.roles
    });
    return { ...normalized, updatedAt: row.updatedAt.toISOString() };
  }

  async deleteUserFineGrainedPolicy(ctx: AuthContext, projectId: string, userId: string): Promise<boolean> {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx.delete(customAccessPolicies).where(and(
        eq(customAccessPolicies.tenantId, ctx.tenantId),
        eq(customAccessPolicies.projectId, projectId),
        eq(customAccessPolicies.policyId, `user-policy:${userId.trim()}`),
        eq(customAccessPolicies.accessPolicyId, "internal-project")
      )).returning({ policyId: customAccessPolicies.policyId });
      return deleted.length > 0;
    });
  }

  async listRoles(ctx: AuthContext, projectId: string): Promise<RoleDefinition[]> {
    this.assertAccessAdminScope(ctx, projectId);
    const rows = await withTenantRls(this.db, ctx, async (tx) => tx.select({
      policyId: customAccessPolicies.policyId,
      label: customAccessPolicies.label,
      description: customAccessPolicies.description,
      allowedRoles: customAccessPolicies.allowedRoles,
      updatedAt: customAccessPolicies.updatedAt
    }).from(customAccessPolicies).where(and(
      eq(customAccessPolicies.tenantId, ctx.tenantId),
      eq(customAccessPolicies.projectId, projectId),
      eq(customAccessPolicies.accessPolicyId, "internal-project")
    )).orderBy(asc(customAccessPolicies.policyId)));

    const byId = new Map<string, RoleDefinition>(DEFAULT_ROLES.map((r) => [r.roleId, { ...r }]));
    for (const row of rows) {
      if (!row.policyId.startsWith("role:")) continue;
      const roleId = row.policyId.slice("role:".length);
      try {
        const parsed = JSON.parse(row.description) as Partial<RoleDefinition>;
        byId.set(roleId, {
          roleId,
          name: parsed.name || row.label || roleId,
          description: parsed.description ?? "",
          permissions: Array.isArray(parsed.permissions) ? (parsed.permissions as SystemPermission[]) : [],
          allowedPolicies: Array.isArray(row.allowedRoles) ? row.allowedRoles : ["public-org", "internal-project"],
          isSystem: DEFAULT_ROLES.some((d) => d.roleId === roleId),
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: parsed.updatedBy
        });
      } catch {
        // Ignore malformed role row
      }
    }
    return [...byId.values()];
  }

  async upsertRole(
    ctx: AuthContext,
    projectId: string,
    input: Omit<RoleDefinition, "isSystem" | "updatedAt" | "updatedBy">
  ): Promise<RoleDefinition> {
    this.assertAccessAdminScope(ctx, projectId);
    const roleId = input.roleId.trim().toLowerCase();
    const payload = {
      roleId,
      name: input.name.trim() || roleId,
      description: input.description.trim(),
      permissions: [...new Set(input.permissions)],
      allowedPolicies: [...new Set(input.allowedPolicies.map((s) => s.trim()).filter(Boolean))],
      updatedBy: ctx.actorId
    };
    const row = await this.upsertCustomAccessPolicy(ctx, projectId, {
      policyId: `role:${roleId}`,
      label: payload.name,
      description: JSON.stringify(payload),
      allowedRoles: payload.allowedPolicies
    });
    return {
      ...payload,
      isSystem: DEFAULT_ROLES.some((d) => d.roleId === roleId),
      updatedAt: row.updatedAt.toISOString()
    };
  }

  async deleteRole(ctx: AuthContext, projectId: string, roleId: string): Promise<boolean> {
    this.assertAccessAdminScope(ctx, projectId);
    const normalized = roleId.trim().toLowerCase();
    if (DEFAULT_ROLES.some((d) => d.roleId === normalized)) {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Cargo padrão '${normalized}' não pode ser excluído (apenas editado).`, 409);
    }
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx.delete(customAccessPolicies).where(and(
        eq(customAccessPolicies.tenantId, ctx.tenantId),
        eq(customAccessPolicies.projectId, projectId),
        eq(customAccessPolicies.policyId, `role:${normalized}`),
        eq(customAccessPolicies.accessPolicyId, "internal-project")
      )).returning({ policyId: customAccessPolicies.policyId });
      return deleted.length > 0;
    });
  }

  async listUserRoleAssignments(ctx: AuthContext, projectId: string): Promise<UserRoleAssignment[]> {
    this.assertAccessAdminScope(ctx, projectId);
    const rows = await withTenantRls(this.db, ctx, async (tx) => tx.select({
      policyId: customAccessPolicies.policyId,
      description: customAccessPolicies.description,
      allowedRoles: customAccessPolicies.allowedRoles,
      updatedAt: customAccessPolicies.updatedAt
    }).from(customAccessPolicies).where(and(
      eq(customAccessPolicies.tenantId, ctx.tenantId),
      eq(customAccessPolicies.projectId, projectId),
      eq(customAccessPolicies.accessPolicyId, "internal-project")
    )).orderBy(asc(customAccessPolicies.policyId)));

    const result: UserRoleAssignment[] = [];
    for (const row of rows) {
      if (!row.policyId.startsWith("user-assignment:")) continue;
      const userId = row.policyId.slice("user-assignment:".length);
      try {
        const parsed = JSON.parse(row.description) as Partial<UserRoleAssignment>;
        result.push({
          userId,
          roleIds: Array.isArray(row.allowedRoles) ? row.allowedRoles : [],
          linkedAgentIds: Array.isArray(parsed.linkedAgentIds) ? parsed.linkedAgentIds : [],
          inheritUserPermissions: Boolean(parsed.inheritUserPermissions),
          extraPermissions: Array.isArray(parsed.extraPermissions) ? (parsed.extraPermissions as SystemPermission[]) : [],
          deniedPermissions: Array.isArray(parsed.deniedPermissions) ? (parsed.deniedPermissions as SystemPermission[]) : [],
          allowedDomains: Array.isArray(parsed.allowedDomains) ? parsed.allowedDomains : [],
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: parsed.updatedBy
        });
      } catch {
        // Ignore malformed assignment
      }
    }
    return result;
  }

  async upsertUserRoleAssignment(
    ctx: AuthContext,
    projectId: string,
    input: Omit<UserRoleAssignment, "updatedAt" | "updatedBy">
  ): Promise<UserRoleAssignment> {
    this.assertAccessAdminScope(ctx, projectId);
    const normalized: UserRoleAssignment = {
      userId: input.userId.trim(),
      roleIds: [...new Set(input.roleIds.map((s) => s.trim().toLowerCase()).filter(Boolean))],
      linkedAgentIds: [...new Set(input.linkedAgentIds.map((s) => s.trim()).filter(Boolean))],
      inheritUserPermissions: Boolean(input.inheritUserPermissions),
      extraPermissions: [...new Set(input.extraPermissions)],
      deniedPermissions: [...new Set(input.deniedPermissions)],
      allowedDomains: [...new Set(input.allowedDomains.filter((d) => Number.isInteger(d) && d > 0))],
      updatedBy: ctx.actorId
    };
    const row = await this.upsertCustomAccessPolicy(ctx, projectId, {
      policyId: `user-assignment:${normalized.userId}`,
      label: `User Roles: ${normalized.userId}`,
      description: JSON.stringify(normalized),
      allowedRoles: normalized.roleIds
    });
    return { ...normalized, updatedAt: row.updatedAt.toISOString() };
  }

  async deleteUserRoleAssignment(ctx: AuthContext, projectId: string, userId: string): Promise<boolean> {
    this.assertAccessAdminScope(ctx, projectId);
    return withTenantRls(this.db, ctx, async (tx) => {
      const deleted = await tx.delete(customAccessPolicies).where(and(
        eq(customAccessPolicies.tenantId, ctx.tenantId),
        eq(customAccessPolicies.projectId, projectId),
        eq(customAccessPolicies.policyId, `user-assignment:${userId.trim()}`),
        eq(customAccessPolicies.accessPolicyId, "internal-project")
      )).returning({ policyId: customAccessPolicies.policyId });
      return deleted.length > 0;
    });
  }

  async resolveEffectiveAuthContext(ctx: AuthContext, projectId: string): Promise<AuthContext> {
    if (!ctx.allowedProjects.includes(projectId) || !ctx.allowedPolicies.includes("internal-project")) {
      return ctx;
    }
    const [rolesCatalog, assignments, legacyPolicies] = await Promise.all([
      this.listRoles(ctx, projectId).catch(() => DEFAULT_ROLES),
      this.listUserRoleAssignments(ctx, projectId).catch(() => [] as UserRoleAssignment[]),
      this.listUserFineGrainedPolicies(ctx, projectId).catch(() => [] as UserFineGrainedPolicy[])
    ]);
    let effective: AuthContext = {
      ...ctx,
      permissions: ctx.permissions ?? resolveDefaultPermissionsForRoles(ctx.roles, rolesCatalog)
    };
    for (const assignment of assignments) {
      effective = applyUserRoleAssignment(effective, assignment, rolesCatalog);
    }
    for (const policy of legacyPolicies) {
      effective = applyUserFineGrainedPolicy(effective, policy);
    }
    return effective;
  }
}

