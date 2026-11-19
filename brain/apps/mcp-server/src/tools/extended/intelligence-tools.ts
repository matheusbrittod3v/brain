import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertProjectAccess, type AuthContext } from "@brain/auth";
import type { KnowledgeItem } from "@brain/core";
import { describeMcpTool, type McpConnectionProfileName } from "../../connection-profile.js";
import { okJson } from "../../helpers.js";
import type { BrainRuntime } from "../../runtime.js";

export function registerIntelligenceTools(
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

  // 1. brain_dependency_map
  server.tool(
    "brain_dependency_map",
    describeMcpTool(profile, "Mapa de dependências navegável entre serviços, módulos, regras de negócio e documentos."),
    {
      projectId: z.string().optional().describe("ID do projeto (opcional, padrão do escopo atual)")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);

      const nodes = items.map((i: KnowledgeItem) => ({
        id: i.id,
        label: i.title,
        type: i.type,
        policy: i.accessPolicyId
      }));

      const edges: Array<{ from: string; to: string; relation: string }> = [];
      const nodeIds = new Set(nodes.map((n) => n.id));
      for (const item of items) {
        if (item.relatedIds) {
          for (const rel of item.relatedIds) {
            if (nodeIds.has(rel)) edges.push({ from: item.id, to: rel, relation: "depends_on" });
          }
        }
      }

      return okJson({
        projectId: pid,
        totalNodes: nodes.length,
        totalEdges: edges.length,
        nodes: nodes.slice(0, 50),
        edges: edges.slice(0, 100)
      });
    }
  );

  // 2. brain_change_assistant
  server.tool(
    "brain_change_assistant",
    describeMcpTool(profile, "Assistente de mudança: analisa plano/diff e aponta regras afetadas, arquivos e nível de risco."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      plan: z.string().optional().describe("Plano de implementação ou resumo da mudança"),
      diff: z.string().optional().describe("Diff de código ou git patch"),
      filePaths: z.array(z.string()).optional().describe("Lista de caminhos de arquivos modificados")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);
      const fullText = `${args.plan ?? ""} ${args.diff ?? ""} ${(args.filePaths ?? []).join(" ")}`.toLowerCase();

      const affectedRules = items.filter((i: KnowledgeItem) =>
        i.type === "business_rule" && (fullText.includes(i.id.toLowerCase()) || (i.tags ?? []).some((t: string) => fullText.includes(t.toLowerCase())))
      );

      const riskLevel = affectedRules.length >= 3 ? "critical" : affectedRules.length >= 1 ? "medium" : "low";

      return okJson({
        projectId: pid,
        riskLevel,
        affectedRulesCount: affectedRules.length,
        affectedRules: affectedRules.map((r: KnowledgeItem) => ({ id: r.id, title: r.title, policy: r.accessPolicyId })),
        recommendedReviewChecklist: [
          "Verificar testes unitários para as regras afetadas",
          "Garantir conformidade com isolamento RLS e políticas CASL",
          "Executar 'brain_validate_implementation' antes do commit"
        ]
      });
    }
  );

  // 3. brain_contradiction_detect
  server.tool(
    "brain_contradiction_detect",
    describeMcpTool(profile, "Detecta contradições e inconsistências entre regras de negócio, ADRs e políticas de acesso."),
    {
      projectId: z.string().optional().describe("ID do projeto")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);
      const rules = items.filter((i: KnowledgeItem) => i.type === "business_rule" || i.type === "architecture_decision");

      const contradictions: Array<{ ruleA: string; ruleB: string; issue: string }> = [];
      for (let i = 0; i < rules.length; i++) {
        for (let j = i + 1; j < rules.length; j++) {
          const a = rules[i]!;
          const b = rules[j]!;
          if (a.accessPolicyId === "restricted-security" && b.accessPolicyId === "public-org" && a.content.includes("auth") && b.content.includes("auth")) {
            contradictions.push({
              ruleA: `${a.id} (${a.title})`,
              ruleB: `${b.id} (${b.title})`,
              issue: "Divergência de política de segurança entre regras de autenticação"
            });
          }
        }
      }

      return okJson({
        projectId: pid,
        contradictionsFound: contradictions.length,
        contradictions
      });
    }
  );

  // 4. brain_decision_timeline
  server.tool(
    "brain_decision_timeline",
    describeMcpTool(profile, "Linha do tempo histórica de decisões de arquitetura (ADRs) e regras de negócio com versões."),
    {
      projectId: z.string().optional().describe("ID do projeto")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);
      const decisions = items
        .filter((i: KnowledgeItem) => i.type === "architecture_decision" || i.id.startsWith("ADR-"))
        .sort((a: KnowledgeItem, b: KnowledgeItem) => b.updatedAt.localeCompare(a.updatedAt));

      return okJson({
        projectId: pid,
        totalDecisions: decisions.length,
        timeline: decisions.map((d: KnowledgeItem) => ({
          id: d.id,
          title: d.title,
          status: d.status,
          version: d.version,
          updatedAt: d.updatedAt
        }))
      });
    }
  );

  // 5. brain_onboarding_guide
  server.tool(
    "brain_onboarding_guide",
    describeMcpTool(profile, "Gera o guia de onboarding e convenções de arquitetura do projeto para novos desenvolvedores e agentes."),
    {
      projectId: z.string().optional().describe("ID do projeto")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);
      const vision = items.find((i: KnowledgeItem) => i.id.includes("VIS") || i.title.toLowerCase().includes("visão"))?.content ?? "Plataforma multi-projeto corporativa.";
      const topRules = items.filter((i: KnowledgeItem) => i.type === "business_rule").slice(0, 5).map((r: KnowledgeItem) => `${r.id}: ${r.title}`);
      const topAdrs = items.filter((i: KnowledgeItem) => i.type === "architecture_decision").slice(0, 5).map((a: KnowledgeItem) => `${a.id}: ${a.title}`);

      return okJson({
        projectId: pid,
        vision,
        keyDecisions: topAdrs,
        criticalBusinessRules: topRules,
        recommendedSetupSteps: [
          "1. bun install ou npm install",
          "2. bun run infra:up (PostgreSQL pgvector, Valkey, MinIO)",
          "3. brain doctor para validar prontidão",
          "4. Consulte regras e execute validações antes de abrir PRs"
        ]
      });
    }
  );

  // 6. brain_project_qa
  server.tool(
    "brain_project_qa",
    describeMcpTool(profile, "Responde perguntas sobre o projeto com citações explícitas de regras, ADRs e código indexado."),
    {
      projectId: z.string().optional().describe("ID do projeto"),
      question: z.string().describe("Pergunta sobre arquitetura, regras ou funcionamento")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const hits = await runtime.retrieval.search(ctx, { projectId: pid, query: args.question, limit: 5 });
      const citations = hits.map((h) => ({
        id: h.item.id,
        title: h.item.title,
        type: h.item.type,
        excerpt: h.item.summary ?? h.item.content.slice(0, 180)
      }));

      return okJson({
        projectId: pid,
        question: args.question,
        citations,
        summaryAnswer: citations.length > 0
          ? `Com base em ${citations.length} item(ns) indexado(s), os comportamentos fundamentados são:\n` + citations.map((c) => `- [${c.id}] ${c.title}: ${c.excerpt}`).join("\n")
          : "Nenhum documento diretamente correlacionado encontrado no projeto."
      });
    }
  );

  // 7. brain_tech_debt_radar
  server.tool(
    "brain_tech_debt_radar",
    describeMcpTool(profile, "Painel de dívida técnica: calcula riscos, regras sem testes, decisões antigas e dependências frágeis."),
    {
      projectId: z.string().optional().describe("ID do projeto")
    },
    async (args) => {
      const pid = args.projectId || ctx.allowedProjects[0] || "brain";
      assertProjectAccess(ctx, pid);
      const items = await fetchItems(pid, 200);

      const rules = items.filter((i: KnowledgeItem) => i.type === "business_rule");
      const tests = items.filter((i: KnowledgeItem) => i.type === "test");
      const untestedRules = rules.filter((r: KnowledgeItem) => !tests.some((t: KnowledgeItem) => t.id.includes(r.id) || t.content.includes(r.id)));
      const activeRisks = items.filter((i: KnowledgeItem) => i.type === "risk" || i.type === "risk_control");

      const score = Math.max(0, 100 - untestedRules.length * 4 - activeRisks.length * 5);

      return okJson({
        projectId: pid,
        debtHealthScore: score,
        untestedRulesCount: untestedRules.length,
        activeRisksCount: activeRisks.length,
        untestedRules: untestedRules.map((r: KnowledgeItem) => ({ id: r.id, title: r.title }))
      });
    }
  );
}
