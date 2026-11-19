import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { authenticateRequest, usersStore, type AuthContext } from "@brain/auth";
import { BrainError, type KnowledgeItem, type KnowledgeType, type KnowledgeProvenance } from "@brain/core";
import type { PgAuthRepository, PgOperationalRepository, PgSystemSettingsRepository } from "@brain/database";
import type { PostgresKnowledgeRepository } from "@brain/knowledge";
import type { AsyncRetrievalEngine } from "@brain/retrieval";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import type { CrossServiceContractRegistry } from "@brain/cross-service";

export interface KnowledgeDailyDeps {
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

export function registerKnowledgeDailyRoutes(
  app: FastifyInstance,
  deps: KnowledgeDailyDeps
) {
  const {
    configuredApiKey,
    allowedProjects,
    allowedPolicies,
    recordAudit,
    opRepo,
    authRepo,
    queryAwareRetrieval,
    pgKnowledge
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

  const getProjectKnowledge = async (ctx: AuthContext, projectId: string, limit = 250): Promise<KnowledgeItem[]> => {
    const searchCtx: AuthContext = {
      ...ctx,
      allowedProjects: [...new Set([...ctx.allowedProjects, projectId])]
    };
    const hits = await queryAwareRetrieval.search(searchCtx, { projectId, query: "", limit }).catch(() => []);
    return hits.map((h) => h.item);
  };

  // 1. “O que mudou desde ontem?” (Daily Changes / What Changed)
  app.get<{
    Params: { projectId: string };
    Querystring: { period?: string; since?: string };
  }>("/v1/projects/:projectId/daily/what-changed", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { period = "24h", since } = req.query;

    const msMap: Record<string, number> = { "24h": 86400000, "48h": 172800000, "7d": 604800000 };
    const cutoffTime = since ? new Date(since).getTime() : Date.now() - (msMap[period] ?? 86400000);
    const cutoffIso = new Date(cutoffTime).toISOString();

    const items = await getProjectKnowledge(ctx, req.params.projectId, 250);
    const changedItems = items.filter((i) => {
      const up = new Date(i.updatedAt || i.createdAt).getTime();
      return up >= cutoffTime;
    });

    const rulesChanged = changedItems.filter((i) => i.type === "business_rule");
    const decisionsChanged = changedItems.filter((i) => i.type === "architecture_decision" || i.type === "pending_decision");
    const docsChanged = changedItems.filter((i) => i.type === "document" || i.type === "runbook" || i.type === "spec");

    const recentAudit = changedItems.slice(0, 10).map((item) => ({
      action: item.createdAt === item.updatedAt ? "create" : "update",
      actor: item.ownerId || "system",
      target: `${item.type}:${item.id}`,
      time: item.updatedAt || item.createdAt
    }));

    return {
      projectId: req.params.projectId,
      period,
      cutoffTime: cutoffIso,
      summary: `Resumo das últimas ${period}: ${changedItems.length} item(ns) de conhecimento atualizados e ${recentAudit.length} evento(s) recentes.`,
      stats: {
        totalChanged: changedItems.length,
        newOrUpdatedRules: rulesChanged.length,
        decisionsChanged: decisionsChanged.length,
        docsChanged: docsChanged.length,
        auditEvents: recentAudit.length
      },
      rulesChanged: rulesChanged.map((r) => ({ id: r.id, title: r.title, status: r.status, updatedAt: r.updatedAt })),
      decisionsChanged: decisionsChanged.map((d) => ({ id: d.id, title: d.title, status: d.status, updatedAt: d.updatedAt })),
      docsChanged: docsChanged.map((d) => ({ id: d.id, title: d.title, type: d.type, updatedAt: d.updatedAt })),
      recentAuditActions: recentAudit
    };
  });

  // 2. Busca por Intenção (Intent Search)
  app.post<{
    Params: { projectId: string };
    Body: { intentQuery: string };
  }>("/v1/projects/:projectId/daily/intent-search", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { intentQuery = "" } = req.body ?? {};
    if (!intentQuery.trim()) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Consulta de intenção obrigatória.", 400);
    }

    const q = intentQuery.toLowerCase();
    let detectedIntent = "general";
    let intentExplanation = "Busca semântica ampla no grafo de conhecimento.";
    let queryExpansion = intentQuery;
    let preferredTypes: KnowledgeType[] = [];

    if (/publicar|deploy|ci\/cd|esteira|release|subir|produção/i.test(q)) {
      detectedIntent = "deployment";
      intentExplanation = "Intenção identificada: Procedimentos de publicação, deploy e esteira.";
      queryExpansion = `${intentQuery} deploy runbook esteira release pipeline container`;
      preferredTypes = ["runbook", "document", "slo_target"];
    } else if (/quem valida|permiss[ãa]o|autoriza|acesso|role|casl|token/i.test(q)) {
      detectedIntent = "authorization";
      intentExplanation = "Intenção identificada: Validação de segurança, RBAC, CASL e permissões de acesso.";
      queryExpansion = `${intentQuery} auth casl role permission access policy rls`;
      preferredTypes = ["business_rule", "role_responsibility", "limit_constraint"];
    } else if (/onde fica|arquitetura|serviço|banco|estrutura|m[óo]dulo/i.test(q)) {
      detectedIntent = "architecture";
      intentExplanation = "Intenção identificada: Localização arquitetural de componentes e serviços.";
      queryExpansion = `${intentQuery} architecture service module database topology`;
      preferredTypes = ["service", "architecture_decision", "data_model", "api_contract"];
    } else if (/erro|incidente|falha|bug|queda|troubleshoot/i.test(q)) {
      detectedIntent = "incident_resolution";
      intentExplanation = "Intenção identificada: Resolução de incidentes e diagnóstico de erros.";
      queryExpansion = `${intentQuery} runbook incident postmortem fix troubleshooting`;
      preferredTypes = ["runbook", "incident_postmortem", "known_exception"];
    }

    const searchCtx: AuthContext = {
      ...ctx,
      allowedProjects: [...new Set([...ctx.allowedProjects, req.params.projectId])]
    };

    const hits = await queryAwareRetrieval.search(searchCtx, {
      projectId: req.params.projectId,
      query: queryExpansion,
      limit: 8
    }).catch(() => []);

    const rankedItems = hits.map((h) => {
      const isPreferred = preferredTypes.includes(h.item.type);
      return {
        id: h.item.id,
        title: h.item.title,
        type: h.item.type,
        summary: h.item.summary || h.item.content.slice(0, 160),
        relevanceScore: isPreferred ? h.score * 1.25 : h.score,
        matchedIntent: detectedIntent
      };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);

    return {
      projectId: req.params.projectId,
      originalQuery: intentQuery,
      detectedIntent,
      intentExplanation,
      totalResults: rankedItems.length,
      items: rankedItems,
      suggestedNextSteps: [
        `Explorar detalhes de ${rankedItems[0]?.title || "itens relevantes"}`,
        "Consultar regras de negócio relacionadas a esta intenção",
        "Visualizar impacto no grafo arquitetural"
      ]
    };
  });

  // 3. Explicação de Código no Contexto do Projeto (Code Context Explainer)
  app.post<{
    Params: { projectId: string };
    Body: { codeSnippet: string; filePath?: string };
  }>("/v1/projects/:projectId/daily/explain-code", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { codeSnippet = "", filePath } = req.body ?? {};
    if (!codeSnippet.trim()) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Trecho de código obrigatório.", 400);
    }

    const items = await getProjectKnowledge(ctx, req.params.projectId, 200);
    const lowerCode = codeSnippet.toLowerCase();

    // Identify related rules, ADRs and contracts
    const relatedRules = items.filter((i) =>
      i.type === "business_rule" &&
      (lowerCode.includes(i.title.toLowerCase().slice(0, 15)) || i.tags.some((t) => lowerCode.includes(t.toLowerCase())))
    );

    const relatedAdrs = items.filter((i) =>
      i.type === "architecture_decision" &&
      (lowerCode.includes(i.title.toLowerCase().slice(0, 15)) || i.tags.some((t) => lowerCode.includes(t.toLowerCase())))
    );

    const potentialConstraints = items.filter((i) =>
      i.type === "limit_constraint" || i.type === "known_exception"
    );

    return {
      projectId: req.params.projectId,
      filePath: filePath || "desconhecido",
      summary: `Análise contextual de ${codeSnippet.split("\n").length} linhas de código contra o grafo do projeto.`,
      architectureFit: relatedAdrs.length > 0
        ? `Alinhado com ${relatedAdrs.map((a) => a.id).join(", ")}.`
        : "Nenhum ADR impeditivo detectado para este padrão de implementação.",
      governingRules: relatedRules.map((r) => ({ id: r.id, title: r.title, status: r.status })),
      potentialConstraints: potentialConstraints.slice(0, 3).map((c) => ({ id: c.id, title: c.title, type: c.type })),
      codeQualityCheck: {
        hasAuthCheck: /auth|token|jwt|casl|permission/i.test(lowerCode),
        hasErrorHandling: /try\s*{|catch\s*\(|throw new/i.test(lowerCode),
        hasAuditLogging: /audit|logger|log\(/i.test(lowerCode)
      },
      contextualAdvice: [
        "Certifique-se de que todas as mutações no banco utilizem as permissões CASL do projeto.",
        "Mantenha arquivos abaixo de 700 linhas conforme convenções de engenharia.",
        "Registre testes unitários associados às regras de negócio governadas."
      ]
    };
  });

  // 4. Memória por Equipe ou Agente (Team & Agent Memory)
  app.get<{
    Params: { projectId: string };
    Querystring: { teamId?: string; agentId?: string; category?: string };
  }>("/v1/projects/:projectId/daily/team-memory", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { teamId, agentId, category } = req.query;

    const items = await getProjectKnowledge(ctx, req.params.projectId, 200);
    const memories = items.filter((i) => i.type === "memory").filter((m) => {
      const tags = m.tags || [];
      if (teamId && !tags.includes(`team:${teamId}`)) return false;
      if (agentId && !tags.includes(`agent:${agentId}`)) return false;
      if (category && !tags.includes(`cat:${category}`)) return false;
      return true;
    });

    return {
      projectId: req.params.projectId,
      totalMemories: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        title: m.title,
        content: m.content,
        tags: m.tags,
        validUntil: m.validUntil,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
      }))
    };
  });

  app.post<{
    Params: { projectId: string };
    Body: { title: string; content: string; teamId?: string; agentId?: string; category?: string; validDays?: number };
  }>("/v1/projects/:projectId/daily/team-memory", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { title, content, teamId = "core-team", agentId, category = "preferences", validDays = 30 } = req.body ?? {};

    if (!title?.trim() || !content?.trim()) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Título e conteúdo da memória são obrigatórios.", 400);
    }

    const id = `MEM-${Date.now().toString(36).toUpperCase()}`;
    const validUntil = new Date(Date.now() + validDays * 86400000).toISOString();
    const tags = [`team:${teamId}`, `cat:${category}`];
    if (agentId) tags.push(`agent:${agentId}`);

    const memoryItem: KnowledgeItem = {
      id,
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      domainId: 1,
      type: "memory",
      title: title.trim(),
      content: content.trim(),
      summary: content.slice(0, 160),
      status: "approved",
      sourceId: id,
      sourceOrigin: "internal",
      sourceKind: "agent",
      sourceVersion: "1.0.0",
      sourceUri: `brain://memory/${id}`,
      version: 1,
      contentHash: createHash("sha256").update(content).digest("hex"),
      ownerId: ctx.actorId,
      confidence: 1.0,
      trustLevel: "verified",
      isInferred: false,
      validUntil,
      tags,
      relatedIds: [],
      accessPolicyId: "internal-project",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (pgKnowledge) {
      await pgKnowledge.upsertItem(ctx, memoryItem).catch(() => null);
    }

    await recordAudit(ctx, {
      action: "create",
      targetId: id,
      targetType: "knowledge_item",
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      tenantId: ctx.tenantId,
      metadata: { title, teamId, agentId, validUntil }
    }).catch(() => null);

    return { saved: true, memory: memoryItem };
  });

  // 5. Modo de Exploração para Projetos Desconhecidos (Interactive Tour)
  app.get<{
    Params: { projectId: string };
    Querystring: { step?: string };
  }>("/v1/projects/:projectId/daily/interactive-tour", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const items = await getProjectKnowledge(ctx, req.params.projectId, 200);

    const steps = [
      {
        stepNumber: 1,
        title: "Passo 1: Propósito & Visão Geral",
        description: "Compreender o objetivo do sistema, o problema resolvido e as principais partes interessadas.",
        keyItems: items.filter((i) => i.type === "document" || i.type === "spec").slice(0, 3).map((i) => i.title),
        verificationQuestion: "Qual é a responsabilidade central deste projeto dentro da organização?"
      },
      {
        stepNumber: 2,
        title: "Passo 2: Topologia & Serviços",
        description: "Mapear a arquitetura técnica, serviços distribuídos, banco de dados e mensageria.",
        keyItems: items.filter((i) => i.type === "service" || i.type === "api_contract").slice(0, 3).map((i) => i.title),
        verificationQuestion: "Quais dependências de infraestrutura são obrigatórias para executar o projeto?"
      },
      {
        stepNumber: 3,
        title: "Passo 3: Regras Inegociáveis & Políticas",
        description: "Conhecer as regras de negócio primárias e restrições de segurança que não podem ser violadas.",
        keyItems: items.filter((i) => i.type === "business_rule" || i.type === "limit_constraint").slice(0, 4).map((i) => i.title),
        verificationQuestion: "Quais são as três principais regras de negócio aplicáveis neste domínio?"
      },
      {
        stepNumber: 4,
        title: "Passo 4: Contribuição, Testes & CI/CD",
        description: "Executar o ambiente de desenvolvimento local, rodar suítes de testes e abrir o primeiro PR.",
        keyItems: items.filter((i) => i.type === "runbook" || i.type === "test").slice(0, 3).map((i) => i.title),
        verificationQuestion: "Qual comando executa a suíte de testes de integridade local?"
      }
    ];

    return {
      projectId: req.params.projectId,
      totalSteps: steps.length,
      currentStep: Number(req.query.step || "1"),
      steps
    };
  });

  // 6. Busca de Exemplos Internos (Internal Examples Search)
  app.post<{
    Params: { projectId: string };
    Body: { problemOrPattern: string; limit?: number };
  }>("/v1/projects/:projectId/daily/internal-examples", async (req) => {
    const ctx = await authUser(req.headers.authorization);
    const { problemOrPattern = "", limit = 5 } = req.body ?? {};
    if (!problemOrPattern.trim()) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Padrão ou problema obrigatório.", 400);
    }

    const searchCtx: AuthContext = {
      ...ctx,
      allowedProjects: [...new Set([...ctx.allowedProjects, req.params.projectId])]
    };

    const hits = await queryAwareRetrieval.search(searchCtx, {
      projectId: req.params.projectId,
      query: `${problemOrPattern} implementation pattern example test code`,
      limit: Math.min(limit, 10)
    }).catch(() => []);

    const examples = hits.map((h) => ({
      id: h.item.id,
      title: h.item.title,
      type: h.item.type,
      relevance: h.score,
      author: h.item.ownerId || "engenharia",
      codeOrPatternSample: h.item.content.slice(0, 300),
      uri: h.item.sourceUri
    }));

    return {
      projectId: req.params.projectId,
      query: problemOrPattern,
      totalFound: examples.length,
      examples
    };
  });
}
