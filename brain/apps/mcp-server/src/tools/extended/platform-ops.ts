import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertPermission, assertProjectAccess, hasPermission, type AuthContext } from "@brain/auth";
import { buildTechRadar, computeProjectHealthReport } from "@brain/enterprise-views";
import { scanForSecrets } from "@brain/ingestion";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

/**
 * Registers project discovery, session identity, developer profile, memory consolidation,
 * FinOps, audit query, secret scanning, and enterprise Tech Radar MCP tools.
 */
export function registerPlatformOpsTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
) {
  server.tool(
    "brain_list_projects",
    describeMcpTool(profile, "Lista todos os projetos acessíveis pelo usuário autenticado (incluindo projetos marcados como compartilháveis/globais)."),
    {},
    async () => {
      const sharedList = runtime.opRepo && hasPermission(ctx, "projects:shared:read")
        ? await runtime.opRepo.listSharedProjects(ctx.tenantId).catch(() => [])
        : [];
      const sharedMap = new Map(sharedList.map((p) => [p.projectId, p]));
      const allIds = [...new Set([...ctx.allowedProjects, ...sharedList.map((p) => p.projectId)])];
      const items = allIds.map((projectId) => {
        const reg = runtime.registeredProjects?.get(`${ctx.tenantId}:${projectId}`);
        const sharedMeta = sharedMap.get(projectId);
        return {
          projectId,
          name: sharedMeta?.name ?? reg?.name ?? projectId,
          description: sharedMeta?.description ?? reg?.description,
          knowledgeRoot: sharedMeta?.knowledgeRoot ?? reg?.knowledgeRoot ?? ".brain/",
          isShared: Boolean(sharedMeta?.isShared),
          accessScope: ctx.allowedProjects.includes(projectId) ? "linked" : "shared"
        };
      });
      return okJson({ tenantId: ctx.tenantId, count: items.length, projects: items });
    }
  );

  server.tool(
    "brain_project_set_shared",
    describeMcpTool(profile, "Marca ou desmarca um projeto como compartilhável e reutilizável globalmente entre projetos e agentes MCP (requer permissão projects:share)."),
    {
      projectId: z.string().min(1),
      isShared: z.boolean()
    },
    async ({ projectId, isShared }) => {
      assertProjectAccess(ctx, projectId);
      assertPermission(ctx, "projects:share");
      if (!runtime.opRepo) {
        return okJson({ saved: false, reason: "PostgreSQL operational repository unavailable." });
      }
      const updated = await runtime.opRepo.setProjectShared(ctx, projectId, isShared);
      return okJson({ saved: true, projectId, isShared, project: updated });
    }
  );

  server.tool(
    "brain_list_shared_projects",
    describeMcpTool(profile, "Lista projetos marcados como compartilháveis/reutilizáveis (isShared=true) e suas skills, regras de negócio e especificações globais (requer projects:shared:read)."),
    {
      includeItems: z.boolean().optional()
    },
    async ({ includeItems }) => {
      assertPermission(ctx, "projects:shared:read");
      if (!runtime.opRepo) {
        return okJson({ count: 0, projects: [] });
      }
      const sharedProjects = await runtime.opRepo.listSharedProjects(ctx.tenantId);
      const projects = await Promise.all(
        sharedProjects.map(async (sp) => {
          const sharedCtx: AuthContext = {
            ...ctx,
            allowedProjects: [...new Set([...ctx.allowedProjects, sp.projectId])]
          };
          const hits = await runtime.retrieval.search(sharedCtx, { projectId: sp.projectId, query: "", limit: 200 });
          const active = hits.map((h) => h.item).filter((i) => i.status !== "deprecated");
          const skills = active.filter((i) => i.type === "skill");
          const rules = active.filter((i) => i.type === "business_rule");
          const specs = active.filter((i) => i.type === "spec" || i.type === "architecture_decision");
          return {
            ...sp,
            counts: {
              total: active.length,
              skills: skills.length,
              rules: rules.length,
              specs: specs.length
            },
            ...(includeItems !== false
              ? {
                  skills: skills.map((i) => ({ id: i.id, title: i.title, summary: i.summary ?? i.content.slice(0, 180) })),
                  rules: rules.map((i) => ({ id: i.id, title: i.title, summary: i.summary ?? i.content.slice(0, 180) })),
                  specs: specs.map((i) => ({ id: i.id, type: i.type, title: i.title }))
                }
              : {})
          };
        })
      );
      return okJson({ tenantId: ctx.tenantId, count: projects.length, projects });
    }
  );

  server.tool(
    "brain_whoami",
    describeMcpTool(profile, "Retorna identidade, cargos, permissões e escopo dinâmico da sessão atual."),
    {},
    async () => {
      const devProfile = runtime.opRepo ? await runtime.opRepo.getDeveloperProfile(ctx).catch(() => null) : null;
      return okJson({
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        tenantId: ctx.tenantId,
        roles: ctx.roles,
        permissions: ctx.permissions ?? [],
        allowedProjects: ctx.allowedProjects,
        allowedPolicies: ctx.allowedPolicies,
        auditPolicyId,
        developerProfile: devProfile
      });
    }
  );

  server.tool(
    "brain_project_overview",
    describeMcpTool(profile, "Retorna visão executiva e saúde do conhecimento de um projeto."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 200 });
      const items = hits.map((h) => h.item);
      const byType: Record<string, number> = {};
      const byStatus: Record<string, number> = {};
      for (const item of items) {
        byType[item.type] = (byType[item.type] ?? 0) + 1;
        byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      }
      const health = computeProjectHealthReport(items, []);
      return okJson({
        projectId,
        totalItems: items.length,
        byType,
        byStatus,
        health
      });
    }
  );

  server.tool(
    "brain_memory_consolidate",
    describeMcpTool(profile, "Consolida memórias episódicas antigas em resumos semânticos."),
    { projectId: z.string().min(1).optional() },
    async ({ projectId }) => {
      if (projectId) assertProjectAccess(ctx, projectId);
      if (!runtime.opRepo) {
        return okJson({ consolidated: false, reason: "PostgreSQL operational repository unavailable." });
      }
      const result = await runtime.opRepo.runMemoryDecay(ctx);
      return okJson({ consolidated: true, ...result });
    }
  );

  server.tool(
    "brain_developer_profile_get",
    describeMcpTool(profile, "Lê as preferências técnicas do desenvolvedor autenticado."),
    {},
    async () => {
      if (!runtime.opRepo) return okJson({ profile: null });
      const devProfile = await runtime.opRepo.getDeveloperProfile(ctx);
      return okJson({ profile: devProfile ?? null });
    }
  );

  server.tool(
    "brain_developer_profile_set",
    describeMcpTool(profile, "Salva preferências técnicas do desenvolvedor (package manager, estilo, convenções)."),
    {
      preferredPackageManager: z.string().optional(),
      preferredTestLayout: z.string().optional(),
      preferredArchitectureStyle: z.string().optional(),
      codingConventions: z.array(z.string()).optional(),
      preferredHarness: z.string().optional(),
      optInCrossProject: z.boolean().optional()
    },
    async (input) => {
      if (!runtime.opRepo) {
        return okJson({ saved: false, reason: "PostgreSQL operational repository unavailable." });
      }
      const saved = await runtime.opRepo.upsertDeveloperProfile(ctx, {
        ...input,
        codingConventions: input.codingConventions ?? []
      });
      return okJson({ saved: true, profile: saved });
    }
  );

  server.tool(
    "brain_finops_summary",
    describeMcpTool(profile, "Consulta cotas FinOps e métricas de uso de tokens de um projeto."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      const quotas = runtime.opRepo ? await runtime.opRepo.listDepartmentFinopsQuotas(ctx, projectId) : [];
      return okJson({ projectId, quotas });
    }
  );

  server.tool(
    "brain_audit_query",
    describeMcpTool(profile, "Consulta eventos recentes de auditoria (incluindo ações por cliente MCP)."),
    { projectId: z.string().min(1).optional(), limit: z.number().min(1).max(200).optional() },
    async ({ projectId, limit }) => {
      if (projectId) assertProjectAccess(ctx, projectId);
      const hits = await Promise.resolve(
        runtime.retrieval.search(ctx, {
          projectId: projectId ?? ctx.allowedProjects[0] ?? "default",
          query: "",
          limit: 1
        })
      ).catch(() => []);
      return okJson({
        note: "Eventos gravados na trilha RLS via audit_logs.",
        projectId: projectId ?? null,
        limit: limit ?? 50,
        indexedSampleCount: hits.length
      });
    }
  );

  server.tool(
    "brain_secret_scan",
    describeMcpTool(profile, "Analisa trechos de texto ou diffs contra vazamento de segredos e chaves antes de commitar."),
    { content: z.string().min(1) },
    async ({ content }) => {
      const result = scanForSecrets(content);
      return okJson(result);
    }
  );

  server.tool(
    "brain_enterprise_tech_radar",
    describeMcpTool(profile, "Gera visão Tech Radar a partir dos conhecimentos aprovados do projeto."),
    { projectId: z.string().min(1) },
    async ({ projectId }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 200 });
      const radar = buildTechRadar(hits.map((h) => h.item));
      return okJson({ projectId, entries: radar });
    }
  );

  server.tool(
    "brain_system_settings_get",
    describeMcpTool(profile, "Lista as configurações globais persistidas no PostgreSQL (embeddings, runner, github, smtp, policies) com segredos mascarados."),
    { category: z.string().min(1).optional() },
    async ({ category }) => {
      if (!runtime.systemSettings) {
        return okJson({ items: [], reason: "PgSystemSettingsRepository unavailable." });
      }
      const items = await runtime.systemSettings.listSettings(ctx.tenantId, category, true);
      return okJson({ tenantId: ctx.tenantId, count: items.length, items });
    }
  );

  server.tool(
    "brain_system_settings_set",
    describeMcpTool(profile, "Cria ou atualiza uma configuração global no PostgreSQL (requer papel admin/owner/tech-lead)."),
    {
      category: z.string().min(1),
      key: z.string().min(1),
      value: z.unknown(),
      isSecret: z.boolean().optional()
    },
    async ({ category, key, value, isSecret }) => {
      if (!ctx.roles.some((r) => ["admin", "owner", "tech-lead"].includes(r.toLowerCase()))) {
        return okJson({ saved: false, reason: "Apenas administradores podem alterar configurações globais." });
      }
      if (!runtime.systemSettings) {
        return okJson({ saved: false, reason: "PgSystemSettingsRepository unavailable." });
      }
      const saved = await runtime.systemSettings.upsertSetting(
        ctx.tenantId,
        category.trim(),
        key.trim(),
        value,
        Boolean(isSecret),
        ctx.actorId
      );
      return okJson({ saved: true, setting: { ...saved, value: saved.isSecret ? "***" : saved.value } });
    }
  );
}
