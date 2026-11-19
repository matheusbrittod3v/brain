import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ALL_SYSTEM_PERMISSIONS,
  assertPermission,
  assertProjectAccess,
  PERMISSION_CATALOG,
  type AuthContext,
  type SystemPermission
} from "@brain/auth";
import { BrainError } from "@brain/core";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

const systemPermSchema = z.enum(ALL_SYSTEM_PERMISSIONS as [SystemPermission, ...SystemPermission[]]);

export function registerExtendedAccessRbacTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  profile: McpConnectionProfileName
): void {
  server.tool(
    "brain_list_user_policies",
    describeMcpTool(profile, "Lista políticas granulares por usuário e os agentes vinculados que herdam permissões do usuário."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível para listar políticas de usuário.", 503);
      }
      const policies = await runtime.opRepo.listUserFineGrainedPolicies(ctx, projectId);
      return okJson({ projectId, policies });
    }
  );

  server.tool(
    "brain_upsert_user_policy",
    describeMcpTool(profile, "Cria ou atualiza via MCP uma política granular por usuário (papéis, ações, políticas, domínios, prefixos e agentes vinculados que herdam tudo que o usuário pode fazer)."),
    {
      projectId: z.string().min(1),
      userId: z.string().min(1),
      linkedAgentIds: z.array(z.string()).default([]),
      inheritUserPermissions: z.boolean().default(true),
      roles: z.array(z.string()).default(["developer", "tech-lead"]),
      allowedActions: z
        .array(z.enum(["read", "write", "create", "update", "approve", "manage_policies"]))
        .default(["read", "write", "create", "update", "approve", "manage_policies"]),
      allowedPolicies: z.array(z.string()).default(["public-org", "internal-project"]),
      allowedDomains: z.array(z.number().int().positive()).default([]),
      allowedPathPrefixes: z.array(z.string()).default([])
    },
    async ({
      projectId,
      userId,
      linkedAgentIds,
      inheritUserPermissions,
      roles,
      allowedActions,
      allowedPolicies,
      allowedDomains,
      allowedPathPrefixes
    }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível para salvar política de usuário.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      const canManage =
        effectiveCtx.roles.includes("admin") ||
        effectiveCtx.roles.includes("tech-lead") ||
        effectiveCtx.roles.includes("appsec") ||
        effectiveCtx.allowedActions?.includes("manage_policies") ||
        effectiveCtx.inheritUserPermissions === true;
      if (!canManage) {
        throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Sem permissão para gerenciar políticas granulares de usuário.", 403);
      }
      const saved = await runtime.opRepo.upsertUserFineGrainedPolicy(effectiveCtx, projectId, {
        userId,
        linkedAgentIds,
        inheritUserPermissions,
        roles,
        allowedActions,
        allowedPolicies,
        allowedDomains,
        allowedPathPrefixes
      });
      await runtime.audit.record({
        tenantId: effectiveCtx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: effectiveCtx.actorId,
        actorType: effectiveCtx.actorType,
        action: "update",
        targetType: "user_policy",
        targetId: saved.userId,
        metadata: { linkedAgentIds: saved.linkedAgentIds, inheritUserPermissions: saved.inheritUserPermissions }
      });
      return okJson({ saved: true, projectId, policy: saved });
    }
  );

  server.tool(
    "brain_delete_user_policy",
    describeMcpTool(profile, "Remove uma política granular de usuário e seus vínculos de delegação para agentes."),
    {
      projectId: z.string().min(1),
      userId: z.string().min(1)
    },
    async ({ projectId, userId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível para remover política de usuário.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      const deleted = await runtime.opRepo.deleteUserFineGrainedPolicy(effectiveCtx, projectId, userId);
      if (deleted) {
        await runtime.audit.record({
          tenantId: effectiveCtx.tenantId,
          projectId,
          accessPolicyId: "internal-project",
          actorId: effectiveCtx.actorId,
          actorType: effectiveCtx.actorType,
          action: "update",
          targetType: "user_policy",
          targetId: userId,
          metadata: { deleted: true }
        });
      }
      return okJson({ deleted, projectId, userId });
    }
  );

  server.tool(
    "brain_list_permissions_catalog",
    describeMcpTool(profile, "Lista todas as permissões disponíveis do sistema agrupadas por módulo (menus, conhecimento, propostas, runner, operação, cargos e permissões)."),
    {},
    async () => okJson({ permissions: PERMISSION_CATALOG })
  );

  server.tool(
    "brain_list_roles",
    describeMcpTool(profile, "Lista todos os cargos (padrão e customizados) e suas permissões e políticas associadas."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "roles:view");
      const [roles, assignments] = await Promise.all([
        runtime.opRepo.listRoles(effectiveCtx, projectId),
        runtime.opRepo.listUserRoleAssignments(effectiveCtx, projectId)
      ]);
      return okJson({ projectId, roles, assignments });
    }
  );

  server.tool(
    "brain_upsert_role",
    describeMcpTool(profile, "Cria ou atualiza um cargo com permissões variadas de menus, funções e políticas."),
    {
      projectId: z.string().min(1),
      roleId: z.string().min(1),
      name: z.string().min(1),
      description: z.string().default(""),
      permissions: z.array(systemPermSchema),
      allowedPolicies: z.array(z.string()).default(["public-org", "internal-project"])
    },
    async ({ projectId, roleId, name, description, permissions, allowedPolicies }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "roles:manage");
      const role = await runtime.opRepo.upsertRole(effectiveCtx, projectId, {
        roleId,
        name,
        description,
        permissions,
        allowedPolicies
      });
      await runtime.audit.record({
        tenantId: effectiveCtx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: effectiveCtx.actorId,
        actorType: effectiveCtx.actorType,
        action: "update",
        targetType: "role",
        targetId: role.roleId,
        metadata: { permissionsCount: role.permissions.length }
      });
      return okJson({ saved: true, projectId, role });
    }
  );

  server.tool(
    "brain_delete_role",
    describeMcpTool(profile, "Remove um cargo customizado do projeto."),
    { projectId: z.string().min(1), roleId: z.string().min(1) },
    async ({ projectId, roleId }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "roles:manage");
      const deleted = await runtime.opRepo.deleteRole(effectiveCtx, projectId, roleId);
      return okJson({ deleted, projectId, roleId });
    }
  );

  server.tool(
    "brain_assign_user_roles",
    describeMcpTool(profile, "Atribui cargos a um usuário e vincula agentes que herdam integralmente todas as permissões do usuário (sem separação humano/IA)."),
    {
      projectId: z.string().min(1),
      userId: z.string().min(1),
      roleIds: z.array(z.string()).default(["developer"]),
      linkedAgentIds: z.array(z.string()).default([]),
      inheritUserPermissions: z.boolean().default(true),
      extraPermissions: z.array(systemPermSchema).default([]),
      deniedPermissions: z.array(systemPermSchema).default([]),
      allowedDomains: z.array(z.number().int().positive()).default([])
    },
    async ({
      projectId,
      userId,
      roleIds,
      linkedAgentIds,
      inheritUserPermissions,
      extraPermissions,
      deniedPermissions,
      allowedDomains
    }) => {
      assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Repositório operacional indisponível.", 503);
      }
      const effectiveCtx = await runtime.opRepo.resolveEffectiveAuthContext(ctx, projectId);
      assertPermission(effectiveCtx, "users:assign_roles");
      const assignment = await runtime.opRepo.upsertUserRoleAssignment(effectiveCtx, projectId, {
        userId,
        roleIds,
        linkedAgentIds,
        inheritUserPermissions,
        extraPermissions,
        deniedPermissions,
        allowedDomains
      });
      await runtime.audit.record({
        tenantId: effectiveCtx.tenantId,
        projectId,
        accessPolicyId: "internal-project",
        actorId: effectiveCtx.actorId,
        actorType: effectiveCtx.actorType,
        action: "update",
        targetType: "user_role_assignment",
        targetId: assignment.userId,
        metadata: { roleIds: assignment.roleIds, linkedAgentIds: assignment.linkedAgentIds, inheritUserPermissions: assignment.inheritUserPermissions }
      });
      return okJson({ saved: true, projectId, assignment });
    }
  );
}

