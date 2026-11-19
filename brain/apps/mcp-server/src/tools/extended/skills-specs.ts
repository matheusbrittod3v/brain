import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertPolicyAccess, assertProjectAccess, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem } from "@brain/core";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

export function registerExtendedSkillsSpecsTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  profile: McpConnectionProfileName
): void {
  server.tool(
    "brain_list_skills",
    describeMcpTool(profile, "Lista todas as Skills centralizadas (.brain/skills) do projeto e globais da organização (__org__) para agentes de IA."),
    {
      projectId: z.string().min(1),
      includeContent: z.boolean().default(false)
    },
    async ({ projectId, includeContent }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 200 });
      const projectSkills = hits
        .map((h) => h.item)
        .filter((item) => item.type === "skill" && item.status !== "deprecated")
        .map((item) => ({
          id: item.id,
          title: item.title,
          scope: "project" as const,
          summary: item.summary ?? "",
          tags: item.tags,
          status: item.status,
          version: item.version,
          ...(includeContent ? { content: item.content } : {})
        }));

      let orgSkills: typeof projectSkills = [];
      if (projectId !== "__org__" && (ctx.allowedProjects.includes("__org__") || ctx.roles.includes("admin"))) {
        try {
          const orgCtx = { ...ctx, allowedProjects: [...new Set([...ctx.allowedProjects, "__org__"])] };
          const orgHits = await runtime.retrieval.search(orgCtx, { projectId: "__org__", query: "", limit: 200 });
          orgSkills = orgHits
            .map((h) => h.item)
            .filter((item) => item.type === "skill" && item.status !== "deprecated")
            .map((item) => ({
              id: item.id,
              title: item.title,
              scope: "project" as const,
              summary: item.summary ?? "",
              tags: item.tags,
              status: item.status,
              version: item.version,
              ...(includeContent ? { content: item.content } : {})
            }));
        } catch {
          // __org__ optional
        }
      }
      const skills = [...projectSkills, ...orgSkills];
      return okJson({ projectId, count: skills.length, skills });
    }
  );

  server.tool(
    "brain_get_skill",
    describeMcpTool(profile, "Carrega as instruções completas de uma Skill específica do projeto ou global (__org__) para o agente seguir."),
    {
      projectId: z.string().min(1),
      skillIdOrName: z.string().min(1)
    },
    async ({ projectId, skillIdOrName }) => {
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 200 });
      const needle = skillIdOrName.trim().toLowerCase();
      let skill = hits
        .map((h) => h.item)
        .find(
          (item) =>
            item.type === "skill" &&
            (item.id.toLowerCase() === needle || item.title.toLowerCase() === needle)
        );
      if (!skill && projectId !== "__org__" && (ctx.allowedProjects.includes("__org__") || ctx.roles.includes("admin"))) {
        const orgCtx = { ...ctx, allowedProjects: [...new Set([...ctx.allowedProjects, "__org__"])] };
        const orgHits = await runtime.retrieval.search(orgCtx, { projectId: "__org__", query: "", limit: 200 });
        skill = orgHits
          .map((h) => h.item)
          .find(
            (item) =>
              item.type === "skill" &&
              (item.id.toLowerCase() === needle || item.title.toLowerCase() === needle)
          );
      }
      if (!skill) {
        throw new BrainError("BRAIN_ERR_NOT_FOUND", `Skill '${skillIdOrName}' não encontrada em '${projectId}'.`, 404);
      }
      return okJson({ skill });
    }
  );

  server.tool(
    "brain_upsert_knowledge_spec",
    describeMcpTool(profile, "Cria ou atualiza uma Spec, Skill, Regra ou Documento no Hub de Conhecimento e Planejamento do projeto."),
    {
      projectId: z.string().min(1),
      id: z.string().min(1).optional(),
      title: z.string().min(1),
      type: z.enum(["skill", "spec", "business_rule", "architecture_decision", "document", "requirement"]).default("spec"),
      content: z.string().min(1),
      summary: z.string().optional(),
      tags: z.array(z.string()).default([]),
      accessPolicyId: z.string().default("internal-project")
    },
    async ({ projectId, id, title, type, content, summary, tags, accessPolicyId }) => {
      assertProjectAccess(ctx, projectId);
      assertPolicyAccess(ctx, accessPolicyId);
      const itemId =
        id?.trim() ||
        `${type.toUpperCase()}-${title
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 32)}-${randomUUID().slice(0, 4).toUpperCase()}`;
      const existingHits = await runtime.retrieval.search(ctx, { projectId, query: itemId, limit: 20 });
      const existing = existingHits.map((h) => h.item).find((i) => i.id === itemId);
      const now = new Date().toISOString();
      const item: KnowledgeItem = {
        id: itemId,
        tenantId: ctx.tenantId,
        projectId,
        domainId: 2,
        type,
        title: title.trim(),
        content,
        ...(summary ? { summary } : {}),
        status: existing?.status ?? "draft",
        sourceId: "mcp-hub",
        sourceOrigin: "internal",
        sourceKind: "agent",
        sourceVersion: existing ? `v${existing.version + 1}` : "v1",
        sourceUri: type === "skill" ? `.brain/skills/${itemId}/SKILL.md` : `.brain/specs/${itemId}.md`,
        version: existing ? existing.version + 1 : 1,
        contentHash: createHash("sha256").update(content).digest("hex"),
        ownerId: ctx.actorId,
        confidence: 1,
        trustLevel: existing?.trustLevel ?? "self_authored",
        isInferred: false,
        tags,
        relatedIds: existing?.relatedIds ?? [],
        accessPolicyId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (runtime.knowledge?.upsertItem) {
        await runtime.knowledge.upsertItem(ctx, item);
      }
      if (runtime.retrieval.upsertItem) {
        runtime.retrieval.upsertItem(item);
      }
      runtime.retrieval.invalidateCache?.(ctx.tenantId, projectId);
      await runtime.audit.record({
        tenantId: ctx.tenantId,
        projectId,
        accessPolicyId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: existing ? "update" : "create",
        targetType: "knowledge_item",
        targetId: item.id,
        metadata: { type: item.type, version: item.version }
      });
      return okJson({ saved: true, created: !existing, item });
    }
  );
}

