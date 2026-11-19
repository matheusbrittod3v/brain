import type { KnowledgeItem, KnowledgeStatus, KnowledgeType, TrustLevel } from "@brain/core";
import {
  resolveRlsSessionContext,
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

export const EXPECTED_EMBEDDING_DIMENSIONS = 1024;
const INVALID_SCOPE_CHARS = /[,\0\r\n]/;

export function validateToken(raw: unknown, fieldName: string): string {
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

export function validateScopeAndProject(
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

