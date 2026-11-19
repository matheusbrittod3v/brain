import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import { computeProjectHealthReport } from "@brain/enterprise-views";
import type { BrainRuntime } from "./runtime.js";

/**
 * Registers native MCP Resources (`brain://projects/{projectId}/...`) and Prompts
 * so compatible clients (Codex, Cursor, Claude) can attach structured context directly.
 */
export function registerBrainResourcesAndPrompts(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext
): void {
  const projectListCb = async () => ({
    resources: ctx.allowedProjects.map((pid) => ({
      uri: `brain://projects/${pid}/overview`,
      name: `${pid} — Overview`
    }))
  });

  server.resource(
    "project-overview",
    new ResourceTemplate("brain://projects/{projectId}/overview", { list: projectListCb }),
    { description: "Resumo executivo e saúde de conhecimento do projeto", mimeType: "application/json" },
    async (uri, vars) => {
      const projectId = String(vars.projectId ?? "");
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 200 });
      const health = computeProjectHealthReport(hits.map((h) => h.item), []);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ projectId, totalItems: hits.length, health }, null, 2)
          }
        ]
      };
    }
  );

  server.resource(
    "project-active-rules",
    new ResourceTemplate("brain://projects/{projectId}/rules/active", { list: undefined }),
    { description: "Regras de negócio e invariantes ativas do projeto", mimeType: "application/json" },
    async (uri, vars) => {
      const projectId = String(vars.projectId ?? "");
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 150 });
      const rules = hits
        .map((h) => h.item)
        .filter((item) => item.status === "approved" && (item.type === "business_rule" || item.type === "architecture_decision"));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ projectId, count: rules.length, rules }, null, 2)
          }
        ]
      };
    }
  );

  server.resource(
    "project-topology-layer",
    new ResourceTemplate("brain://projects/{projectId}/topology/{layer}", { list: undefined }),
    { description: "Topologia Mermaid da camada solicitada (architecture, business, code, flows, data)", mimeType: "text/markdown" },
    async (uri, vars) => {
      const projectId = String(vars.projectId ?? "");
      const layer = String(vars.layer ?? "all");
      assertProjectAccess(ctx, projectId);
      const hits = await runtime.retrieval.search(ctx, { projectId, query: "", limit: 100 });
      const filtered = hits
        .map((h) => h.item)
        .filter((item) => layer === "all" || (item.metadata as Record<string, unknown> | undefined)?.knowledgeLayer === layer);
      const lines = ["```mermaid", "flowchart LR"];
      for (const item of filtered.slice(0, 30)) {
        lines.push(`  ${item.id.replace(/[^a-zA-Z0-9_]/g, "_")}["${item.title.replace(/"/g, "'")}"]`);
      }
      lines.push("```");
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: lines.join("\n") }]
      };
    }
  );

  server.resource(
    "project-skill",
    new ResourceTemplate("brain://projects/{projectId}/skills/{skillId}", { list: undefined }),
    { description: "Skill/runbook específico registrado no projeto", mimeType: "text/markdown" },
    async (uri, vars) => {
      const projectId = String(vars.projectId ?? "");
      const skillId = String(vars.skillId ?? "");
      assertProjectAccess(ctx, projectId);
      const item = await runtime.retrieval.getItem(ctx, projectId, skillId);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: item ? `# ${item.title}\n\n${item.content}` : `Skill '${skillId}' não encontrada em '${projectId}'.`
          }
        ]
      };
    }
  );

  server.prompt(
    "brain-pre-change-check",
    "Checklist obrigatório antes de alterar código em um projeto Brain.",
    { projectId: z.string(), taskDescription: z.string() },
    async ({ projectId, taskDescription }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Antes de alterar código no projeto "${projectId}" para: "${taskDescription}", execute:\n1. Chame brain_resolve_workspace_project e brain_get_active_rules(projectId="${projectId}").\n2. Chame brain_context_build para buscar arquitetura e fluxos relacionados.\n3. Ao propor mudanças, valide com brain_validate_implementation.`
          }
        }
      ]
    })
  );

  server.prompt(
    "brain-architecture-review",
    "Revisão arquitetural contra ADRs, regras de negócio e topologia cross-service.",
    { projectId: z.string(), changedFiles: z.string().optional() },
    async ({ projectId, changedFiles }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Revise as alterações no projeto "${projectId}" (${changedFiles || "arquivos do workspace"}) verificando ADRs e regras ativas com brain_get_active_rules, impacto com brain_analyze_change_impact e topologia com brain_export_topology_diagram.`
          }
        }
      ]
    })
  );

  server.prompt(
    "brain-handoff-summary",
    "Gera resumo estruturado e salva handoff para a próxima sessão.",
    { projectId: z.string(), summary: z.string() },
    async ({ projectId, summary }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Finalize a sessão no projeto "${projectId}" salvando o handoff via brain_create_handoff com decisões, próximos passos e pendências baseados em: ${summary}`
          }
        }
      ]
    })
  );
}
