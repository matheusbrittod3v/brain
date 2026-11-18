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
  const p = normalizePosixPath(filePath);
  if (p.includes("00-overview/")) return 1;
  if (p.includes("01-business/kpis/")) return 10;
  if (p.includes("01-business/customer-journeys/")) return 9;
  if (p.includes("01-business/")) return 2;
  if (p.includes("02-product/") || p.includes("05-execution/")) return 6;
  if (p.includes("03-architecture/decisions/")) return 7;
  if (p.includes("03-architecture/data-models/")) return 10;
  if (p.includes("03-architecture/")) return 3;
  if (p.includes("policies/") || p.includes("security-standards")) return 11;
  if (p.includes("04-engineering/")) return 4;
  if (p.includes("06-operations/")) return 8;
  if (p.includes("08-agent-memory/")) return 12;
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
  "document"
] as const;

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

/**
 * Converte arquivos .yaml/.yml ou .md (com frontmatter) da camada Git em KnowledgeItem validado via Zod.
 */
export function parseKnowledgeFile(opts: ParseFileOptions): KnowledgeItem {
  const posixPath = normalizePosixPath(opts.filePath);
  const now = new Date().toISOString();
  let rawMeta: Record<string, unknown> = {};
  let body = opts.rawContent;

  const isKnowledgeDir = /(^|\/)(\.brain|data\/knowledge)\//.test(posixPath);
  if (posixPath.endsWith(".yaml") || posixPath.endsWith(".yml")) {
    if (isKnowledgeDir) {
      rawMeta = (yaml.load(opts.rawContent) as Record<string, unknown>) ?? {};
      body = String(rawMeta.description ?? opts.rawContent);
    } else {
      try {
        const parsed = yaml.load(opts.rawContent);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const check = KnowledgeYamlSchema.safeParse(parsed);
          if (check.success) {
            rawMeta = parsed as Record<string, unknown>;
            body = String(rawMeta.description ?? opts.rawContent);
          }
        }
      } catch {
        // Non-knowledge YAML (e.g., Helm templates with {{ ... }}) falls back to raw document.
      }
    }
  } else if (opts.rawContent.startsWith("---")) {
    const endIdx = opts.rawContent.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const fm = opts.rawContent.slice(3, endIdx);
      rawMeta = (yaml.load(fm) as Record<string, unknown>) ?? {};
      body = opts.rawContent.slice(endIdx + 4).trim();
    }
  }

  const meta = KnowledgeYamlSchema.parse(rawMeta);
  const id = String(meta.id ?? posixPath);
  const title = String(meta.title ?? posixPath.split("/").pop() ?? id);
  const type = (meta.type as KnowledgeType) ?? "document";
  const status = (meta.status as KnowledgeStatus) ?? "draft";
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
    metadata: meta,
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


