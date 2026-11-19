import type { KnowledgeItem, KnowledgeStatus, KnowledgeType, TrustLevel } from "@brain/core";
import { resolveRlsSessionContext, type ResolvedRlsSessionGucs, type RlsSessionContext } from "@brain/database";
import {
  EXPECTED_EMBEDDING_DIMENSIONS,
  validateToken,
  type KnowledgeItemVersion,
  type ReplaceItemEmbeddingsInput
} from "./types.js";

export function validateKnowledgeItemForRlsContext(
  item: KnowledgeItem,
  context: RlsSessionContext
): { item: KnowledgeItem; resolvedContext: ResolvedRlsSessionGucs } {
  if (!item || typeof item !== "object") {
    throw new Error("KnowledgeItem must be a non-null object.");
  }
  const resolvedContext = resolveRlsSessionContext(context);
  const tenantId = validateToken(item.tenantId, "item.tenantId");
  const projectId = validateToken(item.projectId, "item.projectId");
  const id = validateToken(item.id, "item.id");
  const accessPolicyId = validateToken(item.accessPolicyId, "item.accessPolicyId");
  const contentHash = validateToken(item.contentHash, "item.contentHash");

  if (tenantId !== resolvedContext.tenantId) {
    throw new Error(
      `KnowledgeItem.tenantId '${tenantId}' does not match RLS context tenantId '${resolvedContext.tenantId}'.`
    );
  }

  const allowedProjects = new Set(resolvedContext.allowedProjectsCsv.split(","));
  if (!allowedProjects.has(projectId)) {
    throw new Error(
      `KnowledgeItem.projectId '${projectId}' is not authorized in RLS context allowedProjects.`
    );
  }

  const allowedPolicies = new Set(resolvedContext.allowedPoliciesCsv.split(","));
  if (!allowedPolicies.has(accessPolicyId)) {
    throw new Error(
      `KnowledgeItem.accessPolicyId '${accessPolicyId}' is not authorized in RLS context allowedPolicies.`
    );
  }

  const normalizedRelatedIds = Array.isArray(item.relatedIds) ? item.relatedIds.map(String) : [];
  const baseMetadata =
    item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
      ? { ...item.metadata }
      : {};
  if (normalizedRelatedIds.length > 0 && baseMetadata.relatedIds === undefined) {
    baseMetadata.relatedIds = normalizedRelatedIds;
  }

  return {
    resolvedContext,
    item: {
      ...item,
      id,
      tenantId,
      projectId,
      accessPolicyId,
      contentHash,
      tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
      relatedIds: normalizedRelatedIds,
      metadata: baseMetadata
    }
  };
}

export interface ValidatedReplaceEmbeddings {
  resolvedContext: ResolvedRlsSessionGucs;
  tenantId: string;
  projectId: string;
  knowledgeItemId: string;
  sourceVersion: string;
  accessPolicyId: string;
  embeddingModel: string;
  chunks: Array<{
    chunkIndex: number;
    chunkText: string;
    vectorLiteral: string;
    embedding: number[];
  }>;
}

export function validateReplaceItemEmbeddingsInput(
  input: ReplaceItemEmbeddingsInput,
  context: RlsSessionContext
): ValidatedReplaceEmbeddings {
  if (!input || typeof input !== "object") {
    throw new Error("ReplaceItemEmbeddingsInput must be a non-null object.");
  }
  const resolvedContext = resolveRlsSessionContext(context);
  const tenantId = validateToken(input.tenantId, "input.tenantId");
  const projectId = validateToken(input.projectId, "input.projectId");
  const knowledgeItemId = validateToken(input.knowledgeItemId, "input.knowledgeItemId");
  const sourceVersion = validateToken(input.sourceVersion, "input.sourceVersion");
  const accessPolicyId = validateToken(input.accessPolicyId, "input.accessPolicyId");
  const embeddingModel =
    input.embeddingModel !== undefined
      ? validateToken(input.embeddingModel, "input.embeddingModel")
      : "bge-m3";

  if (tenantId !== resolvedContext.tenantId) {
    throw new Error(
      `ReplaceItemEmbeddingsInput.tenantId '${tenantId}' does not match RLS context tenantId '${resolvedContext.tenantId}'.`
    );
  }

  const allowedProjects = new Set(resolvedContext.allowedProjectsCsv.split(","));
  if (!allowedProjects.has(projectId)) {
    throw new Error(
      `ReplaceItemEmbeddingsInput.projectId '${projectId}' is not authorized in RLS context allowedProjects.`
    );
  }

  const allowedPolicies = new Set(resolvedContext.allowedPoliciesCsv.split(","));
  if (!allowedPolicies.has(accessPolicyId)) {
    throw new Error(
      `ReplaceItemEmbeddingsInput.accessPolicyId '${accessPolicyId}' is not authorized in RLS context allowedPolicies.`
    );
  }

  if (!Array.isArray(input.chunks)) {
    throw new Error("ReplaceItemEmbeddingsInput.chunks must be an array.");
  }

  const validatedChunks: ValidatedReplaceEmbeddings["chunks"] = [];
  for (let i = 0; i < input.chunks.length; i++) {
    const ch = input.chunks[i];
    if (!ch || typeof ch !== "object") {
      throw new Error(`chunks[${i}] must be an object.`);
    }
    if (typeof ch.chunkIndex !== "number" || !Number.isInteger(ch.chunkIndex) || ch.chunkIndex < 0) {
      throw new Error(`chunks[${i}].chunkIndex must be a non-negative integer.`);
    }
    if (typeof ch.chunkText !== "string" || ch.chunkText.trim().length === 0) {
      throw new Error(`chunks[${i}].chunkText must be a non-empty string.`);
    }
    if (!Array.isArray(ch.embedding) || ch.embedding.length !== EXPECTED_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `chunks[${i}].embedding must be an array of exactly ${EXPECTED_EMBEDDING_DIMENSIONS} finite numbers.`
      );
    }
    const nums: number[] = [];
    const formatted: string[] = [];
    for (let j = 0; j < ch.embedding.length; j++) {
      const val = ch.embedding[j];
      if (typeof val !== "number" || !Number.isFinite(val)) {
        throw new Error(`chunks[${i}].embedding[${j}] must be a finite number.`);
      }
      nums.push(val);
      formatted.push(String(val));
    }
    validatedChunks.push({
      chunkIndex: ch.chunkIndex,
      chunkText: ch.chunkText,
      vectorLiteral: `[${formatted.join(",")}]`,
      embedding: nums
    });
  }

  return {
    resolvedContext,
    tenantId,
    projectId,
    knowledgeItemId,
    sourceVersion,
    accessPolicyId,
    embeddingModel,
    chunks: validatedChunks
  };
}

export function toVersionSnapshot(item: KnowledgeItem, createdAt: string): KnowledgeItemVersion {
  return {
    tenantId: item.tenantId,
    projectId: item.projectId,
    itemId: item.id,
    version: item.version,
    domainId: item.domainId,
    type: item.type,
    title: item.title,
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    status: item.status,
    sourceOrigin: item.sourceOrigin,
    sourceKind: item.sourceKind,
    sourceVersion: item.sourceVersion,
    contentHash: item.contentHash,
    ...(item.ownerId !== undefined ? { ownerId: item.ownerId } : {}),
    confidence: item.confidence,
    trustLevel: item.trustLevel,
    isInferred: item.isInferred,
    tags: [...item.tags],
    accessPolicyId: item.accessPolicyId,
    content: item.content,
    metadata: item.metadata ? { ...item.metadata } : {},
    createdAt
  };
}

export function resolveIsoTimestamp(nowFn: () => Date, explicitIso?: string): string {
  if (explicitIso !== undefined) {
    const parsed = new Date(explicitIso);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Invalid ISO timestamp provided.");
    }
    return parsed.toISOString();
  }
  const now = nowFn();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("Clock function returned an invalid Date.");
  }
  return now.toISOString();
}

export function parseIsoOrString(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

export function parseOptionalIso(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  return parseIsoOrString(val);
}

export function parseTagsArray(val: unknown): string[] {
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === "string" && val.startsWith("{") && val.endsWith("}")) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.replace(/^"(.*)"$/, "$1"));
  }
  return [];
}

export function parseMetadataObject(val: unknown): Record<string, unknown> {
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

export interface KnowledgeItemRow {
  id: string;
  tenant_id: string;
  project_id: string;
  domain_id: number;
  type: string;
  title: string;
  content: string;
  summary: string | null;
  status: string;
  source_id: string;
  source_origin: string;
  source_kind: string;
  source_version: string;
  source_uri: string;
  version: number;
  content_hash: string;
  owner_id: string | null;
  confidence: number;
  trust_level: string;
  is_inferred: boolean;
  valid_from: string | Date | null;
  valid_until: string | Date | null;
  tags: string[] | string;
  access_policy_id: string;
  metadata: Record<string, unknown> | string;
  deleted_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface KnowledgeItemVersionRow {
  tenant_id: string;
  project_id: string;
  item_id: string;
  version: number;
  domain_id: number;
  type: string;
  title: string;
  summary: string | null;
  status: string;
  source_origin: string;
  source_kind: string;
  source_version: string;
  content_hash: string;
  owner_id: string | null;
  confidence: number;
  trust_level: string;
  is_inferred: boolean;
  tags: string[] | string;
  access_policy_id: string;
  content: string;
  metadata: Record<string, unknown> | string;
  created_at: string | Date;
}

export function mapRowToKnowledgeItem(row: KnowledgeItemRow): KnowledgeItem {
  const metadata = parseMetadataObject(row.metadata);
  const relatedIds = Array.isArray(metadata.relatedIds)
    ? metadata.relatedIds.map(String)
    : [];
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

export function mapRowToKnowledgeItemVersion(row: KnowledgeItemVersionRow): KnowledgeItemVersion {
  const summary = row.summary !== null && row.summary !== undefined ? String(row.summary) : undefined;
  const ownerId = row.owner_id !== null && row.owner_id !== undefined ? String(row.owner_id) : undefined;

  return {
    tenantId: String(row.tenant_id),
    projectId: String(row.project_id),
    itemId: String(row.item_id),
    version: Number(row.version),
    domainId: Number(row.domain_id),
    type: row.type as KnowledgeType,
    title: String(row.title),
    ...(summary !== undefined ? { summary } : {}),
    status: row.status as KnowledgeStatus,
    sourceOrigin: row.source_origin as KnowledgeItemVersion["sourceOrigin"],
    sourceKind: row.source_kind as KnowledgeItemVersion["sourceKind"],
    sourceVersion: String(row.source_version),
    contentHash: String(row.content_hash),
    ...(ownerId !== undefined ? { ownerId } : {}),
    confidence: Number(row.confidence),
    trustLevel: row.trust_level as TrustLevel,
    isInferred: Boolean(row.is_inferred),
    tags: parseTagsArray(row.tags),
    accessPolicyId: String(row.access_policy_id),
    content: String(row.content),
    metadata: parseMetadataObject(row.metadata),
    createdAt: parseIsoOrString(row.created_at)
  };
}

