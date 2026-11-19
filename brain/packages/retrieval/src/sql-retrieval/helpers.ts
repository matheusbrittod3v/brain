import { createHash } from "node:crypto";
import type { KnowledgeItem, KnowledgeStatus, KnowledgeType, TrustLevel } from "@brain/core";
import type { RetrievalKnowledgeItemRow, SqlSearchHit } from "./types.js";

const INVALID_TOKEN_CHARS = /[,\0\r\n]/;
const EXPECTED_VECTOR_DIMENSIONS = 1024;
export const RRF_K = 60;
export const DEFAULT_CACHE_MAX_ENTRIES = 500;
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

interface LruCacheEntry {
  tenantId: string;
  projectId: string;
  value: SqlSearchHit[];
  expiresAtMs: number;
}

export class LruQueryCache {
  private readonly store = new Map<string, LruCacheEntry>();

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly now: () => Date
  ) {}

  get(key: string): SqlSearchHit[] | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now().getTime() >= entry.expiresAtMs) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, tenantId: string, projectId: string, value: SqlSearchHit[]): void {
    if (this.maxEntries <= 0 || this.ttlMs <= 0) return;
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      tenantId,
      projectId,
      value,
      expiresAtMs: this.now().getTime() + this.ttlMs
    });
  }

  invalidate(tenantId: string, projectId?: string): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.tenantId !== tenantId) continue;
      if (projectId !== undefined && entry.projectId !== projectId) continue;
      this.store.delete(key);
    }
  }

  get size(): number {
    return this.store.size;
  }
}

export function computePolicyHash(allowedProjects: Set<string>, allowedPolicies: Set<string>): string {
  const payload = JSON.stringify({
    projects: [...allowedProjects].sort(),
    policies: [...allowedPolicies].sort()
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function parseAtDate(atDate: string | undefined): { iso: string; ms: number } | undefined {
  if (atDate === undefined) return undefined;
  const ms = Date.parse(atDate);
  if (Number.isNaN(ms)) {
    throw new Error("SearchQuery.atDate must be a valid ISO-8601 date string.");
  }
  return { iso: new Date(ms).toISOString(), ms };
}

export function compositeItemKey(projectId: string, itemId: string): string {
  return JSON.stringify([projectId, itemId]);
}

export function requireToken(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (INVALID_TOKEN_CHARS.test(raw)) {
    throw new Error(`${fieldName} contains invalid characters (comma, null byte, or newline).`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (trimmed === "*") {
    throw new Error(`${fieldName} cannot be wildcard '*'; an explicit identifier is required.`);
  }
  return trimmed;
}

export function validateDomainFilter(domains: readonly number[] | undefined): string {
  if (!domains || domains.length === 0) return "";
  const normalized: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i];
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 12) {
      throw new Error(`domains[${i}] must be an integer domain ID between 1 and 12.`);
    }
    if (!seen.has(d)) {
      seen.add(d);
      normalized.push(d);
    }
  }
  return normalized.join(",");
}

export function validateQueryEmbedding(embedding: readonly number[] | undefined): string | undefined {
  if (embedding === undefined) return undefined;
  if (!Array.isArray(embedding) || embedding.length !== EXPECTED_VECTOR_DIMENSIONS) {
    throw new Error(`queryEmbedding must be a finite number array of exactly ${EXPECTED_VECTOR_DIMENSIONS} dimensions.`);
  }
  const formatted: string[] = [];
  for (let i = 0; i < embedding.length; i++) {
    const val = embedding[i];
    if (typeof val !== "number" || !Number.isFinite(val)) {
      throw new Error(`queryEmbedding[${i}] must be a finite number.`);
    }
    formatted.push(String(val));
  }
  return `[${formatted.join(",")}]`;
}

export function parseIsoOrString(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function parseOptionalIso(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  return parseIsoOrString(val);
}

function parseTagsArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string" && val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.replace(/^"(.*)"$/, "$1"));
  }
  return [];
}

function parseMetadataObject(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof val === "object" && !Array.isArray(val)) {
    return { ...(val as Record<string, unknown>) };
  }
  return {};
}

export function mapRowToKnowledgeItem(row: RetrievalKnowledgeItemRow): KnowledgeItem {
  const metadata = parseMetadataObject(row.metadata);
  const relatedIds = Array.isArray(metadata.relatedIds) ? metadata.relatedIds.map(String) : [];
  const summary = row.summary !== null && row.summary !== undefined ? String(row.summary) : undefined;
  const ownerId = row.owner_id !== null && row.owner_id !== undefined ? String(row.owner_id) : undefined;
  const validFrom = parseOptionalIso(row.valid_from);
  const validUntil = parseOptionalIso(row.valid_until);
  const deletedAt = parseOptionalIso(row.deleted_at);

  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    domainId: Number(row.domain_id),
    type: row.type as KnowledgeType,
    title: String(row.title),
    content: String(row.content),
    ...(summary !== undefined ? { summary } : {}),
    status: row.status as KnowledgeStatus,
    sourceId: String(row.source_id),
    sourceOrigin: row.source_origin as KnowledgeItem["sourceOrigin"],
    sourceKind: row.source_kind as KnowledgeItem["sourceKind"],
    sourceVersion: String(row.source_version),
    sourceUri: String(row.source_uri),
    version: Number(row.version),
    contentHash: String(row.content_hash),
    ...(ownerId !== undefined ? { ownerId } : {}),
    confidence: Number(row.confidence),
    trustLevel: row.trust_level as TrustLevel,
    isInferred: Boolean(row.is_inferred),
    ...(validFrom !== undefined ? { validFrom } : {}),
    ...(validUntil !== undefined ? { validUntil } : {}),
    tags: parseTagsArray(row.tags),
    relatedIds,
    accessPolicyId: String(row.access_policy_id),
    metadata,
    ...(deletedAt !== undefined ? { deletedAt } : {}),
    createdAt: parseIsoOrString(row.created_at),
    updatedAt: parseIsoOrString(row.updated_at)
  };
}

export function computeLexicalFallbackScore(item: KnowledgeItem, terms: readonly string[]): number {
  if (terms.length === 0) return 0.1;
  const hay = `${item.id} ${item.title} ${item.summary ?? ""} ${item.content} ${item.tags.join(" ")}`.toLowerCase();
  let matches = 0;
  for (const t of terms) {
    if (hay.includes(t)) matches += 1;
  }
  return matches / terms.length;
}

