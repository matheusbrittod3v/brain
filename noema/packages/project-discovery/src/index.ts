import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import type { KnowledgeItem } from "@noema/core";
import {
  extractCodeAnchors,
  extractCodeSymbols,
  extractFileDependencies,
  initBundledTreeSitterLanguage,
  parseScipIndex,
  type CodeAnchor,
  type CodeSymbol,
  type ScipDocument,
  type TreeSitterGrammar
} from "@noema/code-intelligence";

export interface GitCommitSummary {
  hash: string;
  date: string;
  subject: string;
  files: string[];
}

export interface GitHotspot {
  filePath: string;
  changes: number;
}

export interface GitHistoryAnalysis {
  commits: GitCommitSummary[];
  hotspots: GitHotspot[];
  architecturalCommits: GitCommitSummary[];
  businessCommits: GitCommitSummary[];
}

export interface DeterministicDiscoveryResult {
  projectRoot: string;
  languages: string[];
  frameworks: string[];
  routes: CodeSymbol[];
  symbols: CodeSymbol[];
  anchors: CodeAnchor[];
  sqlTables: string[];
  testFiles: string[];
  infrastructureFiles: string[];
  dependencies: Record<string, string[]>;
  treeSitter: { activeLanguages: string[]; fallbackFiles: string[] };
  scip: {
    state: "not_found" | "available" | "invalid";
    indexPath?: string;
    toolInfo?: string;
    documents: ScipDocument[];
    error?: string;
  };
  confidence: 1.0;
  isInferred: false;
}

export interface ProjectDiscoveryReport {
  deterministic: DeterministicDiscoveryResult;
  gitHistory: GitHistoryAnalysis;
  inferredDrafts: KnowledgeItem[];
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".next", "__pycache__", ".venv"]);

interface GitIgnoreLayer {
  baseDir: string;
  matcher: ReturnType<typeof ignore>;
}

function isIgnored(fullPath: string, isDirectory: boolean, layers: GitIgnoreLayer[]): boolean {
  let ignored = false;
  for (const layer of layers) {
    const pathFromLayer = relative(layer.baseDir, fullPath).replace(/\\/g, "/");
    if (pathFromLayer === ".." || pathFromLayer.startsWith("../")) continue;
    const result = layer.matcher.test(`${pathFromLayer}${isDirectory ? "/" : ""}`);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

function walkFiles(projectRoot: string, dir = projectRoot, acc: string[] = [], inheritedIgnores: GitIgnoreLayer[] = []): string[] {
  if (!existsSync(dir)) return acc;
  const ignorePath = join(dir, ".gitignore");
  const hasRegularIgnoreFile = existsSync(ignorePath) && lstatSync(ignorePath).isFile();
  const ignoreLayers = hasRegularIgnoreFile
    ? [...inheritedIgnores, { baseDir: dir, matcher: ignore().add(readFileSync(ignorePath, "utf8")) }]
    : inheritedIgnores;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (isIgnored(full, st.isDirectory(), ignoreLayers)) continue;
    if (st.isDirectory()) {
      walkFiles(projectRoot, full, acc, ignoreLayers);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Camada 1 (Determinística, confidence=1.0): linguagens, frameworks, rotas, símbolos, SQL e dependências.
 */
function loadScipDiscovery(projectRoot: string, explicitPath?: string): DeterministicDiscoveryResult["scip"] {
  const candidates = explicitPath
    ? [resolve(projectRoot, explicitPath)]
    : [join(projectRoot, "index.scip"), join(projectRoot, ".scip", "index.scip")];
  const indexPath = candidates.find(existsSync);
  if (!indexPath) return { state: "not_found", documents: [] };
  try {
    const relativeIndexPath = relative(projectRoot, resolve(indexPath));
    if (relativeIndexPath.startsWith("..") || lstatSync(indexPath).isSymbolicLink()) {
      throw new Error("Índice SCIP inválido: caminho fora do projeto ou symlink não permitido.");
    }
    const index = parseScipIndex(readFileSync(indexPath));
    return { state: "available", indexPath, toolInfo: index.metadata.toolInfo, documents: index.documents };
  } catch (error) {
    return {
      state: "invalid",
      indexPath,
      documents: [],
      error: error instanceof Error ? error.message : "Índice SCIP inválido."
    };
  }
}

function treeSitterGrammarForPath(filePath: string): TreeSitterGrammar | undefined {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".py") return "python";
  if (ext === ".go") return "go";
  if (ext === ".java") return "java";
  if (ext === ".rs") return "rust";
  return undefined;
}

function isTestPath(filePath: string): boolean {
  const base = filePath.split("/").at(-1) ?? filePath;
  const ext = extname(base).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".rs"].includes(ext)) return false;
  return /(^|\/)(__tests__|tests?)(\/|$)/i.test(filePath)
    || /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/i.test(base)
    || /^test_.*\.py$/i.test(base)
    || /_test\.go$/i.test(base)
    || /^(?:Test.*|.*Test(?:s|Case)?)\.java$/i.test(base);
}

function isInfrastructurePath(filePath: string): boolean {
  const base = filePath.split("/").at(-1) ?? filePath;
  const lower = filePath.toLowerCase();
  return /^(?:dockerfile|containerfile)(?:\..*)?$/i.test(base)
    || /^(?:docker-compose|compose)(?:\.[^/]+)*\.ya?ml$/i.test(base)
    || /^(?:\.gitlab-ci\.yml|jenkinsfile)$/i.test(base)
    || /\.github\/workflows\/[^/]+\.ya?ml$/i.test(lower)
    || /\.(?:tf|tfvars|hcl)$/i.test(base)
    || /(?:^|\/)(?:infra|infrastructure|terraform|k8s|kubernetes|helm|charts)(?:\/|$)/i.test(filePath)
      && /\.(?:ya?ml|json|toml)$/i.test(base);
}

export async function discoverDeterministic(
  projectRoot: string,
  options: { scipIndexPath?: string; treeSitterLoader?: typeof initBundledTreeSitterLanguage } = {}
): Promise<DeterministicDiscoveryResult> {
  const files = walkFiles(projectRoot);
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const symbols: CodeSymbol[] = [];
  const routes: CodeSymbol[] = [];
  const anchors: CodeAnchor[] = [];
  const sqlTables = new Set<string>();
  const testFiles = new Set<string>();
  const infrastructureFiles = new Set<string>();
  const dependencies: Record<string, string[]> = {};
  const grammarNames = new Set(files.map(treeSitterGrammarForPath).filter((value): value is TreeSitterGrammar => Boolean(value)));
  const parsers = new Map<TreeSitterGrammar, Awaited<ReturnType<typeof initBundledTreeSitterLanguage>>>();
  const fallbackFiles = new Set<string>();

  for (const grammar of grammarNames) {
    try {
      parsers.set(grammar, await (options.treeSitterLoader ?? initBundledTreeSitterLanguage)(grammar));
    } catch {
      // Sem gramática válida, a extração determinística anterior permanece disponível.
    }
  }

  try {
    for (const fullPath of files) {
      const rel = relative(projectRoot, fullPath).replace(/\\/g, "/");
      const ext = extname(fullPath);
      if (isTestPath(rel)) testFiles.add(rel);
      if (isInfrastructurePath(rel)) infrastructureFiles.add(rel);

      if (ext === ".ts" || ext === ".tsx") languages.add("typescript");
      else if (ext === ".js" || ext === ".mjs") languages.add("javascript");
      else if (ext === ".py") languages.add("python");
      else if (ext === ".go") languages.add("go");
      else if (ext === ".java") languages.add("java");
      else if (ext === ".rs") languages.add("rust");
      else if (ext === ".sql") languages.add("sql");

      if (rel.endsWith("package.json")) {
        try {
          const pkg = JSON.parse(readFileSync(fullPath, "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          for (const fw of ["fastify", "next", "react", "drizzle-orm", "express", "@modelcontextprotocol/sdk"]) {
            if (allDeps[fw]) frameworks.add(fw);
          }
        } catch {
          // Ignora package.json inválido
        }
      }

      if ([".ts", ".tsx", ".js", ".mjs", ".py", ".go", ".java", ".rs"].includes(ext)) {
        const code = readFileSync(fullPath, "utf8");
        if (ext === ".rs" && /#\[(?:cfg\s*\(\s*test\s*\)|test)\]/.test(code)) testFiles.add(rel);
        const grammar = treeSitterGrammarForPath(rel);
        const parser = grammar ? parsers.get(grammar) : undefined;
        let fileSymbols: CodeSymbol[];
        if (parser) {
          try {
            fileSymbols = extractCodeSymbols(rel, code, { treeSitterParser: parser });
          } catch {
            fallbackFiles.add(rel);
            fileSymbols = extractCodeSymbols(rel, code);
          }
        } else {
          if (grammar) fallbackFiles.add(rel);
          fileSymbols = extractCodeSymbols(rel, code);
        }
        for (const s of fileSymbols) {
          symbols.push(s);
          if (s.kind === "route") routes.push(s);
        }
        anchors.push(...extractCodeAnchors(rel, code));
        const deps = extractFileDependencies(rel, code);
        if (deps.length > 0) dependencies[rel] = deps;
      }

      if (ext === ".sql") {
        const sqlText = readFileSync(fullPath, "utf8");
        const tableMatches = sqlText.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z0-9_.]+)["`]?/gi);
        for (const m of tableMatches) {
          if (m[1]) sqlTables.add(m[1]);
        }
      }
    }
  } finally {
    for (const parser of parsers.values()) parser.delete();
  }

  return {
    projectRoot,
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    routes,
    symbols,
    anchors,
    sqlTables: [...sqlTables].sort(),
    testFiles: [...testFiles].sort(),
    infrastructureFiles: [...infrastructureFiles].sort(),
    dependencies,
    treeSitter: { activeLanguages: [...parsers.keys()].sort(), fallbackFiles: [...fallbackFiles].sort() },
    scip: loadScipDiscovery(projectRoot, options.scipIndexPath),
    confidence: 1.0,
    isInferred: false
  };
}

const ARCHITECTURAL_COMMIT_REGEX = /\b(arch|adr|refactor|schema|db|migration|api|service|infra|module|gateway|boundary)\b/i;
const BUSINESS_COMMIT_REGEX = /\b(feat|rule|business|billing|auth|policy|pricing|subscription|checkout|workflow|invoice|payment)\b/i;
const BUSINESS_SYMBOL_REGEX = /(rule|policy|validate|calculate|billing|invoice|subscription|payment|checkout|discount|refund|cancel|auth|permission)/i;

/**
 * Analisa histórico git recente para identificar módulos hotspot e commits arquiteturais/de negócio.
 */
export function analyzeGitHistory(rootDir: string, limit = 50): GitHistoryAnalysis {
  const empty: GitHistoryAnalysis = {
    commits: [],
    hotspots: [],
    architecturalCommits: [],
    businessCommits: []
  };
  if (!existsSync(rootDir)) return empty;

  let rawOutput: string;
  try {
    rawOutput = execFileSync(
      "git",
      ["log", "-n", String(Math.max(1, limit)), "--name-only", "--pretty=format:%H|%ai|%s"],
      { cwd: rootDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
  } catch {
    return empty;
  }

  const commits: GitCommitSummary[] = [];
  const fileCounts = new Map<string, number>();
  let current: GitCommitSummary | undefined;

  for (const line of rawOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const headerMatch = /^([0-9a-f]{7,40})\|([^|]+)\|(.*)$/.exec(trimmed);
    if (headerMatch) {
      current = {
        hash: headerMatch[1]!,
        date: headerMatch[2]!,
        subject: headerMatch[3]!,
        files: []
      };
      commits.push(current);
    } else if (current) {
      const normalized = trimmed.replace(/\\/g, "/");
      current.files.push(normalized);
      fileCounts.set(normalized, (fileCounts.get(normalized) ?? 0) + 1);
    }
  }

  const hotspots: GitHotspot[] = [...fileCounts.entries()]
    .map(([filePath, changes]) => ({ filePath, changes }))
    .sort((a, b) => b.changes - a.changes || a.filePath.localeCompare(b.filePath))
    .slice(0, 15);

  const architecturalCommits = commits.filter((c) => ARCHITECTURAL_COMMIT_REGEX.test(c.subject));
  const businessCommits = commits.filter((c) => BUSINESS_COMMIT_REGEX.test(c.subject));

  return { commits, hotspots, architecturalCommits, businessCommits };
}

interface DraftItemParams {
  id: string;
  tenantId: string;
  projectId: string;
  domainId: number;
  type: KnowledgeItem["type"];
  title: string;
  content: string;
  summary: string;
  sourceUri: string;
  confidence: number;
  tags: string[];
  metadata?: Record<string, unknown>;
  now: string;
}

function createDraftKnowledgeItem(params: DraftItemParams): KnowledgeItem {
  return {
    id: params.id,
    tenantId: params.tenantId,
    projectId: params.projectId,
    domainId: params.domainId,
    type: params.type,
    title: params.title,
    content: params.content,
    summary: params.summary,
    status: "draft",
    sourceId: "autodiscovery",
    sourceOrigin: "internal",
    sourceKind: "agent",
    sourceVersion: "autodiscovery-v1",
    sourceUri: params.sourceUri,
    version: 1,
    contentHash: createHash("sha256").update(params.content).digest("hex"),
    confidence: params.confidence,
    trustLevel: "untrusted",
    isInferred: true,
    validFrom: params.now,
    tags: params.tags,
    accessPolicyId: "internal-project",
    relatedIds: [],
    metadata: params.metadata ?? {},
    createdAt: params.now,
    updatedAt: params.now
  };
}

/**
 * Camada 2 (Inferência Assistida, is_inferred=true, status='draft'): sugere itens de documentação para revisão humana.
 */
export async function runProjectAutodiscovery(
  projectRoot: string,
  tenantId = "default-org",
  projectId = "default-project"
): Promise<ProjectDiscoveryReport> {
  const deterministic = await discoverDeterministic(projectRoot);
  const gitHistory = analyzeGitHistory(projectRoot);
  const inferredDrafts: KnowledgeItem[] = [];
  const now = new Date().toISOString();
  const normalizedProjectId = projectId.toUpperCase();

  // 00-overview/ (project summary + stack)
  const overviewLines = [
    `# Project Overview (${projectId})`,
    `- Languages: ${deterministic.languages.length > 0 ? deterministic.languages.join(", ") : "none detected"}`,
    `- Frameworks: ${deterministic.frameworks.length > 0 ? deterministic.frameworks.join(", ") : "none detected"}`,
    `- Code symbols: ${deterministic.symbols.length}`,
    `- HTTP routes: ${deterministic.routes.length}`,
    `- SQL tables: ${deterministic.sqlTables.length}`,
    `- Recent git commits analyzed: ${gitHistory.commits.length}`
  ];
  overviewLines.push(`- SCIP documents: ${deterministic.scip.documents.length} (${deterministic.scip.state})`);
  overviewLines.push(`- Test files: ${deterministic.testFiles.length}`);
  overviewLines.push(`- Infrastructure files: ${deterministic.infrastructureFiles.length}`);
  const overviewContent = overviewLines.join("\n");
  inferredDrafts.push(
    createDraftKnowledgeItem({
      id: `DRAFT-OVERVIEW-${normalizedProjectId}`,
      tenantId,
      projectId,
      domainId: 1,
      type: "document",
      title: `Project Summary & Stack (${projectId})`,
      content: overviewContent,
      summary: `Stack: ${deterministic.languages.join(", ") || "unknown"}; ${deterministic.symbols.length} symbols, ${deterministic.routes.length} routes.`,
      sourceUri: ".brain/00-overview/project-summary.md",
      confidence: 0.75,
      tags: ["autodiscovery", "draft", "overview", "stack"],
      metadata: {
        languages: deterministic.languages,
        frameworks: deterministic.frameworks,
        symbolCount: deterministic.symbols.length
      },
      now
    })
  );

  if (deterministic.testFiles.length > 0 || deterministic.infrastructureFiles.length > 0) {
    const content = [
      "# Mapa de testes e infraestrutura",
      "",
      "Arquivos identificados por convenções de nome, diretório e conteúdo. Revise antes de tratar a lista como completa.",
      "",
      "## Testes",
      ...(deterministic.testFiles.length ? deterministic.testFiles.map((file) => `- ${file}`) : ["- Nenhum arquivo detectado"]),
      "",
      "## Infraestrutura",
      ...(deterministic.infrastructureFiles.length ? deterministic.infrastructureFiles.map((file) => `- ${file}`) : ["- Nenhum arquivo detectado"])
    ].join("\n");
    inferredDrafts.push(createDraftKnowledgeItem({
      id: `DRAFT-TEST-INFRA-${normalizedProjectId}`,
      tenantId,
      projectId,
      domainId: 5,
      type: "document",
      title: "Mapa de Testes e Infraestrutura",
      content,
      summary: `${deterministic.testFiles.length} arquivos de teste e ${deterministic.infrastructureFiles.length} arquivos de infraestrutura detectados.`,
      sourceUri: ".brain/05-code/test-and-infrastructure-map.md",
      confidence: 0.8,
      tags: ["autodiscovery", "draft", "tests", "infrastructure"],
      metadata: { testFiles: deterministic.testFiles, infrastructureFiles: deterministic.infrastructureFiles },
      now
    }));
  }

  // 01-business/ (inferred rule candidates)
  const businessSymbols = deterministic.symbols.filter(
    (s) => s.kind !== "route" && BUSINESS_SYMBOL_REGEX.test(s.name)
  );
  const ruleAnchors = deterministic.anchors.filter((a) => a.kind === "brain-rule");
  if (businessSymbols.length > 0 || gitHistory.businessCommits.length > 0 || ruleAnchors.length > 0) {
    const ruleLines = ["Candidatos a regras de negócio inferidos:"];
    for (const a of ruleAnchors) {
      ruleLines.push(`- Anchor ${a.targetId} (${a.filePath}:${a.line})`);
    }
    for (const s of businessSymbols.slice(0, 20)) {
      ruleLines.push(`- Symbol ${s.kind} \`${s.name}\` (${s.filePath}:${s.line})`);
    }
    for (const c of gitHistory.businessCommits.slice(0, 10)) {
      ruleLines.push(`- Commit ${c.hash.slice(0, 7)}: ${c.subject}`);
    }
    const content = ruleLines.join("\n");
    inferredDrafts.push(
      createDraftKnowledgeItem({
        id: `DRAFT-BIZ-${normalizedProjectId}`,
        tenantId,
        projectId,
        domainId: 2,
        type: "business_rule",
        title: `Candidatos a Regras de Negócio (${businessSymbols.length + ruleAnchors.length + gitHistory.businessCommits.length})`,
        content,
        summary: `${businessSymbols.length} símbolos de domínio, ${ruleAnchors.length} âncoras e ${gitHistory.businessCommits.length} commits de negócio.`,
        sourceUri: ".brain/01-business/inferred-rules.md",
        confidence: 0.6,
        tags: ["autodiscovery", "draft", "business"],
        metadata: {
          ruleAnchors: ruleAnchors.map((a) => a.targetId),
          businessSymbolCount: businessSymbols.length
        },
        now
      })
    );
  }

  // 03-architecture/ (API routes)
  if (deterministic.routes.length > 0) {
    const content = `Rotas descobertas automaticamente:\n${deterministic.routes.map((r) => `- ${r.name} (${r.filePath}:${r.line})`).join("\n")}`;
    inferredDrafts.push(
      createDraftKnowledgeItem({
        id: `DRAFT-API-${normalizedProjectId}`,
        tenantId,
        projectId,
        domainId: 3,
        type: "api_contract",
        title: `Superfície HTTP inferida (${deterministic.routes.length} rotas)`,
        content,
        summary: `${deterministic.routes.length} rotas HTTP detectadas por análise estática.`,
        sourceUri: ".brain/03-architecture/api-surface.md",
        confidence: 0.65,
        tags: ["autodiscovery", "draft", "api"],
        metadata: { frameworks: deterministic.frameworks, routeFiles: [...new Set(deterministic.routes.map((r) => r.filePath))] },
        now
      })
    );
  }

  // 03-architecture/ (DB schemas)
  if (deterministic.sqlTables.length > 0) {
    const content = `Tabelas SQL descobertas:\n${deterministic.sqlTables.map((t) => `- ${t}`).join("\n")}`;
    inferredDrafts.push(
      createDraftKnowledgeItem({
        id: `DRAFT-DB-${normalizedProjectId}`,
        tenantId,
        projectId,
        domainId: 3,
        type: "document",
        title: `Schemas de Banco de Dados (${deterministic.sqlTables.length} tabelas)`,
        content,
        summary: `${deterministic.sqlTables.length} tabelas SQL detectadas por análise estática.`,
        sourceUri: ".brain/03-architecture/db-schemas.md",
        confidence: 0.7,
        tags: ["autodiscovery", "draft", "architecture", "database"],
        metadata: { sqlTables: deterministic.sqlTables },
        now
      })
    );
  }

  const scipOccurrences = deterministic.scip.documents.flatMap((document) =>
    document.occurrences.map((occurrence) => ({ document, occurrence }))
  );
  const scipSymbols = deterministic.scip.documents.flatMap((document) =>
    document.symbols.map((symbol) => ({ document, symbol }))
  );
  const scipRelationships = scipSymbols.flatMap(({ document, symbol }) => [
    ...(symbol.enclosingSymbol ? [{ document, from: symbol.symbol, to: symbol.enclosingSymbol, kind: "ENCLOSED_BY" }] : []),
    ...symbol.relationships.flatMap((relationship) => [
      ...(relationship.isImplementation ? [{ document, from: symbol.symbol, to: relationship.symbol, kind: "IMPLEMENTS" }] : []),
      ...(relationship.isReference ? [{ document, from: symbol.symbol, to: relationship.symbol, kind: "REFERENCES" }] : []),
      ...(relationship.isTypeDefinition ? [{ document, from: symbol.symbol, to: relationship.symbol, kind: "TYPE_DEFINITION" }] : []),
      ...(relationship.isDefinition ? [{ document, from: symbol.symbol, to: relationship.symbol, kind: "DEFINITION_ALIAS" }] : [])
    ])
  ]);
  if (scipOccurrences.length > 0 || scipSymbols.length > 0) {
    const content = [
      `Mapa extraído do índice SCIP oficial (${deterministic.scip.toolInfo ?? "indexador desconhecido"}):`,
      `Símbolos: ${scipSymbols.length}; ocorrências: ${scipOccurrences.length}; relações semânticas: ${scipRelationships.length}.`,
      "",
      "### Símbolos definidos",
      ...scipSymbols.slice(0, 200).map(({ document, symbol }) =>
        `- ${symbol.displayName || symbol.symbol} [kind=${symbol.kind}] — ${document.relativePath}${symbol.documentation.length ? ` — ${symbol.documentation.join(" ")}` : ""}`
      ),
      "",
      "### Relações SCIP",
      ...(scipRelationships.length
        ? scipRelationships.slice(0, 200).map(({ document, from, to, kind }) => `- ${kind}: \`${from}\` → \`${to}\` (${document.relativePath})`)
        : ["- Nenhuma relação semântica declarada pelo indexador"]),
      "",
      "### Ocorrências",
      ...scipOccurrences.slice(0, 200).map(({ document, occurrence }) =>
        `- ${occurrence.role} \`${occurrence.symbol}\` — ${document.relativePath}:${occurrence.range[0] + 1}`
      )
    ].join("\n");
    inferredDrafts.push(createDraftKnowledgeItem({
      id: `DRAFT-SCIP-${normalizedProjectId}`,
      tenantId,
      projectId,
      domainId: 5,
      type: "document",
      title: `Mapa Semântico SCIP (${scipSymbols.length} símbolos, ${scipRelationships.length} relações)`,
      content,
      summary: `${scipSymbols.length} símbolos, ${scipRelationships.length} relações e ${scipOccurrences.length} ocorrências em ${deterministic.scip.documents.length} documentos SCIP.`,
      sourceUri: ".brain/05-code/scip-symbol-map.md",
      confidence: 0.9,
      tags: ["autodiscovery", "draft", "code", "scip"],
      metadata: {
        scipToolInfo: deterministic.scip.toolInfo,
        indexPath: deterministic.scip.indexPath,
        documentCount: deterministic.scip.documents.length,
        symbolCount: scipSymbols.length,
        scipRelationshipCount: scipRelationships.length,
        definitionCount: scipOccurrences.filter(({ occurrence }) => occurrence.role === "definition").length,
        referenceCount: scipOccurrences.filter(({ occurrence }) => occurrence.role === "reference").length
      },
      now
    }));
  }

  // 03-architecture/ (discovered services, classes/interfaces, & git hotspots)
  const serviceSymbols = deterministic.symbols.filter((s) => s.kind === "class" || s.kind === "interface");
  if (serviceSymbols.length > 0 || gitHistory.hotspots.length > 0 || gitHistory.architecturalCommits.length > 0) {
    const archLines = ["Componentes arquiteturais e hotspots de mudança:"];
    if (serviceSymbols.length > 0) {
      archLines.push("\n### Serviços / Tipos Principais");
      for (const s of serviceSymbols.slice(0, 25)) {
        archLines.push(`- ${s.kind} \`${s.name}\` (${s.filePath}:${s.line})`);
      }
    }
    if (gitHistory.hotspots.length > 0) {
      archLines.push("\n### Hotspots (Git)");
      for (const h of gitHistory.hotspots.slice(0, 10)) {
        archLines.push(`- ${h.filePath} (${h.changes} alterações)`);
      }
    }
    if (gitHistory.architecturalCommits.length > 0) {
      archLines.push("\n### Commits Arquiteturais Recentes");
      for (const c of gitHistory.architecturalCommits.slice(0, 10)) {
        archLines.push(`- ${c.hash.slice(0, 7)}: ${c.subject}`);
      }
    }
    const content = archLines.join("\n");
    inferredDrafts.push(
      createDraftKnowledgeItem({
        id: `DRAFT-ARCH-${normalizedProjectId}`,
        tenantId,
        projectId,
        domainId: 3,
        type: "service",
        title: `Serviços & Hotspots Arquiteturais (${serviceSymbols.length} componentes, ${gitHistory.hotspots.length} hotspots)`,
        content,
        summary: `${serviceSymbols.length} serviços/tipos e ${gitHistory.hotspots.length} hotspots de histórico git.`,
        sourceUri: ".brain/03-architecture/services-and-hotspots.md",
        confidence: 0.65,
        tags: ["autodiscovery", "draft", "architecture", "hotspots"],
        metadata: {
          hotspots: gitHistory.hotspots,
          architecturalCommitCount: gitHistory.architecturalCommits.length
        },
        now
      })
    );
  }

  return { deterministic, gitHistory, inferredDrafts };
}
