import type { KnowledgeItem } from "@noema/core";
import type { GraphEdge } from "@noema/graph";

export interface TechRadarEntry {
  technology: string;
  ring: "adopt" | "trial" | "assess" | "hold";
  projectsCount: number;
}

export interface QaCoverageRow {
  ruleId: string;
  title: string;
  covered: boolean;
  tests: string[];
}

export interface QaTestExecutionResult {
  testItemId: string;
  status: string;
  commitSha: string;
  repository?: string | null;
}

export interface SbomPackageRisk {
  name: string;
  version: string;
  cve?: string;
  severity?: "low" | "medium" | "high" | "critical";
}

export interface PlannedTask {
  step: number;
  title: string;
  targetFiles: string[];
  relatedRuleIds: string[];
}

export interface ProjectSimulationResult {
  riskScore: number;
  impactedRuleIds: string[];
  recommendedReviewers: string[];
  approvedToProceed: boolean;
}

export interface ProjectHealthReport {
  healthScore: number;
  untestedRuleIds: string[];
  staleItemIds: string[];
  gitVsConnectorConflicts: Array<{ id: string; gitHash: string; connectorHash: string }>;
}

export interface BlastRadiusNode {
  itemId: string;
  hops: number;
  relationType: string;
  title?: string;
  type?: string;
}

export interface TopologyBlastRadius {
  rootNodeId: string;
  impactedNodes: BlastRadiusNode[];
  totalImpacted: number;
  blastRadiusScore: number;
  severity: "low" | "medium" | "high" | "critical";
}

export interface IncidentRecord {
  id: string;
  title: string;
  service?: string;
  endpoint?: string;
  errorMessage?: string;
  tags?: readonly string[];
  severity?: "low" | "medium" | "high" | "critical";
}

export interface IncidentMatchedItem {
  itemId: string;
  type: string;
  title: string;
  sourceUri: string;
  matchReason: string;
}

export interface IncidentCodeMapping {
  incidentId: string;
  title: string;
  matchedItems: IncidentMatchedItem[];
  candidateFiles: string[];
}

export interface PreDeployReadinessResult {
  ready: boolean;
  score: number;
  blockers: string[];
  warnings: string[];
}

export interface EndpointDescriptor {
  method: string;
  path: string;
  fields?: readonly string[];
  description?: string;
  authRequired?: boolean;
}

export interface PiiEndpointClassification {
  method: string;
  path: string;
  sensitivity: "critical" | "high" | "medium" | "none";
  detectedCategories: string[];
  recommendedControls: string[];
  missingAuthRisk: boolean;
}

export interface ProjectProfile {
  name: string;
  domain: string;
  scale: "startup" | "growth" | "enterprise";
  compliance?: readonly string[];
  runtime?: "node" | "python" | "go" | "jvm";
  architectureStyle?: "modular-monolith" | "microservices" | "serverless";
}

export interface ProjectBlueprint {
  projectName: string;
  recommendedStack: {
    runtime: string;
    framework: string;
    database: string;
    messaging: string;
    observability: string;
  };
  recommendedAdrs: Array<{ id: string; title: string; rationale: string }>;
  recommendedPolicies: string[];
}

export function buildTechRadar(items: readonly KnowledgeItem[]): TechRadarEntry[] {
  const counts = new Map<string, Set<string>>();
  for (const item of items) {
    for (const tag of item.tags) {
      const set = counts.get(tag) ?? new Set<string>();
      set.add(item.projectId);
      counts.set(tag, set);
    }
  }
  return [...counts.entries()].map(([technology, projects]) => ({
    technology,
    ring: projects.size >= 2 ? "adopt" : "trial",
    projectsCount: projects.size
  }));
}

export function buildBusinessRuleTestCoverageMatrix(
  items: readonly KnowledgeItem[],
  edges: readonly GraphEdge[],
  evidence?: {
    testResults: readonly QaTestExecutionResult[];
    linkedTestsByRule?: ReadonlyMap<string, readonly string[]>;
    testItemsById?: ReadonlyMap<string, Pick<KnowledgeItem, "type" | "sourceUri" | "sourceVersion" | "metadata">>;
    requireMainHead?: boolean;
    requireRepositoryAssociation?: boolean;
    mainHeadByRepository?: ReadonlyMap<string, string>;
  }
): { coveragePercent: number; rows: QaCoverageRow[] } {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const latestResults = new Map<string, QaTestExecutionResult>();
  for (const result of evidence?.testResults ?? []) {
    if (!latestResults.has(result.testItemId)) latestResults.set(result.testItemId, result);
  }
  const rules = items.filter((i) => i.type === "business_rule" && i.status !== "deprecated");
  const rows: QaCoverageRow[] = rules.map((rule) => {
    const linkedTests = [...(evidence?.linkedTestsByRule?.get(rule.id) ?? edges
      .filter((e) => e.relationType === "VERIFIED_BY" && (e.toItemId === rule.id || e.fromItemId === rule.id))
      .map((e) => (e.toItemId === rule.id ? e.fromItemId : e.toItemId)))];
    const tests = evidence
      ? [...new Set(linkedTests)].filter((testId) => {
          const test = evidence.testItemsById?.get(testId) ?? itemById.get(testId);
          const result = latestResults.get(testId);
          if ((!test || (test.type !== "test" && !/\.(?:spec|test)\.[cm]?[jt]sx?$|_test\.py$/i.test(test.sourceUri))) || result?.status !== "passed") return false;
          if (evidence.requireMainHead) {
            const mainHead = result.repository ? evidence.mainHeadByRepository?.get(result.repository.toLowerCase()) : undefined;
            if (!mainHead || mainHead.toLowerCase() !== result.commitSha.toLowerCase()) return false;
            const sourceRepository = typeof test.metadata?.sourceRepository === "string" ? test.metadata.sourceRepository.toLowerCase() : undefined;
            if ((evidence.requireRepositoryAssociation && !sourceRepository) || (sourceRepository && sourceRepository !== result.repository?.toLowerCase())) return false;
            return true;
          }
          // Git-backed test items represent the indexed repository snapshot. Ignore CI evidence
          // from any other snapshot so an older green run cannot cover newer test code.
          return !/^[a-f0-9]{40,64}$/i.test(test.sourceVersion) || test.sourceVersion.toLowerCase() === result.commitSha.toLowerCase();
        })
      : linkedTests;
    return { ruleId: rule.id, title: rule.title, covered: tests.length > 0, tests };
  });
  const coveredCount = rows.filter((r) => r.covered).length;
  const coveragePercent = rows.length === 0 ? 100 : Math.round((coveredCount / rows.length) * 100);
  return { coveragePercent, rows };
}

export function evaluateSbomCveGuard(packages: readonly SbomPackageRisk[]): {
  passed: boolean;
  criticalOrHigh: SbomPackageRisk[];
} {
  const criticalOrHigh = packages.filter((p) => p.severity === "critical" || p.severity === "high");
  return { passed: criticalOrHigh.length === 0, criticalOrHigh };
}

export function planAutonomousTasks(epicDescription: string, rules: readonly KnowledgeItem[]): PlannedTask[] {
  const ruleIds = rules.map((r) => r.id);
  return [
    {
      step: 1,
      title: `Validar impacto e contratos para: ${epicDescription}`,
      targetFiles: [".brain/01-business/", ".brain/03-architecture/"],
      relatedRuleIds: ruleIds
    },
    {
      step: 2,
      title: `Implementar alterações com âncoras @brain-rule (${ruleIds.join(", ") || "N/A"})`,
      targetFiles: ["src/"],
      relatedRuleIds: ruleIds
    },
    {
      step: 3,
      title: "Adicionar testes @brain-rule VERIFIED_BY e executar Guardians",
      targetFiles: ["test/"],
      relatedRuleIds: ruleIds
    }
  ];
}

export function suggestLivingDocUpdates(changedFiles: readonly string[], items: readonly KnowledgeItem[]): string[] {
  const suggestions: string[] = [];
  for (const file of changedFiles) {
    for (const item of items) {
      if (item.sourceUri && file.includes(item.projectId) && item.type === "architecture_decision") {
        suggestions.push(`Revisar ADR '${item.id}' (${item.sourceUri}) após alteração em '${file}'.`);
      }
    }
  }
  return [...new Set(suggestions)];
}

export function simulateProjectChange(
  impactedRuleIds: readonly string[],
  hasFailingTests: boolean
): ProjectSimulationResult {
  const riskScore = Math.min(100, impactedRuleIds.length * 20 + (hasFailingTests ? 40 : 0));
  return {
    riskScore,
    impactedRuleIds: [...impactedRuleIds],
    recommendedReviewers: riskScore >= 60 ? ["tech-lead", "appsec"] : ["developer"],
    approvedToProceed: !hasFailingTests && riskScore < 80
  };
}

/**
 * Knowledge Health Monitor: visão agregada de saúde do projeto.
 */
export function computeProjectHealthReport(
  items: readonly KnowledgeItem[],
  edges: readonly GraphEdge[],
  now = new Date(),
  staleDays = 90
): ProjectHealthReport {
  const qa = buildBusinessRuleTestCoverageMatrix(items, edges);
  const untestedRuleIds = qa.rows.filter((r) => !r.covered).map((r) => r.ruleId);

  const staleThreshold = now.getTime() - staleDays * 24 * 60 * 60_000;
  const staleItemIds = items
    .filter((i) => i.status !== "deprecated" && new Date(i.updatedAt).getTime() < staleThreshold)
    .map((i) => i.id);

  const byKey = new Map<string, { git?: KnowledgeItem; connector?: KnowledgeItem }>();
  for (const item of items) {
    const entry = byKey.get(item.id) ?? {};
    if (item.sourceKind === "git") entry.git = item;
    if (item.sourceKind === "connector") entry.connector = item;
    byKey.set(item.id, entry);
  }
  const gitVsConnectorConflicts: ProjectHealthReport["gitVsConnectorConflicts"] = [];
  for (const [id, entry] of byKey) {
    if (entry.git && entry.connector && entry.git.contentHash !== entry.connector.contentHash) {
      gitVsConnectorConflicts.push({
        id,
        gitHash: entry.git.contentHash,
        connectorHash: entry.connector.contentHash
      });
    }
  }

  const penalty = untestedRuleIds.length * 10 + staleItemIds.length * 5 + gitVsConnectorConflicts.length * 15;
  return {
    healthScore: Math.max(0, 100 - penalty),
    untestedRuleIds,
    staleItemIds,
    gitVsConnectorConflicts
  };
}

/**
 * DevOps/SRE: calcula o raio de explosão (blast radius) na topologia do grafo a partir de um nó raiz.
 */
export function buildTopologyBlastRadius(opts: {
  rootNodeId: string;
  edges: readonly GraphEdge[];
  items?: readonly KnowledgeItem[];
  maxHops?: number;
}): TopologyBlastRadius {
  const maxHops = Math.max(1, opts.maxHops ?? 3);
  const itemMap = new Map((opts.items ?? []).map((i) => [i.id, i]));
  const visited = new Set<string>([opts.rootNodeId]);
  const queue: Array<{ id: string; hops: number }> = [{ id: opts.rootNodeId, hops: 0 }];
  const impactedNodes: BlastRadiusNode[] = [];

  const outgoingRelations = new Set(["IMPACTS", "PUBLISHES_EVENT", "CONSUMES_API", "DEPENDS_ON", "SUBSCRIBES_TO"]);
  const reverseDependentRelations = new Set(["DEPENDS_ON", "CONSUMES_API", "GOVERNED_BY", "SUBSCRIBES_TO"]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.hops >= maxHops) continue;

    for (const edge of opts.edges) {
      let neighborId: string | undefined;
      if (edge.fromItemId === current.id && outgoingRelations.has(edge.relationType)) {
        neighborId = edge.toItemId;
      } else if (edge.toItemId === current.id && reverseDependentRelations.has(edge.relationType)) {
        neighborId = edge.fromItemId;
      }

      if (!neighborId || visited.has(neighborId)) continue;
      visited.add(neighborId);

      const nextHops = current.hops + 1;
      const item = itemMap.get(neighborId);
      impactedNodes.push({
        itemId: neighborId,
        hops: nextHops,
        relationType: edge.relationType,
        ...(item ? { title: item.title, type: item.type } : {})
      });
      queue.push({ id: neighborId, hops: nextHops });
    }
  }

  const totalImpacted = impactedNodes.length;
  const blastRadiusScore = Math.min(
    100,
    impactedNodes.reduce((acc, n) => acc + Math.max(10, 35 - (n.hops - 1) * 10), 0)
  );
  const severity: TopologyBlastRadius["severity"] =
    blastRadiusScore >= 80 ? "critical" : blastRadiusScore >= 50 ? "high" : blastRadiusScore >= 20 ? "medium" : "low";

  return {
    rootNodeId: opts.rootNodeId,
    impactedNodes,
    totalImpacted,
    blastRadiusScore,
    severity
  };
}

/**
 * DevOps/SRE: correlaciona incidentes de produção com símbolos de código, serviços, contratos e regras.
 */
export function buildIncidentToCodeMap(opts: {
  incidents: readonly IncidentRecord[];
  items: readonly KnowledgeItem[];
  edges?: readonly GraphEdge[];
}): IncidentCodeMapping[] {
  const itemMap = new Map(opts.items.map((i) => [i.id, i]));

  return opts.incidents.map((incident) => {
    const matchedItems: IncidentMatchedItem[] = [];
    const seenIds = new Set<string>();
    const incidentTags = new Set((incident.tags ?? []).map((t) => t.toLowerCase()));
    const serviceNeedle = incident.service?.toLowerCase();
    const endpointNeedle = incident.endpoint?.toLowerCase();

    for (const item of opts.items) {
      if (item.status === "deprecated") continue;
      const reasons: string[] = [];

      if (
        serviceNeedle &&
        (item.projectId.toLowerCase() === serviceNeedle ||
          item.title.toLowerCase().includes(serviceNeedle) ||
          item.tags.some((t) => t.toLowerCase() === serviceNeedle))
      ) {
        reasons.push(`service:${incident.service}`);
      }

      if (
        endpointNeedle &&
        (item.title.toLowerCase().includes(endpointNeedle) ||
          item.content.toLowerCase().includes(endpointNeedle) ||
          item.sourceUri.toLowerCase().includes(endpointNeedle))
      ) {
        reasons.push(`endpoint:${incident.endpoint}`);
      }

      if (incidentTags.size > 0 && item.tags.some((t) => incidentTags.has(t.toLowerCase()))) {
        reasons.push("tag-match");
      }

      if (reasons.length > 0 && !seenIds.has(item.id)) {
        seenIds.add(item.id);
        matchedItems.push({
          itemId: item.id,
          type: item.type,
          title: item.title,
          sourceUri: item.sourceUri,
          matchReason: reasons.join(", ")
        });
      }
    }

    // Expande 1 hop no grafo para localizar arquivos/regras relacionados
    for (const edge of opts.edges ?? []) {
      const fromMatched = seenIds.has(edge.fromItemId);
      const toMatched = seenIds.has(edge.toItemId);
      if (!fromMatched && !toMatched) continue;
      const relatedId = fromMatched ? edge.toItemId : edge.fromItemId;
      if (seenIds.has(relatedId)) continue;
      const relatedItem = itemMap.get(relatedId);
      if (!relatedItem) continue;
      seenIds.add(relatedId);
      matchedItems.push({
        itemId: relatedItem.id,
        type: relatedItem.type,
        title: relatedItem.title,
        sourceUri: relatedItem.sourceUri,
        matchReason: `graph:${edge.relationType}`
      });
    }

    const candidateFiles = [...new Set(matchedItems.map((m) => m.sourceUri).filter(Boolean))];
    return {
      incidentId: incident.id,
      title: incident.title,
      matchedItems,
      candidateFiles
    };
  });
}

/**
 * DevOps/SRE: gate determinístico de prontidão para deploy (cobertura, SBOM/CVE, saúde, incidentes e guardians).
 */
export function evaluatePreDeployReadiness(opts: {
  coveragePercent: number;
  minCoveragePercent?: number;
  sbomPackages: readonly SbomPackageRisk[];
  healthScore: number;
  minHealthScore?: number;
  openCriticalIncidents?: number;
  guardianPassed?: boolean;
}): PreDeployReadinessResult {
  const minCoverage = opts.minCoveragePercent ?? 80;
  const minHealth = opts.minHealthScore ?? 70;
  const openIncidents = opts.openCriticalIncidents ?? 0;
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (opts.guardianPassed === false) {
    blockers.push("Guardians (architecture/business-rule) reprovaram em modo enforced.");
  }

  const sbom = evaluateSbomCveGuard(opts.sbomPackages);
  if (!sbom.passed) {
    blockers.push(
      `SBOM contém ${sbom.criticalOrHigh.length} dependência(s) com CVE high/critical (${sbom.criticalOrHigh.map((p) => p.name).join(", ")}).`
    );
  }

  if (openIncidents > 0) {
    blockers.push(`Existem ${openIncidents} incidente(s) crítico(s) aberto(s).`);
  }

  if (opts.coveragePercent < minCoverage) {
    blockers.push(`Cobertura de regras (${opts.coveragePercent}%) abaixo do mínimo (${minCoverage}%).`);
  }

  if (opts.healthScore < minHealth) {
    warnings.push(`Knowledge Health Score (${opts.healthScore}) abaixo do recomendado (${minHealth}).`);
  }

  const score = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        opts.coveragePercent * 0.4 +
          opts.healthScore * 0.4 +
          (sbom.passed ? 20 : 0) -
          openIncidents * 20 -
          (opts.guardianPassed === false ? 25 : 0)
      )
    )
  );

  return {
    ready: blockers.length === 0,
    score,
    blockers,
    warnings
  };
}

const CRITICAL_PII_TERMS = [
  "cpf",
  "cnpj",
  "ssn",
  "passport",
  "credit_card",
  "card_number",
  "cvv",
  "password",
  "senha",
  "secret",
  "token",
  "health_record",
  "health_data",
  "medical",
  "patient"
];

const HIGH_PII_TERMS = [
  "email",
  "phone",
  "telefone",
  "celular",
  "address",
  "endereco",
  "birth_date",
  "birthdate",
  "nascimento",
  "rg",
  "salary",
  "salario"
];

const MEDIUM_PII_TERMS = ["user", "customer", "profile", "account", "name", "nome"];

/**
 * AppSec: classifica endpoints de API por sensibilidade de PII e recomenda controles de segurança.
 */
export function classifyPiiEndpoints(endpoints: readonly EndpointDescriptor[]): PiiEndpointClassification[] {
  return endpoints.map((ep) => {
    const rawCorpus = [ep.path, ep.description ?? "", ...(ep.fields ?? [])].join(" ").toLowerCase();
    const tokens = new Set(rawCorpus.split(/[^a-z0-9_]+/).filter(Boolean));
    const hasTerm = (term: string) =>
      tokens.has(term) || (term.includes("_") && rawCorpus.includes(term));

    const criticalMatches = CRITICAL_PII_TERMS.filter(hasTerm);
    const highMatches = HIGH_PII_TERMS.filter(hasTerm);
    const mediumMatches = MEDIUM_PII_TERMS.filter(hasTerm);

    const detectedCategories = [...new Set([...criticalMatches, ...highMatches, ...mediumMatches])];
    const sensitivity: PiiEndpointClassification["sensitivity"] =
      criticalMatches.length > 0
        ? "critical"
        : highMatches.length > 0
          ? "high"
          : mediumMatches.length > 0
            ? "medium"
            : "none";

    const recommendedControls: string[] = [];
    if (sensitivity === "critical") {
      recommendedControls.push("field-level-encryption", "log-masking", "strict-auth-rbac", "audit-trail");
    } else if (sensitivity === "high") {
      recommendedControls.push("log-masking", "tls-in-transit", "auth-required", "audit-trail");
    } else if (sensitivity === "medium") {
      recommendedControls.push("tls-in-transit", "access-logging");
    }

    const missingAuthRisk = sensitivity !== "none" && ep.authRequired === false;

    return {
      method: ep.method.toUpperCase(),
      path: ep.path,
      sensitivity,
      detectedCategories,
      recommendedControls,
      missingAuthRisk
    };
  });
}

/**
 * Gera um Project Blueprint com stack, ADRs iniciais e políticas recomendadas a partir do perfil do projeto.
 */
export function buildProjectBlueprint(profile: ProjectProfile): ProjectBlueprint {
  const runtime = profile.runtime ?? "node";
  const arch = profile.architectureStyle ?? (profile.scale === "enterprise" ? "microservices" : "modular-monolith");
  const compliance = (profile.compliance ?? []).map((c) => c.toUpperCase());

  const frameworkByRuntime: Record<string, string> = {
    node: "TypeScript + Fastify",
    python: "Python + FastAPI",
    go: "Go + Chi/Echo",
    jvm: "Kotlin/Java + Spring Boot"
  };

  const recommendedAdrs: ProjectBlueprint["recommendedAdrs"] = [
    {
      id: "ADR-001",
      title: `Estilo Arquitetural: ${arch}`,
      rationale: `Adequado para escala '${profile.scale}' no domínio '${profile.domain}' mantendo fronteiras claras de camadas.`
    },
    {
      id: "ADR-002",
      title: "Persistência Multi-Tenant com PostgreSQL + RLS",
      rationale: "Garante isolamento por tenant e rastreabilidade transacional."
    }
  ];

  if (arch === "microservices") {
    recommendedAdrs.push({
      id: "ADR-003",
      title: "Contratos Cross-Service e Outbox Pattern",
      rationale: "Previne inconsistências distribuídas entre serviços."
    });
  }

  const recommendedPolicies = [
    "Enforce L5 -> L0 layer boundaries via architecture-guardian",
    "Require @brain-rule anchors and VERIFIED_BY tests for approved rules"
  ];

  if (compliance.includes("LGPD") || compliance.includes("GDPR")) {
    recommendedPolicies.push("PII classification, data minimization, and retention TTL enforcement (LGPD/GDPR)");
  }
  if (compliance.includes("PCI-DSS") || compliance.includes("PCI")) {
    recommendedPolicies.push("Tokenization and strict network segmentation for cardholder data (PCI-DSS)");
  }
  if (compliance.includes("SOC2") || compliance.includes("HIPAA")) {
    recommendedPolicies.push("Immutable audit logging and RBAC least-privilege review (SOC2/HIPAA)");
  }

  return {
    projectName: profile.name,
    recommendedStack: {
      runtime,
      framework: frameworkByRuntime[runtime] ?? "TypeScript + Fastify",
      database: "PostgreSQL 16 + pgvector",
      messaging: profile.scale === "startup" ? "PostgreSQL Outbox / Redis Streams" : "Kafka / Temporal Workflows",
      observability: "OpenTelemetry + Structured JSON Logs"
    },
    recommendedAdrs,
    recommendedPolicies
  };
}
