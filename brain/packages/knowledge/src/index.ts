import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { KnowledgeItem, KnowledgeStatus, KnowledgeType } from "@brain/core";

export function computeContentHash(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  return createHash("sha256").update(normalized).digest("hex");
}

export function normalizePosixPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function inferDomainFromPath(filePath: string): number {
  const p = normalizePosixPath(filePath).toLowerCase();
  if (p.includes("00-overview/") || p.includes("visao/") || p.includes("vision")) return 1;
  if (p.includes("01-business/kpis/") || p.includes("dados/") || p.includes("analytics/") || p.includes("bi/")) return 10;
  if (p.includes("01-business/customer-journeys/") || p.includes("clientes/") || p.includes("suporte/") || p.includes("ux/")) return 9;
  if (p.includes("01-business/") || p.includes("marketing/") || p.includes("vendas/") || p.includes("comercial/") || p.includes("financeiro/")) return 2;
  if (p.includes("02-product/") || p.includes("05-execution/") || p.includes("produto/") || p.includes("design/") || p.includes("pesquisa/")) return 6;
  if (p.includes("03-architecture/decisions/") || p.includes("adr")) return 7;
  if (p.includes("03-architecture/data-models/") || p.endsWith(".sql")) return 10;
  if (p.includes("03-architecture/") || p.includes("arquitetura/") || p.includes("diagrams/") || p.endsWith(".mmd") || p.endsWith(".mermaid")) return 3;
  if (p.includes("policies/") || p.includes("security-standards") || p.includes("juridico/") || p.includes("compliance/") || p.includes("seguranca/")) return 11;
  if (p.includes("04-engineering/") || p.includes("engenharia/") || p.includes("specs/") || p.includes("contracts/")) return 4;
  if (p.includes("06-operations/") || p.includes("operacoes/") || p.includes("infra/") || p.includes("devops/") || p.includes("runbooks/")) return 8;
  if (p.includes("08-agent-memory/") || p.includes("skills/") || p.includes("memory/")) return 12;
  return 5;
}

export interface ParseFileOptions {
  tenantId: string;
  projectId: string;
  filePath: string;
  rawContent: string;
  commitSha?: string;
}

const KNOWLEDGE_TYPES = [
  "business_rule",
  "requirement",
  "feature",
  "architecture_decision",
  "code_symbol",
  "test",
  "service",
  "api_contract",
  "event_contract",
  "task",
  "process",
  "integration",
  "risk",
  "memory",
  "document",
  "skill",
  "spec",
  "glossary_term",
  "product_capability",
  "data_model",
  "use_case",
  "journey",
  "risk_control",
  "slo_target",
  "runbook",
  "incident_postmortem",
  "pending_decision",
  "implementation_pattern",
  "limit_constraint",
  "role_responsibility",
  "compatibility_matrix",
  "code_vocabulary",
  "experiment_record",
  "known_exception",
  "mock_data_sample",
  "external_dependency",
  "acceptance_criteria"
] as const satisfies readonly KnowledgeType[];

const KNOWLEDGE_STATUSES = ["draft", "approved", "deprecated", "superseded"] as const;

export const KnowledgeYamlSchema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    type: z.enum(KNOWLEDGE_TYPES).optional(),
    status: z.enum(KNOWLEDGE_STATUSES).optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    access_policy: z.string().min(1).optional(),
    confidence: z.coerce.number().min(0).max(1).optional(),
    is_inferred: z.coerce.boolean().optional(),
    trust_level: z.enum(["verified", "self_authored", "untrusted"]).optional(),
    owner: z.string().optional(),
    version: z.coerce.number().int().positive().optional(),
    tags: z.array(z.string()).optional(),
    priority: z.enum(["low", "medium", "high", "critical"]).optional(),
    conditions: z.array(z.string()).optional(),
    effects: z.array(z.string()).optional(),
    exceptions: z.array(z.string()).optional(),
    validFrom: z.string().optional(),
    validUntil: z.string().optional(),
    related: z.record(z.string(), z.array(z.string())).optional()
  })
  .passthrough();

export const ProjectManifestSchema = z
  .object({
    schemaVersion: z.string().default("1.0.0"),
    tenantId: z.string().min(1),
    projectId: z.string().min(1),
    knowledgeRoot: z.string().default(".brain/"),
    ownerRepo: z.string().optional(),
    knowledgePaths: z.array(z.string()).optional(),
    knowledgePrecedence: z.array(z.string()).optional(),
    subProjects: z.array(z.string()).optional(),
    guardianMode: z.enum(["audit", "advisory", "enforced"]).default("advisory")
  })
  .passthrough();

export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export function parseProjectManifest(rootDir: string): ProjectManifest | undefined {
  const manifestPath = join(rootDir, ".project-brain.json");
  if (!existsSync(manifestPath)) return undefined;
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  return ProjectManifestSchema.parse(raw);
}

export function resolveKnowledgePathsByPrecedence(manifest?: ProjectManifest): string[] {
  if (!manifest) return [".brain/"];
  if (manifest.knowledgePrecedence && manifest.knowledgePrecedence.length > 0) {
    return manifest.knowledgePrecedence;
  }
  if (manifest.knowledgePaths && manifest.knowledgePaths.length > 0) {
    return manifest.knowledgePaths;
  }
  return [manifest.knowledgeRoot || ".brain/"];
}

const GIT_AUTHORITATIVE_DOMAINS = new Set([1, 2, 3, 4, 7, 11]);

export function resolveSourceConflict(
  existing: KnowledgeItem,
  incoming: KnowledgeItem
): { winner: KnowledgeItem; conflictWarning?: string } {
  if (existing.contentHash === incoming.contentHash) {
    return { winner: existing };
  }
  if (GIT_AUTHORITATIVE_DOMAINS.has(existing.domainId)) {
    if (existing.sourceKind === "git" && incoming.sourceKind === "connector") {
      return {
        winner: existing,
        conflictWarning: `Conflito em '${existing.id}': Git prevalece sobre conector externo '${incoming.sourceId}' (domínio ${existing.domainId}).`
      };
    }
    if (incoming.sourceKind === "git" && existing.sourceKind === "connector") {
      return {
        winner: incoming,
        conflictWarning: `Conflito em '${incoming.id}': Git sobrescreveu dado de conector externo '${existing.sourceId}'.`
      };
    }
  }
  return {
    winner: incoming.version >= existing.version ? incoming : existing,
    conflictWarning: `Conflito de versão detectado em '${existing.id}' (${existing.sourceKind} vs ${incoming.sourceKind}).`
  };
}

function extractMermaidCodeFlow(posixPath: string, content: string, rawType?: string) {
  const isMermaidFile = posixPath.toLowerCase().endsWith(".mmd") || posixPath.toLowerCase().endsWith(".mermaid");
  const mermaidMatch = content.match(/```mermaid\s*\n([\s\S]*?)```/i);
  const mermaidDiagram = isMermaidFile ? content.trim() : mermaidMatch?.[1]?.trim();
  if (!mermaidDiagram) return undefined;
  if (!isMermaidFile && rawType !== "process" && !posixPath.includes("05-flows")) return undefined;

  const entryMatch = content.match(/\*{0,2}Entrypoint:\*{0,2}\s*`?([^\n`]+)`?/i);
  const entrypoint = entryMatch?.[1]?.trim() || posixPath;

  const steps: Array<{
    order: number;
    layer: string;
    componentOrClass?: string;
    fnName: string;
    filePath?: string;
  }> = [];

  const numberedRe = /^\s*(\d+)\.\s+\*{0,2}\[([^\]]+)\]\*{0,2}\s+`?([^\s`(]+)`?(?:\s+\(`?([^)`\n]+)`?\))?/gm;
  for (const m of content.matchAll(numberedRe)) {
    const fnToken = m[3]?.trim() ?? "";
    const dotIdx = fnToken.indexOf(".");
    steps.push({
      order: Number(m[1]),
      layer: m[2]?.trim() ?? "flow",
      componentOrClass: dotIdx > 0 ? fnToken.slice(0, dotIdx) : undefined,
      fnName: dotIdx > 0 ? fnToken.slice(dotIdx + 1) : fnToken,
      filePath: m[4]?.trim()
    });
  }

  if (steps.length === 0) {
    const nodeRe = /^\s*[A-Za-z0-9_]+\s*\["?([^"\]]+)"?\]/gm;
    let order = 1;
    for (const m of mermaidDiagram.matchAll(nodeRe)) {
      const label = m[1]?.trim();
      if (!label) continue;
      steps.push({ order: order++, layer: "flow", fnName: label });
    }
  }

  return {
    entrypoint,
    steps,
    mermaidDiagram,
    layers: [...new Set(steps.map((s) => s.layer))]
  };
}

/**
 * Converte arquivos .yaml/.yml ou .md (com frontmatter) da camada Git em KnowledgeItem validado via Zod.
 */
export function parseKnowledgeFile(opts: ParseFileOptions): KnowledgeItem {
  const posixPath = normalizePosixPath(opts.filePath);
  const now = new Date().toISOString();
  let rawMeta: Record<string, unknown> = {};
  let body = opts.rawContent;

  const isKnowledgeDir = /(^|\/)(\.brain|data\/knowledge)\//.test(posixPath);
  const lowerPath = posixPath.toLowerCase();
  if (lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml")) {
    try {
      const parsed = yaml.load(opts.rawContent);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        const check = KnowledgeYamlSchema.safeParse(candidate);
        if (check.success) {
          rawMeta = candidate;
          body = String(rawMeta.description ?? opts.rawContent);
        } else if (isKnowledgeDir) {
          rawMeta = {
            id: typeof candidate.id === "string" ? candidate.id : undefined,
            title: typeof candidate.title === "string" ? candidate.title : undefined,
            summary: typeof candidate.summary === "string" ? candidate.summary : undefined,
            tags: Array.isArray(candidate.tags) ? candidate.tags.map(String) : undefined
          };
          body = opts.rawContent;
        }
      }
    } catch {
      // Non-knowledge or templated YAML falls back safely to raw document.
    }
  } else if (lowerPath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(opts.rawContent);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const candidate = parsed as Record<string, unknown>;
        const check = KnowledgeYamlSchema.safeParse(candidate);
        if (check.success) {
          rawMeta = candidate;
          body = String(rawMeta.description ?? opts.rawContent);
        }
      }
    } catch {
      // Malformed or partial JSON falls back safely to raw document.
    }
  } else if (opts.rawContent.startsWith("---")) {
    const endIdx = opts.rawContent.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const fm = opts.rawContent.slice(3, endIdx);
      try {
        const parsed = yaml.load(fm);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          rawMeta = parsed as Record<string, unknown>;
        }
      } catch {
        rawMeta = {};
      }
      body = opts.rawContent.slice(endIdx + 4).trim();
    }
  }

  const parsedMeta = KnowledgeYamlSchema.safeParse(rawMeta);
  const meta = parsedMeta.success ? parsedMeta.data : {};
  const isMermaidFile = lowerPath.endsWith(".mmd") || lowerPath.endsWith(".mermaid");
  const id = String(meta.id ?? posixPath);
  const title = String(meta.title ?? posixPath.split("/").pop() ?? id);
  const type = (meta.type as KnowledgeType) ?? (isMermaidFile ? "process" : "document");
  const status = (meta.status as KnowledgeStatus) ?? (isMermaidFile ? "approved" : "draft");
  const accessPolicyId = String(meta.access_policy ?? "internal-project");
  const version = Number(meta.version ?? 1);

  const structuredBlocks: string[] = [];
  if (meta.conditions?.length) structuredBlocks.push(`Conditions:\n- ${meta.conditions.join("\n- ")}`);
  if (meta.effects?.length) structuredBlocks.push(`Effects:\n- ${meta.effects.join("\n- ")}`);
  if (meta.exceptions?.length) structuredBlocks.push(`Exceptions:\n- ${meta.exceptions.join("\n- ")}`);
  const consolidatedContent = structuredBlocks.length > 0 ? `${body}\n\n${structuredBlocks.join("\n\n")}` : body;

  const relatedIds = meta.related
    ? [...new Set(Object.values(meta.related).flat())]
    : [];

  const extractedCodeFlow = extractMermaidCodeFlow(posixPath, consolidatedContent, type);
  const metadata: Record<string, unknown> = {
    ...meta,
    ...(extractedCodeFlow ? { knowledgeLayer: "code", codeFlow: extractedCodeFlow } : {})
  };

  return {
    id,
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    domainId: inferDomainFromPath(posixPath),
    type,
    title,
    content: consolidatedContent,
    summary: typeof meta.summary === "string" ? meta.summary : undefined,
    status,
    sourceId: posixPath,
    sourceOrigin: "internal",
    sourceKind: "git",
    sourceVersion: opts.commitSha ?? `v${version}`,
    sourceUri: posixPath,
    version,
    contentHash: computeContentHash(opts.rawContent),
    ownerId: typeof meta.owner === "string" ? meta.owner : undefined,
    confidence: meta.confidence ?? 1.0,
    trustLevel: meta.trust_level ?? "verified",
    isInferred: meta.is_inferred ?? false,
    validFrom: meta.validFrom,
    validUntil: meta.validUntil,
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    relatedIds,
    accessPolicyId,
    metadata,
    createdAt: now,
    updatedAt: now
  };
}

export {
  type RlsSessionContext,
  type KnowledgeItemVersion,
  type UpsertKnowledgeResult,
  type KnowledgeRepository,
  type KnowledgeSqlParameter,
  type KnowledgeSqlTransactionRunner,
  type KnowledgeSqlClient,
  type KnowledgePostgresTarget,
  type PostgresKnowledgeRepositoryOptions,
  type KnowledgeItemRow,
  type KnowledgeItemVersionRow,
  type SystemKnowledgeSqlClient,
  type PrivacyEraseSubjectInput,
  type PrivacyEraseSubjectResult,
  validateKnowledgeItemForRlsContext,
  InMemoryKnowledgeRepository,
  PostgresKnowledgeRepository,
  SqlKnowledgeRepository,
  createPostgresKnowledgeRepository,
  privacyEraseSubject
} from "./repository.js";


