export type GuardianMode = "audit" | "advisory" | "enforced";

export interface GuardianViolation {
  ruleId: string;
  severity: "warning" | "error";
  filePath: string;
  message: string;
}

export interface GuardianReport {
  mode: GuardianMode;
  passed: boolean;
  violations: GuardianViolation[];
}

export interface ArchitectureImportEdge {
  fromPkg: string;
  toPkg: string;
  filePath: string;
}

export interface AppAdapterFile {
  filePath: string;
  content: string;
  maxLines?: number;
}

export const LAYER_ORDER: Record<string, number> = {
  // L0: Contratos puros
  core: 0,

  // L1: Fundação & Segurança
  auth: 1,
  database: 1,
  observability: 1,
  "audit-engine": 1,
  "database-edge": 1,

  // L2: Ingestão, Grafo & Inteligência Base
  knowledge: 2,
  graph: 2,
  retrieval: 2,
  "context-engine": 2,
  memory: 2,
  "code-intelligence": 2,
  ingestion: 2,
  "connector-framework": 2,

  // L3: Análise, Rastreabilidade & Planejamento
  "rules-engine": 3,
  "impact-analysis": 3,
  "task-engine": 3,
  "agent-handoff": 3,
  "cross-service": 3,
  "business-traceability": 3,
  "temporal-knowledge": 3,
  "project-discovery": 3,
  "workspace-detection": 3,

  // L4: Motores de Aplicação & Guardiões
  "architecture-guardian": 4,
  "business-rule-guardian": 4,
  "approval-engine": 4,
  "knowledge-health": 4,
  "workflow-orchestrator": 4,
  "context-optimizer": 4,
  evaluation: 4,
  "enterprise-views": 4,
  "temporal-workflows": 4
};

const KNOWN_APPS = new Set([
  "api",
  "cli",
  "mcp-server",
  "web",
  "worker",
  "agent-runner",
  "ai-worker"
]);

function normalizePkgName(pkg: string): string {
  return pkg.replace(/^@noema\//, "").trim();
}

export function isAppPackage(pkg: string): boolean {
  const normalized = normalizePkgName(pkg);
  return normalized.startsWith("apps/") || KNOWN_APPS.has(normalized);
}

export function resolvePackageLayer(pkg: string): number | undefined {
  const normalized = normalizePkgName(pkg);
  if (isAppPackage(normalized)) {
    return 5;
  }
  return LAYER_ORDER[normalized];
}

function canonicalizeCycle(nodes: string[]): string[] {
  if (nodes.length === 0) return nodes;
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]! < nodes[minIdx]!) {
      minIdx = i;
    }
  }
  return [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
}

function detectCircularDependencies(imports: readonly ArchitectureImportEdge[]): GuardianViolation[] {
  const adj = new Map<string, Array<{ to: string; filePath: string }>>();
  const nodes = new Set<string>();

  for (const imp of imports) {
    const from = normalizePkgName(imp.fromPkg);
    const to = normalizePkgName(imp.toPkg);
    if (from === to) continue;
    nodes.add(from);
    nodes.add(to);
    const list = adj.get(from) ?? [];
    list.push({ to, filePath: imp.filePath });
    adj.set(from, list);
  }

  const state = new Map<string, 0 | 1 | 2>(); // 0 = unvisited, 1 = visiting, 2 = visited
  const stack: string[] = [];
  const seenCycles = new Set<string>();
  const violations: GuardianViolation[] = [];

  const dfs = (u: string) => {
    state.set(u, 1);
    stack.push(u);

    for (const edge of adj.get(u) ?? []) {
      const vState = state.get(edge.to) ?? 0;
      if (vState === 0) {
        dfs(edge.to);
      } else if (vState === 1) {
        const idx = stack.indexOf(edge.to);
        if (idx !== -1) {
          const cycleNodes = stack.slice(idx);
          const canonical = canonicalizeCycle(cycleNodes);
          const key = canonical.join("->");
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            const display = [...cycleNodes, edge.to].join(" -> ");
            violations.push({
              ruleId: "ARCH-CIRCULAR-DEPENDENCY",
              severity: "error",
              filePath: edge.filePath,
              message: `Dependência circular detectada entre pacotes: ${display}.`
            });
          }
        }
      }
    }

    stack.pop();
    state.set(u, 2);
  };

  for (const node of nodes) {
    if ((state.get(node) ?? 0) === 0) {
      dfs(node);
    }
  }

  return violations;
}

/**
 * Valida regras arquiteturais de camadas (L0..L5), dependências circulares,
 * fronteiras thin-adapter de apps/ e cobertura mínima de regras críticas.
 */
export function evaluateArchitectureChange(opts: {
  mode: GuardianMode;
  imports: Array<ArchitectureImportEdge>;
  uncoveredCriticalRules?: string[];
  appFiles?: readonly AppAdapterFile[];
}): GuardianReport {
  const violations: GuardianViolation[] = [];

  for (const imp of opts.imports) {
    const fromNormalized = normalizePkgName(imp.fromPkg);
    const toNormalized = normalizePkgName(imp.toPkg);
    const fromLayer = resolvePackageLayer(fromNormalized);
    const toLayer = resolvePackageLayer(toNormalized);

    if (fromLayer !== undefined && toLayer !== undefined && toLayer > fromLayer) {
      violations.push({
        ruleId: "ARCH-LAYER-VIOLATION",
        severity: "error",
        filePath: imp.filePath,
        message: `Camada L${fromLayer} ('${imp.fromPkg}') não pode importar L${toLayer} ('${imp.toPkg}').`
      });
    }

    if (isAppPackage(fromNormalized) && isAppPackage(toNormalized) && fromNormalized !== toNormalized) {
      violations.push({
        ruleId: "ARCH-APP-BOUNDARY",
        severity: "error",
        filePath: imp.filePath,
        message: `Thin-adapter '${imp.fromPkg}' em apps/ não pode importar outro app '${imp.toPkg}'; extraia contratos compartilhados para packages/.`
      });
    }
  }

  violations.push(...detectCircularDependencies(opts.imports));

  for (const appFile of opts.appFiles ?? []) {
    const maxLines = appFile.maxLines ?? 400;
    const lineCount = appFile.content.split(/\r?\n/).length;
    if (lineCount > maxLines) {
      violations.push({
        ruleId: "ARCH-THIN-ADAPTER",
        severity: "warning",
        filePath: appFile.filePath,
        message: `Arquivo em apps/ excede o limite de thin-adapter (${lineCount} > ${maxLines} linhas); mova lógica de negócio para packages/.`
      });
    }
  }

  for (const ruleId of opts.uncoveredCriticalRules ?? []) {
    violations.push({
      ruleId: "BR-UNVERIFIED",
      severity: "warning",
      filePath: ".brain/",
      message: `Regra crítica '${ruleId}' está sem teste vinculado (VERIFIED_BY).`
    });
  }

  const hasErrors = violations.some((v) => v.severity === "error");
  const passed = opts.mode === "enforced" ? !hasErrors : true;
  return { mode: opts.mode, passed, violations };
}
