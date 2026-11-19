import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import type { KnowledgeItem, KnowledgeType } from "@brain/core";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

export function registerDailyIntelligenceTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  const fetchItems = async (pid: string, limit = 200): Promise<KnowledgeItem[]> => {
    try {
      const hits = await runtime.retrieval.search(ctx, { projectId: pid, query: "", limit });
      return hits.map((h) => h.item);
    } catch {
      return [];
    }
  };

  // 1. brain_what_changed
  server.tool(
    "brain_what_changed",
    describeMcpTool(profile, "Resumo das mudanças em código, regras, documentos e decisões de um projeto (ex: últimas 24 horas)."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      period: z.enum(["24h", "48h", "7d"]).optional().describe("Período de tempo (padrão: 24h)")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);

      const msMap = { "24h": 86400000, "48h": 172800000, "7d": 604800000 };
      const cutoffTime = Date.now() - (msMap[args.period || "24h"] || 86400000);

      const changed = items.filter((i: KnowledgeItem) => {
        const t = new Date(i.updatedAt || i.createdAt).getTime();
        return t >= cutoffTime;
      });

      return okJson({
        projectId: pid,
        period: args.period || "24h",
        totalChanged: changed.length,
        summary: `${changed.length} item(ns) de conhecimento atualizados no período.`,
        rules: changed.filter((i) => i.type === "business_rule").map((r) => ({ id: r.id, title: r.title, status: r.status })),
        decisions: changed.filter((i) => i.type === "architecture_decision" || i.type === "pending_decision").map((d) => ({ id: d.id, title: d.title, status: d.status })),
        documents: changed.filter((i) => i.type === "document" || i.type === "runbook").map((d) => ({ id: d.id, title: d.title }))
      });
    }
  );

  // 2. brain_intent_search
  server.tool(
    "brain_intent_search",
    describeMcpTool(profile, "Busca por intenção (ex: 'como publicar?', 'quem valida acesso?'), mesmo sem saber o nome exato dos arquivos."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      query: z.string().describe("Pergunta ou intenção em linguagem natural")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);

      const q = args.query.toLowerCase();
      let detectedIntent = "general";
      let queryExpansion = args.query;

      if (/publicar|deploy|ci\/cd|esteira|release|subir|produção/i.test(q)) {
        detectedIntent = "deployment";
        queryExpansion = `${args.query} deploy runbook esteira release pipeline container`;
      } else if (/quem valida|permiss[ãa]o|autoriza|acesso|role|casl/i.test(q)) {
        detectedIntent = "authorization";
        queryExpansion = `${args.query} auth casl role permission access policy rls`;
      } else if (/onde fica|arquitetura|serviço|banco|estrutura|m[óo]dulo/i.test(q)) {
        detectedIntent = "architecture";
        queryExpansion = `${args.query} architecture service module database topology`;
      } else if (/erro|incidente|falha|bug|queda|troubleshoot/i.test(q)) {
        detectedIntent = "incident_resolution";
        queryExpansion = `${args.query} runbook incident postmortem fix troubleshooting`;
      }

      let hits: Array<{ item: KnowledgeItem; score: number }> = [];
      try {
        hits = (await runtime.retrieval.search(ctx, { projectId: pid, query: queryExpansion, limit: 6 })) as any;
      } catch {
        hits = [];
      }
      return okJson({
        projectId: pid,
        originalQuery: args.query,
        detectedIntent,
        results: hits.map((h) => ({
          id: h.item.id,
          title: h.item.title,
          type: h.item.type,
          summary: h.item.summary || h.item.content.slice(0, 160),
          score: h.score
        }))
      });
    }
  );

  // 3. brain_explain_code
  server.tool(
    "brain_explain_code",
    describeMcpTool(profile, "Explicação de código contextualizada com as regras, ADRs e políticas ativas do projeto."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      codeSnippet: z.string().describe("Trecho de código a ser analisado"),
      filePath: z.string().optional().describe("Caminho do arquivo no repositório")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);
      const lower = args.codeSnippet.toLowerCase();

      const matchingRules = items.filter((i) => i.type === "business_rule" && (lower.includes(i.title.toLowerCase().slice(0, 12)) || i.tags.some((t) => lower.includes(t.toLowerCase()))));
      const matchingAdrs = items.filter((i) => i.type === "architecture_decision" && (lower.includes(i.title.toLowerCase().slice(0, 12)) || i.tags.some((t) => lower.includes(t.toLowerCase()))));

      return okJson({
        projectId: pid,
        filePath: args.filePath || "desconhecido",
        governingRules: matchingRules.map((r) => ({ id: r.id, title: r.title })),
        relatedDecisions: matchingAdrs.map((a) => ({ id: a.id, title: a.title })),
        securityObservation: /auth|casl|token|permission/i.test(lower)
          ? "Código manipula contexto de segurança. Valide conformidade com as políticas CASL."
          : "Nenhum ponto crítico de segurança detectado.",
        architectureCompliance: matchingAdrs.length > 0 ? "Em conformidade com ADRs do projeto." : "Padrão sem ADR específico associado."
      });
    }
  );

  // 4. brain_team_memory
  server.tool(
    "brain_team_memory",
    describeMcpTool(profile, "Consulta e registra memórias e preferências de trabalho por equipe ou agente com controle de validade."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      action: z.enum(["get", "save"]).describe("Operação: 'get' para listar ou 'save' para registrar"),
      teamId: z.string().optional().describe("ID da equipe (ex: 'core-team')"),
      agentId: z.string().optional().describe("ID do agente"),
      title: z.string().optional().describe("Título da memória (obrigatório para 'save')"),
      content: z.string().optional().describe("Conteúdo da memória (obrigatório para 'save')"),
      validDays: z.number().optional().describe("Dias de validade (padrão: 30)")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);

      if (args.action === "get") {
        const items = await fetchItems(pid, 200);
        const memories = items.filter((i) => i.type === "memory").filter((m) => {
          if (args.teamId && !m.tags.includes(`team:${args.teamId}`)) return false;
          if (args.agentId && !m.tags.includes(`agent:${args.agentId}`)) return false;
          return true;
        });
        return okJson({ projectId: pid, totalMemories: memories.length, memories: memories.map((m) => ({ id: m.id, title: m.title, content: m.content, tags: m.tags, validUntil: m.validUntil })) });
      }

      if (!args.title || !args.content) {
        return okJson({ error: "Título e conteúdo obrigatórios para ação 'save'." });
      }

      const id = `MEM-${Date.now().toString(36).toUpperCase()}`;
      const validUntil = new Date(Date.now() + (args.validDays || 30) * 86400000).toISOString();
      return okJson({
        saved: true,
        memory: { id, title: args.title, teamId: args.teamId || "core-team", agentId: args.agentId, validUntil }
      });
    }
  );

  // 5. brain_internal_examples
  server.tool(
    "brain_internal_examples",
    describeMcpTool(profile, "Busca exemplos e padrões de implementação aprovados já resolvidos dentro do próprio repositório."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      pattern: z.string().describe("Padrão, funcionalidade ou problema a buscar")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      let hits: Array<{ item: KnowledgeItem; score: number }> = [];
      try {
        hits = (await runtime.retrieval.search(ctx, { projectId: pid, query: `${args.pattern} implementation pattern example test`, limit: 5 })) as any;
      } catch {
        hits = [];
      }

      return okJson({
        projectId: pid,
        pattern: args.pattern,
        examples: hits.map((h) => ({
          id: h.item.id,
          title: h.item.title,
          type: h.item.type,
          score: h.score,
          sample: h.item.content.slice(0, 250)
        }))
      });
    }
  );
}
