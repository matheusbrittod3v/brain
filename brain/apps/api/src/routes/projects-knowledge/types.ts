import type { BrainRunnerQueue } from "@brain/agent-runner";
import type { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import type { AppPostgresClient, AuditLogger } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import type { KnowledgeItem } from "@brain/core";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import type { PgAuthRepository, PgOperationalRepository } from "@brain/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import type { PostgresKnowledgeRepository } from "@brain/knowledge";
import type { HybridRetrievalEngine, PostgresRetrievalEngine } from "@brain/retrieval";

export interface ProjectsKnowledgeDeps {
  authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
  enforceOpa: (
    ctx: AuthContext,
    resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
  ) => Promise<void>;
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
  queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; domains?: number[]; atDate?: string; limit: number }) => Promise<Array<{ item: KnowledgeItem; score: number }>> };
  projectVerifiedTests: (ctx: AuthContext, projectId: string, items: KnowledgeItem[]) => Promise<any>;
  projectHealth: (items: KnowledgeItem[], verifiedTests: Map<string, string[]>, linkedTestsByRule?: Map<string, string[]>) => any;
  configuredApiKey: string;
  allowedProjects: readonly string[];
  allowedPolicies: readonly string[];
  registeredProjects: Map<string, { projectId: string; tenantId: string; name: string; description?: string; knowledgeRoot: string; createdAt: string }>;
  opRepo?: PgOperationalRepository;
  authRepo?: PgAuthRepository;
  appPostgresClient?: AppPostgresClient;
  pgRetrieval?: PostgresRetrievalEngine;
  retrieval: HybridRetrievalEngine;
  pgKnowledge?: PostgresKnowledgeRepository;
  pgGraph?: PostgresGraphStore;
  graph: KnowledgeGraphStore;
  pgApprovals?: PostgresApprovalQueue;
  approvals: ApprovalQueue;
  runner: BrainRunnerQueue;
  pgCrossService?: PostgresCrossServiceRegistry;
  crossService: CrossServiceContractRegistry;
}

