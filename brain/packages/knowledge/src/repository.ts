import type { KnowledgeItem, KnowledgeStatus, KnowledgeType, TrustLevel } from "@brain/core";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";

export type { RlsSessionContext } from "@brain/database";

export interface KnowledgeItemVersion {
  tenantId: string;
  projectId: string;
  itemId: string;
  version: number;
  domainId: number;
  type: KnowledgeType;
  title: string;
  summary?: string;
  status: KnowledgeStatus;
  sourceOrigin: "internal" | "external_reference";
  sourceKind: "git" | "api" | "connector" | "agent";
  sourceVersion: string;
  contentHash: string;
  ownerId?: string;
  confidence: number;
  trustLevel: TrustLevel;
  isInferred: boolean;
  tags: string[];
  accessPolicyId: string;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface UpsertKnowledgeResult {
  item: KnowledgeItem;
  versionCreated: boolean;
}

export interface KnowledgeEmbeddingChunkInput {
  chunkIndex: number;
  chunkText: string;
  embedding: readonly number[];
}

export interface ReplaceItemEmbeddingsInput {
  tenantId: string;
  projectId: string;
  knowledgeItemId: string;
  sourceVersion: string;
  accessPolicyId: string;
  embeddingModel?: string;
  chunks: ReadonlyArray<KnowledgeEmbeddingChunkInput>;
}

export interface KnowledgeRepository {
  upsertItem(context: RlsSessionContext, item: KnowledgeItem): Promise<UpsertKnowledgeResult>;
  getItem(context: RlsSessionContext, projectId: string, itemId: string): Promise<KnowledgeItem | undefined>;
  listVersions(context: RlsSessionContext, projectId: string, itemId: string): Promise<KnowledgeItemVersion[]>;
  softDeleteItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string,
    deletedAt?: string
  ): Promise<boolean>;
  replaceItemEmbeddings(
    context: RlsSessionContext,
    input: ReplaceItemEmbeddingsInput
  ): Promise<number>;
}

export type KnowledgeSqlParameter = string | number | boolean | null | readonly string[];

export type KnowledgeSqlTransactionRunner = {
  <TRow = Record<string, unknown>>(
    template: TemplateStringsArray,
    ...parameters: readonly KnowledgeSqlParameter[]
  ): PromiseLike<readonly TRow[]>;
};

export type KnowledgeSqlClient<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> = RlsSqlClient<TTx>;

export type KnowledgePostgresTarget<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> = AppPostgresClient<TTx>;

export type PostgresKnowledgeRepositoryOptions<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> =
  | {
      client: AppPostgresClient<TTx>;
      now?: () => Date;
    }
  | {
      sql: AppPostgresClient<TTx>;
      now?: () => Date;
    };

const UNSAFE_RAW_SQL_TEST_SEAM = Symbol("brain.knowledge.unsafeRawSqlTestSeam");
const EXPECTED_EMBEDDING_DIMENSIONS = 1024;

interface UnsafeTestSeamTarget<TTx extends KnowledgeSqlTransactionRunner> {
  readonly [UNSAFE_RAW_SQL_TEST_SEAM]: true;
  readonly sql: KnowledgeSqlClient<TTx>;
}

function isUnsafeTestSeamTarget<TTx extends KnowledgeSqlTransactionRunner>(
  candidate: unknown
): candidate is UnsafeTestSeamTarget<TTx> {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    UNSAFE_RAW_SQL_TEST_SEAM in (candidate as Record<symbol, unknown>) &&
    (candidate as Record<symbol, unknown>)[UNSAFE_RAW_SQL_TEST_SEAM] === true
  );
}

function assertVerifiedAppPostgresClient<TTx extends KnowledgeSqlTransactionRunner>(
  candidate: unknown
): AppPostgresClient<TTx> {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      "PostgresKnowledgeRepository requires a verified AppPostgresClient bound to role 'brain_app'; raw RlsSqlClient is forbidden on the production path."
    );
  }
  const obj = candidate as Partial<AppPostgresClient<TTx>> & { begin?: unknown };
  if (obj.role !== "brain_app") {
    const receivedRole = "role" in obj ? `'${String(obj.role)}'` : "unverified raw SQL client";
    throw new Error(
      `PostgresKnowledgeRepository requires a verified AppPostgresClient bound to role 'brain_app' (received ${receivedRole}); raw RlsSqlClient is forbidden on the production path.`
    );
  }
  if (
    typeof obj.withRlsTransaction !== "function" ||
    typeof obj.close !== "function" ||
    (obj.sql !== undefined && (!obj.sql || typeof obj.sql.begin !== "function"))
  ) {
    throw new Error(
      "PostgresKnowledgeRepository requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql.begin."
    );
  }
  return obj as AppPostgresClient<TTx>;
}

const INVALID_SCOPE_CHARS = /[,\0\r\n]/;

function validateToken(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (INVALID_SCOPE_CHARS.test(raw)) {
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

function validateScopeAndProject(
  context: RlsSessionContext,
  projectId: string
): { resolved: ResolvedRlsSessionGucs; normalizedProjectId: string; allowedProjects: Set<string>; allowedPolicies: Set<string> } {
  const resolved = resolveRlsSessionContext(context);
  const normalizedProjectId = validateToken(projectId, "projectId");
  const allowedProjects = new Set(resolved.allowedProjectsCsv.split(","));
  const allowedPolicies = new Set(resolved.allowedPoliciesCsv.split(","));

  if (!allowedProjects.has(normalizedProjectId)) {
    throw new Error(
      `Project '${normalizedProjectId}' is not authorized in RLS context allowedProjects.`
    );
  }

  return { resolved, normalizedProjectId, allowedProjects, allowedPolicies };
}

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

function toVersionSnapshot(item: KnowledgeItem, createdAt: string): KnowledgeItemVersion {
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

function resolveIsoTimestamp(nowFn: () => Date, explicitIso?: string): string {
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

function parseIsoOrString(val: unknown): string {
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

function mapRowToKnowledgeItem(row: KnowledgeItemRow): KnowledgeItem {
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

function mapRowToKnowledgeItemVersion(row: KnowledgeItemVersionRow): KnowledgeItemVersion {
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

/**
 * In-memory implementation of `KnowledgeRepository` with identical RLS validation,
 * contentHash idempotency, append-only version snapshots, and tombstone + embedding cleanup semantics.
 */
export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly items = new Map<string, KnowledgeItem>();
  private readonly versions = new Map<string, KnowledgeItemVersion[]>();
  private readonly embeddingsCountByItem = new Map<string, number>();
  private readonly now: () => Date;

  constructor(options?: { now?: () => Date }) {
    this.now = options?.now ?? (() => new Date());
  }

  seedEmbeddingCountForItem(tenantId: string, projectId: string, itemId: string, count: number): void {
    this.embeddingsCountByItem.set(`${tenantId}:${projectId}:${itemId}`, count);
  }

  getEmbeddingCountForItem(tenantId: string, projectId: string, itemId: string): number {
    return this.embeddingsCountByItem.get(`${tenantId}:${projectId}:${itemId}`) ?? 0;
  }

  async upsertItem(
    context: RlsSessionContext,
    input: KnowledgeItem
  ): Promise<UpsertKnowledgeResult> {
    const { item, resolvedContext } = validateKnowledgeItemForRlsContext(input, context);
    const allowedPolicies = new Set(resolvedContext.allowedPoliciesCsv.split(","));
    const key = `${item.tenantId}:${item.projectId}:${item.id}`;
    const existing = this.items.get(key);
    const nowIso = resolveIsoTimestamp(this.now);

    if (existing) {
      if (!allowedPolicies.has(existing.accessPolicyId)) {
        throw new Error(
          `Existing KnowledgeItem '${existing.id}' is governed by policy '${existing.accessPolicyId}' which is not in allowedPolicies.`
        );
      }

      if (existing.contentHash === item.contentHash && existing.deletedAt === undefined) {
        return {
          item: structuredClone(existing),
          versionCreated: false
        };
      }

      const nextVersion = existing.version + 1;
      const updated: KnowledgeItem = {
        ...item,
        version: nextVersion,
        createdAt: existing.createdAt,
        updatedAt: nowIso
      };
      delete updated.deletedAt;

      this.items.set(key, structuredClone(updated));
      const list = this.versions.get(key) ?? [];
      list.push(toVersionSnapshot(updated, nowIso));
      this.versions.set(key, list);

      return {
        item: structuredClone(updated),
        versionCreated: true
      };
    }

    const initialVersion = Number.isInteger(item.version) && item.version >= 1 ? item.version : 1;
    const created: KnowledgeItem = {
      ...item,
      version: initialVersion,
      createdAt: item.createdAt || nowIso,
      updatedAt: nowIso
    };
    delete created.deletedAt;

    this.items.set(key, structuredClone(created));
    const list = this.versions.get(key) ?? [];
    list.push(toVersionSnapshot(created, nowIso));
    this.versions.set(key, list);

    return {
      item: structuredClone(created),
      versionCreated: true
    };
  }

  async getItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItem | undefined> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const existing = this.items.get(key);
    if (!existing || existing.deletedAt !== undefined) return undefined;
    if (!allowedPolicies.has(existing.accessPolicyId)) return undefined;
    return structuredClone(existing);
  }

  async listVersions(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItemVersion[]> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const list = this.versions.get(key) ?? [];
    return list
      .filter((v) => allowedPolicies.has(v.accessPolicyId))
      .sort((a, b) => a.version - b.version)
      .map((v) => structuredClone(v));
  }

  async softDeleteItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string,
    deletedAt?: string
  ): Promise<boolean> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const deletedIso = resolveIsoTimestamp(this.now, deletedAt);
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const existing = this.items.get(key);

    if (!existing || existing.deletedAt !== undefined) return false;
    if (!allowedPolicies.has(existing.accessPolicyId)) return false;

    existing.deletedAt = deletedIso;
    existing.updatedAt = deletedIso;
    this.embeddingsCountByItem.delete(key);
    return true;
  }

  async replaceItemEmbeddings(
    context: RlsSessionContext,
    input: ReplaceItemEmbeddingsInput
  ): Promise<number> {
    const { resolved, normalizedProjectId, allowedPolicies } = validateScopeAndProject(
      context,
      input.projectId
    );
    const normalizedItemId = validateToken(input.knowledgeItemId, "knowledgeItemId");
    const key = `${resolved.tenantId}:${normalizedProjectId}:${normalizedItemId}`;
    const existing = this.items.get(key);
    if (!existing || existing.deletedAt !== undefined) return 0;
    if (!allowedPolicies.has(existing.accessPolicyId)) return 0;

    this.embeddingsCountByItem.set(key, input.chunks.length);
    return input.chunks.length;
  }
}

/**
 * PostgreSQL implementation of `KnowledgeRepository` (`SqlKnowledgeRepository`).
 * Executes all reads and writes inside `AppPostgresClient.withRlsTransaction` (or `withRlsTransaction`),
 * validates tenant/project/policy before opening a transaction, enforces `content_hash` idempotency,
 * appends version snapshots to `knowledge_item_versions`, and tombstones items while deleting
 * `knowledge_embeddings` **visible under the caller's RLS scope** on `softDeleteItem`.
 *
 * Embedding-deletion limitation (deliberate, fail-closed): `brain_app` cannot see embedding rows
 * whose `access_policy_id` is outside the session's `allowedPolicies`, so `softDeleteItem` removes
 * only the visible subset and never claims complete erasure — no insecure bypass is attempted.
 * Complete cross-policy erasure for LGPD (normative decision 56: deletion + crypto-shredding)
 * must run through the dedicated `brain_system` erasure path, which is out of scope for this
 * application-role repository.
 */
export class PostgresKnowledgeRepository<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> implements KnowledgeRepository {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly now: () => Date;

  constructor(
    sqlOrOptions: KnowledgePostgresTarget<TTx> | PostgresKnowledgeRepositoryOptions<TTx>,
    maybeOptions?: { now?: () => Date }
  ) {
    let target: KnowledgePostgresTarget<TTx>;
    let now: (() => Date) | undefined;

    if (sqlOrOptions && typeof sqlOrOptions === "object" && "sql" in sqlOrOptions && !("begin" in sqlOrOptions) && !("withRlsTransaction" in sqlOrOptions)) {
      target = sqlOrOptions.sql;
      now = sqlOrOptions.now;
    } else {
      target = sqlOrOptions as KnowledgePostgresTarget<TTx>;
      now = maybeOptions?.now;
    }

    if (!target || typeof target !== "object") {
      throw new Error("PostgresKnowledgeRepository requires an AppPostgresClient or RlsSqlClient.");
    }

    if ("withRlsTransaction" in target && typeof target.withRlsTransaction === "function") {
      if ("role" in target && target.role !== "brain_app") {
        throw new Error(
          `PostgresKnowledgeRepository requires an AppPostgresClient bound to role 'brain_app' (received '${String(target.role)}').`
        );
      }
      const appClient = target;
      this.runInRlsTransaction = (ctx, cb) => appClient.withRlsTransaction(ctx, cb);
    } else if ("begin" in target && typeof target.begin === "function") {
      const sqlClient = target as KnowledgeSqlClient<TTx>;
      this.runInRlsTransaction = (ctx, cb) => withRlsTransaction(sqlClient, ctx, cb);
    } else {
      throw new Error(
        "PostgresKnowledgeRepository requires an AppPostgresClient (withRlsTransaction) or RlsSqlClient (begin)."
      );
    }

    this.now = now ?? (() => new Date());
  }

  async upsertItem(
    context: RlsSessionContext,
    input: KnowledgeItem
  ): Promise<UpsertKnowledgeResult> {
    const { item } = validateKnowledgeItemForRlsContext(input, context);
    const nowIso = resolveIsoTimestamp(this.now);
    const validUntilParam: string | null = item.validUntil ?? null;
    const summaryParam: string | null = item.summary ?? null;
    const ownerIdParam: string | null = item.ownerId ?? null;
    const metadataJson = JSON.stringify(item.metadata ?? {});

    return this.runInRlsTransaction(context, async (tx) => {
      // A pre-existing row hidden by RLS (policy outside allowedPolicies) makes the
      // SELECT return empty while the PK still exists. INSERT ... ON CONFLICT DO NOTHING
      // surfaces that conflict without aborting the transaction; the re-read then either
      // finds the row (concurrent insert or policy change made it visible) or fails
      // closed with a semantic error instead of a raw 23505.
      let existingRows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${item.tenantId}
        AND project_id = ${item.projectId}
        AND id = ${item.id}
      FOR UPDATE`;

      const appendSyncChange = async () => {
        await tx`INSERT INTO sync_project_locks (tenant_id, project_id)
          VALUES (${item.tenantId}, ${item.projectId})
          ON CONFLICT (tenant_id, project_id) DO UPDATE SET locked_at = now()`;
        await tx`INSERT INTO sync_changes (
          tenant_id, project_id, item_id, content_hash, access_policy_id
        ) VALUES (
          ${item.tenantId}, ${item.projectId}, ${item.id}, ${item.contentHash}, ${item.accessPolicyId}
        )`;
      };

      if (!existingRows[0]) {
        const initialVersion = Number.isInteger(item.version) && item.version >= 1 ? item.version : 1;
        const createdAtIso = item.createdAt || nowIso;
        const validFromIso = item.validFrom ?? nowIso;

        const insertedRows = await tx<KnowledgeItemRow>`INSERT INTO knowledge_items (
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      ) VALUES (
        ${item.id},
        ${item.tenantId},
        ${item.projectId},
        ${item.domainId},
        ${item.type},
        ${item.title},
        ${item.content},
        ${summaryParam},
        ${item.status},
        ${item.sourceId},
        ${item.sourceOrigin},
        ${item.sourceKind},
        ${item.sourceVersion},
        ${item.sourceUri},
        ${initialVersion},
        ${item.contentHash},
        ${ownerIdParam},
        ${item.confidence},
        ${item.trustLevel},
        ${item.isInferred},
        ${validFromIso}::timestamptz,
        ${validUntilParam}::timestamptz,
        ${item.tags},
        ${item.accessPolicyId},
        ${metadataJson}::jsonb,
        NULL,
        ${createdAtIso}::timestamptz,
        ${nowIso}::timestamptz
      )
      ON CONFLICT (tenant_id, project_id, id) DO NOTHING
      RETURNING
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at`;

        const insertedRow = insertedRows[0];
        if (insertedRow) {
          await tx`INSERT INTO knowledge_item_versions (
          tenant_id, project_id, item_id, version, domain_id, type, title, summary,
          status, source_origin, source_kind, source_version, content_hash, owner_id,
          confidence, trust_level, is_inferred, tags, access_policy_id, content,
          metadata, created_at
        ) VALUES (
          ${item.tenantId},
          ${item.projectId},
          ${item.id},
          ${initialVersion},
          ${item.domainId},
          ${item.type},
          ${item.title},
          ${summaryParam},
          ${item.status},
          ${item.sourceOrigin},
          ${item.sourceKind},
          ${item.sourceVersion},
          ${item.contentHash},
          ${ownerIdParam},
          ${item.confidence},
          ${item.trustLevel},
          ${item.isInferred},
          ${item.tags},
          ${item.accessPolicyId},
          ${item.content},
          ${metadataJson}::jsonb,
          ${nowIso}::timestamptz
        )`;

          await appendSyncChange();

          return {
            item: mapRowToKnowledgeItem(insertedRow),
            versionCreated: true
          };
        }

        // Conflict with a row the first SELECT could not see: re-read inside the same
        // transaction. A row now visible means a concurrent insert or a policy change;
        // still invisible means the item exists under a policy this session may not
        // touch — fail closed with a semantic error, never a raw unique violation.
        existingRows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${item.tenantId}
        AND project_id = ${item.projectId}
        AND id = ${item.id}
      FOR UPDATE`;

        if (!existingRows[0]) {
          throw new Error(
            `KnowledgeItem '${item.id}' already exists in project '${item.projectId}' but is not visible or authorized in the current RLS context; upsert refused (fail-closed).`
          );
        }
      }

      const existing = existingRows[0];
      const isDeleted = existing.deleted_at !== null && existing.deleted_at !== undefined;
      if (
        !isDeleted &&
        existing.content_hash === item.contentHash &&
        existing.status === item.status &&
        Boolean(existing.is_inferred) === Boolean(item.isInferred)
      ) {
        return {
          item: mapRowToKnowledgeItem(existing),
          versionCreated: false
        };
      }

      // Never overwrite the original valid_from with "now" when the caller did not
      // supply one: preserve the stored value (schema guarantees NOT NULL on update).
      const validFromIso = item.validFrom ?? parseOptionalIso(existing.valid_from) ?? nowIso;
      const nextVersion = Number(existing.version) + 1;
      const updatedRows = await tx<KnowledgeItemRow>`UPDATE knowledge_items
        SET
          domain_id = ${item.domainId},
          type = ${item.type},
          title = ${item.title},
          content = ${item.content},
          summary = ${summaryParam},
          status = ${item.status},
          source_id = ${item.sourceId},
          source_origin = ${item.sourceOrigin},
          source_kind = ${item.sourceKind},
          source_version = ${item.sourceVersion},
          source_uri = ${item.sourceUri},
          version = ${nextVersion},
          content_hash = ${item.contentHash},
          owner_id = ${ownerIdParam},
          confidence = ${item.confidence},
          trust_level = ${item.trustLevel},
          is_inferred = ${item.isInferred},
          valid_from = ${validFromIso}::timestamptz,
          valid_until = ${validUntilParam}::timestamptz,
          tags = ${item.tags},
          access_policy_id = ${item.accessPolicyId},
          metadata = ${metadataJson}::jsonb,
          deleted_at = NULL,
          updated_at = ${nowIso}::timestamptz
        WHERE tenant_id = ${item.tenantId}
          AND project_id = ${item.projectId}
          AND id = ${item.id}
        RETURNING
          id, tenant_id, project_id, domain_id, type, title, content, summary, status,
          source_id, source_origin, source_kind, source_version, source_uri, version,
          content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
          valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at`;

      const updatedRow = updatedRows[0];
      if (!updatedRow) {
        throw new Error(
          `UPDATE on knowledge_items for '${item.id}' returned no row; refusing to fabricate success (possible RLS divergence between SELECT and UPDATE).`
        );
      }

      await tx`INSERT INTO knowledge_item_versions (
          tenant_id, project_id, item_id, version, domain_id, type, title, summary,
          status, source_origin, source_kind, source_version, content_hash, owner_id,
          confidence, trust_level, is_inferred, tags, access_policy_id, content,
          metadata, created_at
        ) VALUES (
          ${item.tenantId},
          ${item.projectId},
          ${item.id},
          ${nextVersion},
          ${item.domainId},
          ${item.type},
          ${item.title},
          ${summaryParam},
          ${item.status},
          ${item.sourceOrigin},
          ${item.sourceKind},
          ${item.sourceVersion},
          ${item.contentHash},
          ${ownerIdParam},
          ${item.confidence},
          ${item.trustLevel},
          ${item.isInferred},
          ${item.tags},
          ${item.accessPolicyId},
          ${item.content},
          ${metadataJson}::jsonb,
          ${nowIso}::timestamptz
        )`;

      await appendSyncChange();

      return {
        item: mapRowToKnowledgeItem(updatedRow),
        versionCreated: true
      };
    });
  }

  async getItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItem | undefined> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");

    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND id = ${normalizedItemId}
        AND deleted_at IS NULL`;

      const row = rows[0];
      if (!row) return undefined;
      return mapRowToKnowledgeItem(row);
    });
  }

  async listSyncSnapshot(
    context: RlsSessionContext,
    projectId: string,
    afterId?: string,
    limit = 100
  ): Promise<KnowledgeItem[]> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedAfterId = afterId === undefined ? null : validateToken(afterId, "afterId");
    const boundedLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<KnowledgeItemRow>`SELECT
        id, tenant_id, project_id, domain_id, type, title, content, summary, status,
        source_id, source_origin, source_kind, source_version, source_uri, version,
        content_hash, owner_id, confidence, trust_level, is_inferred, valid_from,
        valid_until, tags, access_policy_id, metadata, deleted_at, created_at, updated_at
      FROM knowledge_items
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND deleted_at IS NULL
        AND (${normalizedAfterId}::text IS NULL OR id > ${normalizedAfterId ?? ""})
      ORDER BY id ASC
      LIMIT ${boundedLimit}`;
      return rows.map(mapRowToKnowledgeItem);
    });
  }

  async listVersions(
    context: RlsSessionContext,
    projectId: string,
    itemId: string
  ): Promise<KnowledgeItemVersion[]> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");

    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<KnowledgeItemVersionRow>`SELECT
        tenant_id, project_id, item_id, version, domain_id, type, title, summary,
        status, source_origin, source_kind, source_version, content_hash, owner_id,
        confidence, trust_level, is_inferred, tags, access_policy_id, content,
        metadata, created_at
      FROM knowledge_item_versions
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND item_id = ${normalizedItemId}
      ORDER BY version ASC`;

      return rows.map(mapRowToKnowledgeItemVersion);
    });
  }

  async incrementHitCounts(
    context: RlsSessionContext,
    projectId: string,
    itemIds: readonly string[]
  ): Promise<Array<{ itemId: string; hitCount: number }>> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const uniqueIds = [...new Set(itemIds.map((id) => validateToken(id, "itemId")))];
    if (uniqueIds.length === 0) return [];

    return this.runInRlsTransaction(context, async (tx) => {
      const rows = await tx<{ item_id: string; hit_count: number | string }>`UPDATE knowledge_items
        SET hit_count = hit_count + 1
        WHERE tenant_id = ${resolved.tenantId}
          AND project_id = ${normalizedProjectId}
          AND id = ANY(${uniqueIds}::text[])
          AND deleted_at IS NULL
        RETURNING id AS item_id, hit_count`;
      if (rows.length !== uniqueIds.length) {
        throw new Error("One or more feedback items are missing or outside the authorized scope.");
      }
      return rows.map((row) => ({ itemId: row.item_id, hitCount: Number(row.hit_count) }));
    });
  }

  async softDeleteItem(
    context: RlsSessionContext,
    projectId: string,
    itemId: string,
    deletedAt?: string
  ): Promise<boolean> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, projectId);
    const normalizedItemId = validateToken(itemId, "itemId");
    const deletedIso = resolveIsoTimestamp(this.now, deletedAt);

    return this.runInRlsTransaction(context, async (tx) => {
      const updated = await tx<{ id: string }>`UPDATE knowledge_items
      SET
        deleted_at = ${deletedIso}::timestamptz,
        updated_at = ${deletedIso}::timestamptz
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND id = ${normalizedItemId}
        AND deleted_at IS NULL
      RETURNING id`;

      if (updated.length === 0) {
        return false;
      }

      await tx`DELETE FROM knowledge_embeddings
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND knowledge_item_id = ${normalizedItemId}`;

      return true;
    });
  }

  async replaceItemEmbeddings(
    context: RlsSessionContext,
    input: ReplaceItemEmbeddingsInput
  ): Promise<number> {
    const { resolved, normalizedProjectId } = validateScopeAndProject(context, input.projectId);
    const normalizedItemId = validateToken(input.knowledgeItemId, "knowledgeItemId");
    const model = input.embeddingModel ?? "bge-m3";

    return this.runInRlsTransaction(context, async (tx) => {
      await tx`DELETE FROM knowledge_embeddings
      WHERE tenant_id = ${resolved.tenantId}
        AND project_id = ${normalizedProjectId}
        AND knowledge_item_id = ${normalizedItemId}`;

      for (const chunk of input.chunks) {
        const vectorLiteral = `[${chunk.embedding.join(",")}]`;
        await tx`INSERT INTO knowledge_embeddings (
          tenant_id, project_id, knowledge_item_id, source_version,
          chunk_index, chunk_text, access_policy_id, embedding_model, embedding
        ) VALUES (
          ${resolved.tenantId}, ${normalizedProjectId}, ${normalizedItemId}, ${input.sourceVersion},
          ${chunk.chunkIndex}, ${chunk.chunkText}, ${input.accessPolicyId}, ${model}, ${vectorLiteral}::vector
        )`;
      }

      return input.chunks.length;
    });
  }
}

export { PostgresKnowledgeRepository as SqlKnowledgeRepository };

export function createPostgresKnowledgeRepository<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
>(
  sqlOrOptions: KnowledgePostgresTarget<TTx> | PostgresKnowledgeRepositoryOptions<TTx>,
  maybeOptions?: { now?: () => Date }
): PostgresKnowledgeRepository<TTx> {
  return new PostgresKnowledgeRepository(sqlOrOptions, maybeOptions);
}

export type SystemKnowledgeSqlClient<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
> =
  | (TTx & { readonly role?: "brain_system" | string })
  | {
      readonly role?: "brain_system" | string;
      begin<T>(callback: (tx: TTx) => Promise<T> | T): Promise<T>;
    };

export interface PrivacyEraseSubjectInput {
  tenantId: string;
  subjectId: string;
  projectId?: string;
}

export interface PrivacyEraseSubjectResult {
  tenantId: string;
  subjectId: string;
  deletedItems: number;
  deletedItemIds: string[];
  deletedVersions: number;
  deletedEmbeddings: number;
  deletedRelations: number;
  createdSyncTombstones: number;
  deletedMemories: number;
  deletedHandoffs: number;
  deletedRunnerQuestions: number;
  deletedRunnerTasks: number;
  deletedTaskLeases: number;
}

/**
 * Deletes matching knowledge rows and their historical, embedding, and graph records
 * within the same tenant transaction. Requires a dedicated brain_system client.
 */
export async function privacyEraseSubject<
  TTx extends KnowledgeSqlTransactionRunner = KnowledgeSqlTransactionRunner
>(
  systemSqlClient: SystemKnowledgeSqlClient<TTx>,
  input: PrivacyEraseSubjectInput
): Promise<PrivacyEraseSubjectResult> {
  if (!systemSqlClient || (typeof systemSqlClient !== "object" && typeof systemSqlClient !== "function")) {
    throw new Error("privacyEraseSubject requires a system SQL client.");
  }
  if ("role" in systemSqlClient && systemSqlClient.role !== undefined && systemSqlClient.role !== "brain_system") {
    throw new Error(
      `privacyEraseSubject requires a 'brain_system' SQL client (received '${String(systemSqlClient.role)}').`
    );
  }

  const normalizedTenantId = validateToken(input.tenantId, "tenantId");
  const normalizedSubjectId = validateToken(input.subjectId, "subjectId");
  const normalizedProjectId =
    input.projectId !== undefined ? validateToken(input.projectId, "projectId") : undefined;

  const runErase = async (tx: TTx): Promise<PrivacyEraseSubjectResult> => {
    const candidates = normalizedProjectId
      ? await tx<{ id: string; project_id: string; content_hash: string; access_policy_id: string }>`
          SELECT id, project_id, content_hash, access_policy_id FROM knowledge_items
          WHERE tenant_id = ${normalizedTenantId}
            AND project_id = ${normalizedProjectId}
            AND (owner_id = ${normalizedSubjectId} OR ${normalizedSubjectId} = ANY(tags))
          FOR UPDATE
        `
      : await tx<{ id: string; project_id: string; content_hash: string; access_policy_id: string }>`
          SELECT id, project_id, content_hash, access_policy_id FROM knowledge_items
          WHERE tenant_id = ${normalizedTenantId}
            AND (owner_id = ${normalizedSubjectId} OR ${normalizedSubjectId} = ANY(tags))
          FOR UPDATE
        `;

    const byProject = new Map<string, string[]>();
    for (const row of candidates) {
      const ids = byProject.get(row.project_id) ?? [];
      ids.push(row.id);
      byProject.set(row.project_id, ids);
    }
    const deletedItemIds: string[] = [];
    let deletedVersions = 0;
    let deletedEmbeddings = 0;
    let deletedRelations = 0;
    let createdSyncTombstones = 0;
    for (const [projectId, itemIds] of byProject) {
      await tx`INSERT INTO sync_project_locks (tenant_id, project_id)
        VALUES (${normalizedTenantId}, ${projectId})
        ON CONFLICT (tenant_id, project_id) DO UPDATE SET locked_at = now()`;
      const embeddings = await tx<{ knowledge_item_id: string }>`
        DELETE FROM knowledge_embeddings
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND knowledge_item_id = ANY(${itemIds}::text[])
        RETURNING knowledge_item_id
      `;
      deletedEmbeddings += embeddings.length;
      const versions = await tx<{ item_id: string }>`
        DELETE FROM knowledge_item_versions
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND item_id = ANY(${itemIds}::text[])
        RETURNING item_id
      `;
      deletedVersions += versions.length;
      const relations = await tx<{ id: string }>`
        DELETE FROM knowledge_relations
        WHERE tenant_id = ${normalizedTenantId}
          AND ((from_project_id = ${projectId} AND from_item_id = ANY(${itemIds}::text[]))
            OR (to_project_id = ${projectId} AND to_item_id = ANY(${itemIds}::text[])))
        RETURNING id
      `;
      deletedRelations += relations.length;
      const tombstones = await tx<{ sync_seq: number }>`
        INSERT INTO sync_changes (tenant_id, project_id, item_id, content_hash, access_policy_id, deleted_at)
        SELECT tenant_id, project_id, id, content_hash, access_policy_id, now()
        FROM knowledge_items
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND id = ANY(${itemIds}::text[])
        RETURNING sync_seq
      `;
      createdSyncTombstones += tombstones.length;
      const deleted = await tx<{ id: string }>`
        DELETE FROM knowledge_items
        WHERE tenant_id = ${normalizedTenantId} AND project_id = ${projectId}
          AND id = ANY(${itemIds}::text[])
        RETURNING id
      `;
      deletedItemIds.push(...deleted.map((row) => row.id));
    }

    const memories = await tx<{ id: string }>`
      DELETE FROM memory_entries WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND actor_id = ${normalizedSubjectId}
      RETURNING id
    `;
    const handoffRows = await tx<{ task_id: string }>`
      DELETE FROM handoffs WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND actor_id = ${normalizedSubjectId}
      RETURNING task_id
    `;
    const tasks = await tx<{ task_id: string }>`
      DELETE FROM runner_tasks WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND actor_id = ${normalizedSubjectId}
      RETURNING task_id
    `;
    const taskIds = tasks.map((row) => row.task_id);
    let deletedRunnerQuestions = 0;
    let deletedTaskLeases = 0;
    if (taskIds.length > 0) {
      const questions = await tx<{ question_id: string }>`
        DELETE FROM runner_task_questions WHERE tenant_id = ${normalizedTenantId}
          AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND task_id = ANY(${taskIds}::text[])
        RETURNING question_id
      `;
      deletedRunnerQuestions = questions.length;
      const leases = await tx<{ task_id: string }>`
        DELETE FROM task_leases WHERE tenant_id = ${normalizedTenantId}
          AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND task_id = ANY(${taskIds}::text[])
        RETURNING task_id
      `;
      deletedTaskLeases = leases.length;
    }
    // Handoffs can exist independently of runner_tasks; remove leases by their task IDs too.
    const handoffTaskIds = handoffRows.map((row) => row.task_id);
    const orphanHandoffLeases = handoffTaskIds.length ? await tx<{ task_id: string }>`
      DELETE FROM task_leases WHERE tenant_id = ${normalizedTenantId}
        AND project_id = COALESCE(${normalizedProjectId ?? null}, project_id) AND task_id = ANY(${handoffTaskIds}::text[])
      RETURNING task_id
    ` : [];
    deletedTaskLeases += orphanHandoffLeases.length;

    return {
      tenantId: normalizedTenantId,
      subjectId: normalizedSubjectId,
      deletedItems: deletedItemIds.length,
      deletedItemIds,
      deletedVersions,
      deletedEmbeddings,
      deletedRelations,
      createdSyncTombstones,
      deletedMemories: memories.length,
      deletedHandoffs: handoffRows.length,
      deletedRunnerQuestions,
      deletedRunnerTasks: tasks.length,
      deletedTaskLeases
    };
  };

  if ("begin" in systemSqlClient && typeof systemSqlClient.begin === "function") {
    return systemSqlClient.begin(runErase);
  }

  return runErase(systemSqlClient as TTx);
}
