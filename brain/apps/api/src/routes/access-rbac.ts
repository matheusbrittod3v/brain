import { Type } from "@sinclair/typebox";
import {
  ALL_SYSTEM_PERMISSIONS,
  assertPermission,
  DEFAULT_ROLES,
  PERMISSION_CATALOG,
  revokeActorSessions,
  usersStore,
  type SystemPermission
} from "@brain/auth";
import { BrainError } from "@brain/core";
import type { ApiRouteDeps } from "./types.js";

export function registerAccessRbacRoutes(deps: ApiRouteDeps) {
  const { app, authenticateProjectRequest, recordAudit, opRepo, authRepo } = deps;

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/users", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    assertPermission(ctx, "roles:view");
    const dbUsers = authRepo ? await authRepo.listUsers(ctx.tenantId) : [];
    const members = opRepo ? await opRepo.listAccessMembers(ctx, req.params.projectId) : [];
    const byId = new Map<
      string,
      {
        id: string
        name: string
        email?: string
        roles: string[]
        allowedProjects: string[]
        allowedPolicies: string[]
        linkedAgentIds: string[]
        source: string
      }
    >();

    for (const u of dbUsers) {
      byId.set(u.id, {
        id: u.id,
        name: u.name,
        email: u.email,
        roles: u.roles,
        allowedProjects: u.allowedProjects ?? [],
        allowedPolicies: u.allowedPolicies ?? [],
        linkedAgentIds: u.linkedAgentIds ?? [],
        source: "registered"
      });
    }
    for (const m of members) {
      if (!byId.has(m.actorId)) {
        byId.set(m.actorId, {
          id: m.actorId,
          name: m.actorId,
          roles: m.roles,
          allowedProjects: [req.params.projectId],
          allowedPolicies: m.allowedPolicies ?? ["public-org", "internal-project"],
          linkedAgentIds: [],
          source: "member"
        });
      }
    }
    if (!byId.has(ctx.actorId)) {
      byId.set(ctx.actorId, {
        id: ctx.actorId,
        name: ctx.actorId,
        roles: ctx.roles,
        allowedProjects: ctx.allowedProjects,
        allowedPolicies: ctx.allowedPolicies,
        linkedAgentIds: [],
        source: "session"
      });
    }
    return { projectId: req.params.projectId, users: [...byId.values()] };
  });

  app.put<{
    Params: { projectId: string; userId: string };
    Body: {
      allowedProjects?: string[];
      allowedPolicies?: string[];
      roles?: string[];
      revokeActiveSessions?: boolean;
    };
  }>(
    "/v1/projects/:projectId/access/users/:userId/scopes",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), userId: Type.String() }),
        body: Type.Object({
          allowedProjects: Type.Optional(Type.Array(Type.String())),
          allowedPolicies: Type.Optional(Type.Array(Type.String())),
          roles: Type.Optional(Type.Array(Type.String())),
          revokeActiveSessions: Type.Optional(Type.Boolean())
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      assertPermission(ctx, "users:assign_roles");

      const targetId = req.params.userId;
      const dbUser = authRepo ? await authRepo.findUserById(targetId) : null;
      const memUser = !dbUser ? usersStore.getUserById(targetId) : null;
      const existing = dbUser ?? memUser;

      const nextProjects = req.body.allowedProjects ?? existing?.allowedProjects ?? [req.params.projectId];
      const nextPolicies = req.body.allowedPolicies ?? existing?.allowedPolicies ?? ["public-org", "internal-project"];
      const nextRoles = req.body.roles ?? existing?.roles ?? ["viewer"];

      if (authRepo && dbUser) {
        await authRepo.upsertUser({
          id: dbUser.id,
          tenantId: dbUser.tenantId,
          email: dbUser.email,
          name: dbUser.name,
          passwordHash: dbUser.passwordHash,
          emailVerified: dbUser.emailVerified,
          roles: nextRoles,
          allowedProjects: nextProjects,
          allowedPolicies: nextPolicies,
          customPermissions: dbUser.customPermissions as string[] | undefined
        });
      }
      if (memUser) {
        memUser.roles = [...nextRoles];
        memUser.allowedProjects = [...nextProjects];
        memUser.allowedPolicies = [...nextPolicies];
        memUser.updatedAt = new Date().toISOString();
      }
      if (req.body.revokeActiveSessions !== false) {
        revokeActorSessions(targetId);
      }

      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "user_scopes",
        targetId,
        metadata: {
          allowedProjects: nextProjects,
          allowedPolicies: nextPolicies,
          roles: nextRoles,
          revokedSessions: req.body.revokeActiveSessions !== false
        }
      });

      return {
        userId: targetId,
        allowedProjects: nextProjects,
        allowedPolicies: nextPolicies,
        roles: nextRoles,
        sessionsRevoked: req.body.revokeActiveSessions !== false
      };
    }
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/access/user-policies",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      const policies = opRepo ? await opRepo.listUserFineGrainedPolicies(ctx, req.params.projectId) : [];
      return { projectId: req.params.projectId, policies };
    }
  );

  app.put<{
    Params: { projectId: string; userId: string };
    Body: {
      linkedAgentIds?: string[];
      inheritUserPermissions?: boolean;
      roles?: string[];
      allowedActions?: Array<"read" | "write" | "create" | "update" | "approve" | "manage_policies">;
      allowedPolicies?: string[];
      allowedDomains?: number[];
      allowedPathPrefixes?: string[];
    };
  }>(
    "/v1/projects/:projectId/access/user-policies/:userId",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), userId: Type.String() }),
        body: Type.Object({
          linkedAgentIds: Type.Optional(Type.Array(Type.String())),
          inheritUserPermissions: Type.Optional(Type.Boolean()),
          roles: Type.Optional(Type.Array(Type.String())),
          allowedActions: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Literal("read"),
                Type.Literal("write"),
                Type.Literal("create"),
                Type.Literal("update"),
                Type.Literal("approve"),
                Type.Literal("manage_policies")
              ])
            )
          ),
          allowedPolicies: Type.Optional(Type.Array(Type.String())),
          allowedDomains: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
          allowedPathPrefixes: Type.Optional(Type.Array(Type.String()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (!opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const policy = await opRepo.upsertUserFineGrainedPolicy(ctx, req.params.projectId, {
        userId: req.params.userId,
        linkedAgentIds: req.body.linkedAgentIds ?? [],
        inheritUserPermissions: req.body.inheritUserPermissions ?? true,
        roles: req.body.roles ?? ["developer", "tech-lead"],
        allowedActions: req.body.allowedActions ?? ["read", "write", "create", "update", "approve", "manage_policies"],
        allowedPolicies: req.body.allowedPolicies ?? ["public-org", "internal-project"],
        allowedDomains: req.body.allowedDomains ?? [],
        allowedPathPrefixes: req.body.allowedPathPrefixes ?? []
      });
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "user_policy",
        targetId: policy.userId,
        metadata: { linkedAgentIds: policy.linkedAgentIds, inheritUserPermissions: policy.inheritUserPermissions }
      });
      return { projectId: req.params.projectId, policy };
    }
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/v1/projects/:projectId/access/user-policies/:userId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      if (!opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const deleted = await opRepo.deleteUserFineGrainedPolicy(ctx, req.params.projectId, req.params.userId);
      return { projectId: req.params.projectId, userId: req.params.userId, deleted };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/permissions", async (req) => {
    await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    return { projectId: req.params.projectId, permissions: PERMISSION_CATALOG };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/roles", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    assertPermission(ctx, "roles:view");
    const roles = opRepo ? await opRepo.listRoles(ctx, req.params.projectId) : DEFAULT_ROLES;
    return { projectId: req.params.projectId, roles };
  });

  app.put<{
    Params: { projectId: string; roleId: string };
    Body: { name: string; description?: string; permissions: SystemPermission[]; allowedPolicies?: string[] };
  }>(
    "/v1/projects/:projectId/access/roles/:roleId",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), roleId: Type.String() }),
        body: Type.Object({
          name: Type.String({ minLength: 1 }),
          description: Type.Optional(Type.String()),
          permissions: Type.Array(Type.String()),
          allowedPolicies: Type.Optional(Type.Array(Type.String()))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      assertPermission(ctx, "roles:manage");
      if (!opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const validSet = new Set<string>(ALL_SYSTEM_PERMISSIONS);
      const permissions = req.body.permissions.filter((p): p is SystemPermission => validSet.has(p));
      const role = await opRepo.upsertRole(ctx, req.params.projectId, {
        roleId: req.params.roleId,
        name: req.body.name,
        description: req.body.description ?? "",
        permissions,
        allowedPolicies: req.body.allowedPolicies ?? ["public-org", "internal-project"]
      });
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "role",
        targetId: role.roleId,
        metadata: { permissionsCount: role.permissions.length }
      });
      return { projectId: req.params.projectId, role };
    }
  );

  app.delete<{ Params: { projectId: string; roleId: string } }>(
    "/v1/projects/:projectId/access/roles/:roleId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      assertPermission(ctx, "roles:manage");
      if (!opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const deleted = await opRepo.deleteRole(ctx, req.params.projectId, req.params.roleId);
      return { projectId: req.params.projectId, roleId: req.params.roleId, deleted };
    }
  );

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/access/assignments", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    assertPermission(ctx, "roles:view");
    const assignments = opRepo ? await opRepo.listUserRoleAssignments(ctx, req.params.projectId) : [];
    return { projectId: req.params.projectId, assignments };
  });

  app.put<{
    Params: { projectId: string; userId: string };
    Body: {
      roleIds: string[];
      linkedAgentIds?: string[];
      inheritUserPermissions?: boolean;
      extraPermissions?: SystemPermission[];
      deniedPermissions?: SystemPermission[];
      allowedDomains?: number[];
    };
  }>(
    "/v1/projects/:projectId/access/assignments/:userId",
    {
      schema: {
        params: Type.Object({ projectId: Type.String(), userId: Type.String() }),
        body: Type.Object({
          roleIds: Type.Array(Type.String()),
          linkedAgentIds: Type.Optional(Type.Array(Type.String())),
          inheritUserPermissions: Type.Optional(Type.Boolean()),
          extraPermissions: Type.Optional(Type.Array(Type.String())),
          deniedPermissions: Type.Optional(Type.Array(Type.String())),
          allowedDomains: Type.Optional(Type.Array(Type.Integer({ minimum: 1 })))
        })
      }
    },
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      assertPermission(ctx, "users:assign_roles");
      if (!opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const validSet = new Set<string>(ALL_SYSTEM_PERMISSIONS);
      const assignment = await opRepo.upsertUserRoleAssignment(ctx, req.params.projectId, {
        userId: req.params.userId,
        roleIds: req.body.roleIds,
        linkedAgentIds: req.body.linkedAgentIds ?? [],
        inheritUserPermissions: req.body.inheritUserPermissions ?? true,
        extraPermissions: (req.body.extraPermissions ?? []).filter((p): p is SystemPermission => validSet.has(p)),
        deniedPermissions: (req.body.deniedPermissions ?? []).filter((p): p is SystemPermission => validSet.has(p)),
        allowedDomains: req.body.allowedDomains ?? []
      });
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "user_role_assignment",
        targetId: assignment.userId,
        metadata: { roleIds: assignment.roleIds, linkedAgentIds: assignment.linkedAgentIds }
      });
      return { projectId: req.params.projectId, assignment };
    }
  );

  app.delete<{ Params: { projectId: string; userId: string } }>(
    "/v1/projects/:projectId/access/assignments/:userId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      assertPermission(ctx, "users:assign_roles");
      if (!opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const deleted = await opRepo.deleteUserRoleAssignment(ctx, req.params.projectId, req.params.userId);
      return { projectId: req.params.projectId, userId: req.params.userId, deleted };
    }
  );
}

