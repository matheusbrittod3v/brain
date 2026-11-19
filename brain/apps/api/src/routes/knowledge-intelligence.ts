import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { authenticateRequest, usersStore, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem, type KnowledgeType, type KnowledgeProvenance } from "@brain/core";
import type { PgAuthRepository, PgOperationalRepository, PgSystemSettingsRepository } from "@brain/database";
import type { PostgresKnowledgeRepository } from "@brain/knowledge";
import type { AsyncRetrievalEngine, PostgresRetrievalEngine } from "@brain/retrieval";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import type { CrossServiceContractRegistry } from "@brain/cross-service";

export interface KnowledgeIntelligenceDeps {
  configuredApiKey: string;
  allowedProjects: readonly string[];
  allowedPolicies: readonly string[];
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  opRepo?: PgOperationalRepository;
  authRepo?: PgAuthRepository;
  systemSettingsRepo?: PgSystemSettingsRepository;
  queryAwareRetrieval: AsyncRetrievalEngine;
  pgKnowledge?: PostgresKnowledgeRepository;
  graph?: KnowledgeGraphStore | PostgresGraphStore;
  crossService?: CrossServiceContractRegistry;
}

export function registerKnowledgeIntelligenceRoutes(
  app: FastifyInstance,
  deps: KnowledgeIntelligenceDeps
) {
  const {
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    recordAudit,
    opRepo,
    authRepo,
    queryAwareRetrieval,
    pgKnowledge,
    graph
  } = deps;

  const authUser = async (headerValue: string | undefined): Promise<AuthContext> => {
    const rawCtx = await authenticateRequest(headerValue, configuredApiKey, "default-org", allowedProjects, undefined, allowedPolicies);
    const dbUser = authRepo ? await authRepo.findUserById(rawCtx.actorId) : null;
    const memUser = !dbUser && rawCtx.actorId !== "local-dev" ? usersStore.getUserById(rawCtx.actorId) : null;
    const fresh = dbUser ?? memUser;
    const baseCtx: AuthContext = fresh
      ? { ...rawCtx, roles: fresh.roles, allowedProjects: fresh.allowedProjects, allowedPolicies: fresh.allowedPolicies }
      : rawCtx;
    return opRepo
      ? await opRepo.resolveDynamicMcpScope(baseCtx, fresh ? [] : allowedProjects, allowedPolicies)
      : baseCtx;
  };

  const getProjectKnowledge = async (ctx: AuthContext, projectId: string, limit = 200): Promise<KnowledgeItem[]> => {
    const searchCtx: AuthContext = {
      ...ctx,
      allowedProjects: [...new Set([...ctx.allowedProjects, projectId])]
    };
    const hits = await queryAwareRetrieval.search(searchCtx, { projectId, query: "", limit }).catch(() => []);
    return hits.map((h) => h.item);
  };

  // 1. Mapa de Dependências Navegável
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/intelligence/dependency-map", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);

    const nodes = items.map((item) => {
      const isService = item.type === "service" || item.id.startsWith("SVC-");
      const isRule = item.type === "business_rule" || item.id.startsWith("BR-");
      const isContract = item.type === "api_contract" || item.type === "event_contract" || item.id.startsWith("SPEC-");
      const isDoc = item.type === "document" || item.type === "architecture_decision" || item.id.startsWith("ADR-");
      const isModel = item.type === "data_model" || item.type === "product_capability";

      let category: "service" | "module" | "business_rule" | "document" | "contract" | "data_model" = "document";
      if (isService) category = "service";
      else if (isRule) category = "business_rule";
      else if (isContract) category = "contract";
      else if (isModel) category = "data_model";
      else if (item.type === "code_symbol") category = "module";

      return {
        id: item.id,
        label: item.title,
        type: item.type,
        category,
        accessPolicyId: item.accessPolicyId,
        status: item.status,
        confidence: item.confidence,
        tags: item.tags ?? []
      };
    });

    const edges: Array<{ from: string; to: string; relation: string; strength: number }> = [];
    const nodeIds = new Set(nodes.map((n) => n.id));

    for (const item of items) {
      if (item.relatedIds && Array.isArray(item.relatedIds)) {
        for (const targetId of item.relatedIds) {
          if (nodeIds.has(targetId)) {
            edges.push({ from: item.id, to: targetId, relation: "depends_on", strength: 0.9 });
          }
        }
      }
      // Inferência semântica de dependências
      if (item.type === "business_rule") {
        for (const candidate of items) {
          if (candidate.type === "test" && (candidate.content.includes(item.id) || candidate.id.includes(item.id))) {
            edges.push({ from: candidate.id, to: item.id, relation: "verifies", strength: 1.0 });
          }
        }
      }
      if (item.type === "service" || item.type === "product_capability") {
        for (const candidate of items) {
          if ((candidate.type === "business_rule" || candidate.type === "api_contract") && candidate.content.includes(item.id)) {
            edges.push({ from: item.id, to: candidate.id, relation: "governs", strength: 0.8 });
          }
        }
      }
    }

    return {
      projectId: req.params.projectId,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      categories: ["service", "module", "business_rule", "document", "contract", "data_model"],
      nodes,
      edges
    };
  });

  // 2. Assistente de Mudança (Change Impact Assistant)
  app.post<{
    Params: { projectId: string };
    Body: { plan?: string; diff?: string; filePaths?: string[]; targetIds?: string[] };
  }>("/v1/projects/:projectId/intelligence/change-assistant", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);
    const { plan = "", diff = "", filePaths = [], targetIds = [] } = req.body ?? {};

    const fullChangeText = `${plan}\n${diff}\n${filePaths.join("\n")}`.toLowerCase();
    const directlyAffectedRules: KnowledgeItem[] = [];
    const relatedFiles: string[] = [...filePaths];
    const impactedDocuments: KnowledgeItem[] = [];

    for (const item of items) {
      const matchId = targetIds.includes(item.id) || fullChangeText.includes(item.id.toLowerCase());
      const matchKeyword = item.tags.some((t) => fullChangeText.includes(t.toLowerCase())) ||
        (item.title.length > 5 && fullChangeText.includes(item.title.toLowerCase().slice(0, 15)));

      if (matchId || matchKeyword) {
        if (item.type === "business_rule") directlyAffectedRules.push(item);
        else impactedDocuments.push(item);
      }
    }

    // Calcular nível de risco baseado nas regras tocadas e políticas
    let riskLevel: "low" | "medium" | "high" | "critical" = "low";
    const criticalCount = directlyAffectedRules.filter((r) => r.accessPolicyId === "restricted-security" || r.tags.includes("critical")).length;
    if (criticalCount > 0 || directlyAffectedRules.length >= 4) {
      riskLevel = "critical";
    } else if (directlyAffectedRules.length >= 2 || impactedDocuments.some((d) => d.accessPolicyId === "restricted-security")) {
      riskLevel = "high";
    } else if (directlyAffectedRules.length === 1 || filePaths.length > 3) {
      riskLevel = "medium";
    }

    return {
      projectId: req.params.projectId,
      riskLevel,
      summary: `Impacto ${riskLevel.toUpperCase()}: ${directlyAffectedRules.length} regra(s) e ${impactedDocuments.length} documento(s) afetados.`,
      directlyAffectedRules: directlyAffectedRules.map((r) => ({
        id: r.id,
        title: r.title,
        policy: r.accessPolicyId,
        status: r.status,
        summary: r.summary ?? r.content.slice(0, 140)
      })),
      impactedDocuments: impactedDocuments.map((d) => ({
        id: d.id,
        title: d.title,
        type: d.type,
        policy: d.accessPolicyId
      })),
      relatedFiles: Array.from(new Set(relatedFiles)),
      recommendedActions: [
        directlyAffectedRules.length > 0 ? "Executar suíte de testes de regressão para as regras identificadas" : "Nenhuma regra crítica afetada",
        riskLevel === "critical" || riskLevel === "high" ? "Requer aprovação de Tech Lead / AppSec antes do merge" : "Fluxo padrão de revisão por pares",
        "Validar atualização de schemas e contratos de API"
      ]
    };
  });

  // 3. Detecção de Contradições entre Regras e Documentos
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/intelligence/contradictions", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);
    const rules = items.filter((i) => i.type === "business_rule" || i.type === "architecture_decision");

    const contradictions: Array<{
      id: string;
      itemA: { id: string; title: string; type: string };
      itemB: { id: string; title: string; type: string };
      reason: string;
      severity: "high" | "medium";
      resolutionSuggestion: string;
    }> = [];

    // Busca heurística por pares de regras com escopos ou diretrizes opostas
    for (let i = 0; i < rules.length; i++) {
      for (let j = i + 1; j < rules.length; j++) {
        const a = rules[i]!;
        const b = rules[j]!;
        const aText = `${a.title} ${a.content}`.toLowerCase();
        const bText = `${b.title} ${b.content}`.toLowerCase();

        const bothAuth = aText.includes("autentica") && bText.includes("autentica");
        const conflictOidc = (aText.includes("keycloak") && !bText.includes("keycloak")) ||
          (aText.includes("jwt") && aText.includes("obrigatório") && bText.includes("anônimo"));
        const conflictPolicy = a.accessPolicyId === "restricted-security" && b.accessPolicyId === "public-org" &&
          (aText.includes("auditoria") && bText.includes("auditoria"));

        if (conflictOidc || conflictPolicy) {
          contradictions.push({
            id: `CT-${createHash("sha256").update(`${a.id}:${b.id}`).digest("hex").slice(0, 8)}`,
            itemA: { id: a.id, title: a.title, type: a.type },
            itemB: { id: b.id, title: b.title, type: b.type },
            reason: conflictPolicy
              ? `Conflito de política de acesso entre '${a.id}' (${a.accessPolicyId}) e '${b.id}' (${b.accessPolicyId}).`
              : `Possível divergência em diretrizes de segurança/autenticação entre '${a.id}' e '${b.id}'.`,
            severity: conflictPolicy ? "high" : "medium",
            resolutionSuggestion: `Unificar as definições em um único ADR ou atualizar '${b.id}' com a versão mais recente.`
          });
        }
      }
    }

    return {
      projectId: req.params.projectId,
      totalContradictions: contradictions.length,
      contradictions
    };
  });

  // 4. Histórico de Decisões e Evolução de ADRs
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/intelligence/decision-timeline", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);
    const decisions = items
      .filter((i) => i.type === "architecture_decision" || i.type === "pending_decision" || i.id.startsWith("ADR-"))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    const timeline = decisions.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      status: d.status,
      version: d.version,
      date: d.updatedAt,
      author: d.ownerId ?? "system",
      rationale: d.summary ?? d.content.slice(0, 160),
      supersededBy: d.relatedIds?.find((r) => r.startsWith("ADR-")),
      tags: d.tags
    }));

    return {
      projectId: req.params.projectId,
      totalDecisions: timeline.length,
      timeline
    };
  });

  // 5. Sugestões de Documentação Desatualizada (Doc Drift)
  app.post<{
    Params: { projectId: string };
    Body: { changedFiles?: string[]; recentCommits?: string[] };
  }>("/v1/projects/:projectId/intelligence/doc-drift-suggestions", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);
    const { changedFiles = [], recentCommits = [] } = req.body ?? {};

    const docs = items.filter((i) => i.type === "document" || i.type === "architecture_decision" || i.type === "runbook");
    const suggestions: Array<{
      documentId: string;
      title: string;
      reason: string;
      urgency: "high" | "medium" | "low";
      suggestedSection: string;
    }> = [];

    for (const doc of docs) {
      const matchFile = changedFiles.some((f) => doc.content.toLowerCase().includes(f.toLowerCase().split("/").pop() ?? ""));
      if (matchFile) {
        suggestions.push({
          documentId: doc.id,
          title: doc.title,
          reason: `Arquivos referenciados foram modificados recentemente no código.`,
          urgency: doc.type === "runbook" ? "high" : "medium",
          suggestedSection: "Atualizar referências de endpoints, componentes ou procedimentos operacionais."
        });
      }
    }

    if (suggestions.length === 0 && docs.length > 0) {
      const oldestDoc = docs.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0]!;
      suggestions.push({
        documentId: oldestDoc.id,
        title: oldestDoc.title,
        reason: "Documento mais antigo do repositório sem revisão recente.",
        urgency: "low",
        suggestedSection: "Revisão geral de aderência à arquitetura atual."
      });
    }

    return {
      projectId: req.params.projectId,
      totalSuggestions: suggestions.length,
      suggestions
    };
  });

  // 6. Modo de Onboarding de Projeto
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/intelligence/onboarding-guide", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);

    const visionItem = items.find((i) => i.id.includes("VIS") || i.title.toLowerCase().includes("visão")) ?? items[0];
    const rules = items.filter((i) => i.type === "business_rule").slice(0, 5);
    const adrs = items.filter((i) => i.type === "architecture_decision" || i.id.startsWith("ADR-")).slice(0, 5);
    const services = items.filter((i) => i.type === "service" || i.id.startsWith("SVC-") || i.type === "api_contract");

    return {
      projectId: req.params.projectId,
      title: `Guia de Boas-Vindas & Onboarding — Projeto ${req.params.projectId.toUpperCase()}`,
      generatedAt: new Date().toISOString(),
      sections: [
        {
          title: "1. Visão Geral & Propósito",
          content: visionItem?.content ?? "Cérebro corporativo inteligente com suporte a CASL, RLS multi-tenant, e motor de inferência vetorial."
        },
        {
          title: "2. Arquitetura e Decisões Fundamentais",
          items: adrs.map((a) => ({ id: a.id, title: a.title, status: a.status }))
        },
        {
          title: "3. Principais Regras de Negócio",
          items: rules.map((r) => ({ id: r.id, title: r.title, policy: r.accessPolicyId }))
        },
        {
          title: "4. Serviços e Contratos Conectados",
          items: services.map((s) => ({ id: s.id, title: s.title, type: s.type }))
        },
        {
          title: "5. Primeiros Passos & Convenções",
          steps: [
            "Instale as dependências: bun install ou npm install",
            "Inicie os contêineres essenciais com docker-compose (PostgreSQL pgvector, Valkey, MinIO)",
            "Execute 'brain doctor' para verificar a integridade da infraestrutura local",
            "Consulte as regras antes de submeter propostas ou abrir PRs"
          ]
        }
      ]
    };
  });

  // 7. Perguntas sobre o Projeto no Chat (Knowledge-Grounded Q&A com Citações)
  app.post<{
    Params: { projectId: string };
    Body: { question: string; history?: Array<{ role: string; content: string }> };
  }>("/v1/projects/:projectId/intelligence/chat-qa", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { question = "" } = req.body ?? {};
    if (!question.trim()) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Pergunta obrigatória.", 400);
    }

    const searchCtx: AuthContext = {
      ...ctx,
      allowedProjects: [...new Set([...ctx.allowedProjects, req.params.projectId])]
    };

    const hits = await queryAwareRetrieval.search(searchCtx, {
      projectId: req.params.projectId,
      query: question,
      limit: 6
    }).catch(() => []);

    const citations = hits.map((h) => ({
      id: h.item.id,
      title: h.item.title,
      type: h.item.type,
      accessPolicyId: h.item.accessPolicyId,
      score: Number(h.score.toFixed(3)),
      excerpt: h.item.summary ?? h.item.content.slice(0, 220)
    }));

    const contextSummary = citations
      .map((c) => `[${c.id} - ${c.title} (${c.type})]: ${c.excerpt}`)
      .join("\n\n");

    const answer = citations.length > 0
      ? `Com base no conhecimento indexado no projeto '${req.params.projectId}', localizamos ${citations.length} artefato(s) relevantes:\n\n${citations.map((c, idx) => `${idx + 1}. **${c.title}** (\`${c.id}\`): ${c.excerpt}`).join("\n\n")}\n\nConclusão: Os comportamentos e convenções aplicáveis estão descritos diretamente nas regras e decisões acima.`
      : `Não foram encontrados documentos ou regras com correspondência direta para '${question}'. Recomenda-se registrar um novo documento ou consultar a equipe de arquitetura.`;

    return {
      projectId: req.params.projectId,
      question,
      answer,
      citations,
      groundedConfidence: citations.length > 0 ? 0.94 : 0.2
    };
  });

  // 8. Comparação entre Projetos (Multi-Project Comparison & Pattern Reuse)
  app.post<{
    Params: { projectId: string };
    Body: { targetProjectId?: string };
  }>("/v1/projects/:projectId/intelligence/cross-project-compare", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const targetProjectId = req.body?.targetProjectId ?? "brain";

    const [sourceItems, targetItems] = await Promise.all([
      getProjectKnowledge(ctx, req.params.projectId, 100),
      getProjectKnowledge(ctx, targetProjectId, 100)
    ]);

    const sourceRuleIds = new Set(sourceItems.filter((i) => i.type === "business_rule").map((i) => i.id));
    const targetRuleIds = new Set(targetItems.filter((i) => i.type === "business_rule").map((i) => i.id));

    const commonPatterns: string[] = [];
    const reusableCandidates: KnowledgeItem[] = [];

    for (const item of targetItems) {
      if (item.type === "business_rule" || item.type === "skill" || item.type === "spec") {
        if (!sourceRuleIds.has(item.id)) {
          reusableCandidates.push(item);
        } else {
          commonPatterns.push(item.title);
        }
      }
    }

    return {
      sourceProjectId: req.params.projectId,
      targetProjectId,
      comparison: {
        sourceTotalItems: sourceItems.length,
        targetTotalItems: targetItems.length,
        commonPatternsCount: commonPatterns.length,
        reusableCandidatesCount: reusableCandidates.length
      },
      commonPatterns,
      reusableCandidates: reusableCandidates.slice(0, 10).map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        policy: c.accessPolicyId
      }))
    };
  });

  // 9. Modelos de Revisão (PR Review Checklist Generator)
  app.post<{
    Params: { projectId: string };
    Body: { title?: string; diff?: string; filePaths?: string[]; branch?: string };
  }>("/v1/projects/:projectId/intelligence/pr-review-checklist", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 200);
    const { title = "Pull Request", diff = "", filePaths = [], branch = "main" } = req.body ?? {};

    const touchedRules = items.filter((i) =>
      i.type === "business_rule" &&
      filePaths.some((f) => i.content.toLowerCase().includes(f.toLowerCase().split("/").pop() ?? ""))
    );

    const checklist = [
      { category: "Arquitetura", item: "Validar se a alteração cumpre os ADRs vigentes sem quebrar compatibilidade retroativa." },
      { category: "Segurança & RLS", item: "Verificar se novos endpoints Fastify aplicam 'authUser' e isolamento RLS por tenant/projeto." },
      { category: "Regras de Negócio", item: touchedRules.length > 0 ? `Verificar conformidade com as regras: ${touchedRules.map((r) => r.id).join(", ")}.` : "Garantir que nenhuma regra de negócio existente foi violada." },
      { category: "Testes", item: "Confirmar que foram adicionados testes automatizados cobrindo os caminhos positivos e de erro." },
      { category: "Observabilidade", item: "Verificar se spans de telemetria e logs de auditoria (recordAudit) são gerados corretamente." }
    ];

    return {
      projectId: req.params.projectId,
      prTitle: title,
      branch,
      checklist,
      relevantRules: touchedRules.map((r) => ({ id: r.id, title: r.title }))
    };
  });

  // 10. Painel de Dívida Técnica (Technical Debt & Health Radar)
  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/intelligence/tech-debt-radar", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);

    const rules = items.filter((i) => i.type === "business_rule");
    const tests = items.filter((i) => i.type === "test");
    const risks = items.filter((i) => i.type === "risk" || i.type === "risk_control");
    const decisions = items.filter((i) => i.type === "architecture_decision" || i.id.startsWith("ADR-"));

    const untestedRules = rules
      .filter((r) => !tests.some((t) => t.id.includes(r.id) || t.content.includes(r.id)))
      .map((r) => ({ id: r.id, title: r.title }));

    const now = Date.now();
    const staleDecisions = decisions
      .filter((d) => (now - Date.parse(d.updatedAt)) / 86_400_000 > 60)
      .map((d) => ({ id: d.id, title: d.title, daysSinceUpdate: Math.round((now - Date.parse(d.updatedAt)) / 86_400_000) }));

    const fragileDependencies = items
      .filter((i) => !i.relatedIds || i.relatedIds.length === 0)
      .slice(0, 8)
      .map((i) => ({ id: i.id, title: i.title, type: i.type }));

    // Score de saúde da dívida técnica de 0 a 100
    const rulePenalty = Math.min(40, untestedRules.length * 4);
    const stalePenalty = Math.min(30, staleDecisions.length * 3);
    const riskPenalty = Math.min(30, risks.length * 5);
    const debtHealthScore = Math.max(0, 100 - rulePenalty - stalePenalty - riskPenalty);

    return {
      projectId: req.params.projectId,
      calculatedAt: new Date().toISOString(),
      debtHealthScore,
      summary: {
        totalItems: items.length,
        untestedRulesCount: untestedRules.length,
        staleDecisionsCount: staleDecisions.length,
        activeRisksCount: risks.length,
        fragileDependenciesCount: fragileDependencies.length
      },
      untestedRules,
      staleDecisions,
      activeRisks: risks.map((r) => ({ id: r.id, title: r.title, status: r.status })),
      fragileDependencies
    };
  });
}
