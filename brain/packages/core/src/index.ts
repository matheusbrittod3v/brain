/**
 * Contratos puros de domínio do Brain (Project Brain OS 2.0).
 * Camada 0: zero dependências internas ou de infraestrutura.
 */

export type KnowledgeStatus = "draft" | "approved" | "deprecated" | "superseded";

export type TrustLevel = "verified" | "self_authored" | "untrusted";

export type ContextSessionEvidence = "read" | "citation" | "edit";

export interface ContextSessionItemInput {
  itemId: string;
  accessPolicyId: string;
  sourceUri: string;
  sourceHash?: string;
  taskId?: string;
}

export interface ContextSessionHitRate {
  sessionId: string;
  hits: number;
  itemsSent: number;
  rate: number;
}

export function validateContextSessionId(value: unknown): string {
  if (typeof value !== "string") throw new Error("sessionId must be a string.");
  const sessionId = value.trim();
  if (sessionId.length < 1 || sessionId.length > 128 || /[\u0000-\u001f\u007f]/.test(sessionId)) {
    throw new Error("sessionId must contain 1–128 visible characters.");
  }
  return sessionId;
}

export type KnowledgeType =
  | "business_rule"
  | "requirement"
  | "feature"
  | "architecture_decision"
  | "code_symbol"
  | "test"
  | "service"
  | "api_contract"
  | "event_contract"
  | "task"
  | "process"
  | "integration"
  | "risk"
  | "memory"
  | "document"
  | "skill"
  | "spec"
  // Novos tipos de conhecimento
  | "glossary_term"
  | "product_capability"
  | "data_model"
  | "use_case"
  | "journey"
  | "risk_control"
  | "slo_target"
  | "runbook"
  | "incident_postmortem"
  | "pending_decision"
  // Novos tipos de conhecimento do dia a dia
  | "implementation_pattern"
  | "limit_constraint"
  | "role_responsibility"
  | "compatibility_matrix"
  | "code_vocabulary"
  | "experiment_record"
  | "known_exception"
  | "mock_data_sample"
  | "external_dependency"
  | "acceptance_criteria";

export interface KnowledgeProvenance {
  origin: "git" | "manual" | "agent" | "connector" | "import";
  author: string;
  sourceUri?: string;
  sourceVersion?: string;
  confidence: number;
  lastValidatedAt: string;
  validator?: string;
  validationStatus: "valid" | "stale" | "pending_review";
}

export type BrainErrorCode =
  | "BRAIN_ERR_UNAUTHORIZED"
  | "BRAIN_ERR_NOT_FOUND"
  | "BRAIN_ERR_CONFLICT"
  | "BRAIN_ERR_POLICY_DENIED"
  | "BRAIN_ERR_RATE_LIMITED"
  | "BRAIN_ERR_STORAGE_UNAVAILABLE"
  | "BRAIN_ERR_INVALID_INPUT";

export interface KnowledgeItem {
  id: string;
  tenantId: string;
  projectId: string;
  domainId: number;
  type: KnowledgeType;
  title: string;
  content: string;
  summary?: string;
  status: KnowledgeStatus;
  sourceId: string;
  sourceOrigin: "internal" | "external_reference";
  sourceKind: "git" | "api" | "connector" | "agent";
  sourceVersion: string;
  sourceUri: string;
  version: number;
  contentHash: string;
  ownerId?: string;
  confidence: number;
  trustLevel: TrustLevel;
  isInferred: boolean;
  validFrom?: string;
  validUntil?: string;
  tags: string[];
  relatedIds: string[];
  accessPolicyId: string;
  metadata?: Record<string, unknown>;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class BrainError extends Error {
  constructor(
    public readonly code: BrainErrorCode,
    message: string,
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = "BrainError";
  }
}

export interface CursorPage<T> {
  items: T[];
  nextCursor?: string;
}

export function paginateCursor<T>(allItems: readonly T[], limit = 20, cursor?: string): CursorPage<T> {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const offset = cursor ? Math.max(0, Number.parseInt(Buffer.from(cursor, "base64url").toString("utf8"), 10) || 0) : 0;
  const slice = allItems.slice(offset, offset + safeLimit);
  const nextOffset = offset + slice.length;
  return {
    items: slice,
    ...(nextOffset < allItems.length ? { nextCursor: Buffer.from(String(nextOffset), "utf8").toString("base64url") } : {})
  };
}

