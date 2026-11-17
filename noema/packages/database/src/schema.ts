import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  smallint,
  integer,
  serial,
  real,
  boolean,
  timestamp,
  date,
  jsonb,
  uuid,
  customType,
  primaryKey,
  index,
  unique,
  uniqueIndex,
  foreignKey,
  vector
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => organizations.id),
  name: text("name").notNull(),
  description: text("description"),
  knowledgeRoot: text("knowledge_root").default(".brain/").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const knowledgeItems = pgTable(
  "knowledge_items",
  {
    id: text("id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => organizations.id),
    projectId: text("project_id").notNull(),
    domainId: smallint("domain_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    summary: text("summary"),
    status: text("status").notNull(),
    sourceId: text("source_id").notNull(),
    sourceOrigin: text("source_origin").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceUri: text("source_uri").notNull(),
    version: integer("version").default(1).notNull(),
    contentHash: text("content_hash").notNull(),
    ownerId: text("owner_id"),
    confidence: real("confidence").default(1.0).notNull(),
    trustLevel: text("trust_level").default("verified").notNull(),
    isInferred: boolean("is_inferred").default(false).notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    tags: text("tags").array().default([]).notNull(),
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(id, '') || ' ' || coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(content, '')) || array_to_tsvector(tags)`
    ),
    accessPolicyId: text("access_policy_id").notNull(),
    hitCount: integer("hit_count").default(0).notNull(),
    contextSentCount: integer("context_sent_count").default(0).notNull(),
    contextHitCount: integer("context_hit_count").default(0).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.id] }),
    index("idx_ki_search").using("gin", t.searchVector)
  ]
);

export const knowledgeItemVersions = pgTable(
  "knowledge_item_versions",
  {
    tenantId: text("tenant_id").notNull(),
    projectId: text("project_id").notNull(),
    itemId: text("item_id").notNull(),
    version: integer("version").notNull(),
    domainId: smallint("domain_id").notNull(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    status: text("status").notNull(),
    sourceOrigin: text("source_origin").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceVersion: text("source_version").notNull(),
    contentHash: text("content_hash").notNull(),
    ownerId: text("owner_id"),
    confidence: real("confidence").notNull(),
    trustLevel: text("trust_level").notNull(),
    isInferred: boolean("is_inferred").notNull(),
    tags: text("tags").array().default([]).notNull(),
    accessPolicyId: text("access_policy_id").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.itemId, t.version] })]
);

export const knowledgeEmbeddings = pgTable(
  "knowledge_embeddings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tenantId: text("tenant_id").notNull(),
    projectId: text("project_id").notNull(),
    knowledgeItemId: text("knowledge_item_id").notNull(),
    sourceVersion: text("source_version").notNull(),
    chunkIndex: integer("chunk_index").notNull(),
    chunkText: text("chunk_text").notNull(),
    accessPolicyId: text("access_policy_id").notNull(),
    embeddingModel: text("embedding_model").default("bge-m3").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (t) => [
    uniqueIndex("ke_item_version_chunk_model_unique").on(
      t.tenantId, t.projectId, t.knowledgeItemId, t.sourceVersion, t.chunkIndex, t.embeddingModel
    ),
    foreignKey({
      columns: [t.tenantId, t.projectId, t.knowledgeItemId],
      foreignColumns: [knowledgeItems.tenantId, knowledgeItems.projectId, knowledgeItems.id],
      name: "ke_item_fk"
    }).onDelete("cascade")
  ]
);

export const knowledgeRelations = pgTable("knowledge_relations", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  fromProjectId: text("from_project_id").notNull(),
  toProjectId: text("to_project_id").notNull(),
  fromItemId: text("from_item_id").notNull(),
  toItemId: text("to_item_id").notNull(),
  fromPolicyId: text("from_policy_id").notNull(),
  toPolicyId: text("to_policy_id").notNull(),
  relationType: text("relation_type").notNull(),
  isInferred: boolean("is_inferred").default(false).notNull(),
  confidence: real("confidence").default(1.0).notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).defaultNow().notNull(),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  evidenceUri: text("evidence_uri"),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [unique("knowledge_relations_identity_uq").on(
  t.tenantId, t.fromProjectId, t.toProjectId, t.fromItemId, t.toItemId, t.relationType
)]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id"),
  actorId: text("actor_id").notNull(),
  actorType: text("actor_type").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  metadata: jsonb("metadata").default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const integrationEvents = pgTable(
  "integration_events",
  {
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    projectId: text("project_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    accessPolicyId: text("access_policy_id").notNull(),
    eventHash: text("event_hash").notNull(),
    status: text("status").default("processing").notNull(),
    response: jsonb("response"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.provider, t.externalEventId] })]
);

export const handoffs = pgTable("handoffs", {
  handoffId: text("handoff_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  taskId: text("task_id").notNull(),
  actorId: text("actor_id"),
  fromAgent: text("from_agent").notNull(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull(),
  baseCommitSha: text("base_commit_sha").notNull(),
  workingTreeDirty: boolean("working_tree_dirty").default(false).notNull(),
  ephemeralBranch: text("ephemeral_branch"),
  modifiedFiles: text("modified_files").array().default([]).notNull(),
  testsExecuted: text("tests_executed").array().default([]).notNull(),
  decisions: text("decisions").array().default([]).notNull(),
  nextSteps: text("next_steps").array().default([]).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [index("idx_handoffs_subject").on(t.tenantId, t.projectId, t.actorId)]);

export const taskLeases = pgTable(
  "task_leases",
  {
    tenantId: text("tenant_id").notNull(),
    projectId: text("project_id").notNull(),
    taskId: text("task_id").notNull(),
    actorId: text("actor_id").notNull(),
    branch: text("branch").notNull(),
    targetFiles: text("target_files").array().default([]).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.taskId] })]
);

export const runnerTasks = pgTable("runner_tasks", {
  taskId: text("task_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  actorId: text("actor_id"),
  instruction: text("instruction").notNull(),
  priority: text("priority").default("normal").notNull(),
  draftOnly: boolean("draft_only").default(true).notNull(),
  maxSteps: integer("max_steps").default(10).notNull(),
  timeoutSeconds: integer("timeout_seconds").default(120).notNull(),
  status: text("status").default("queued").notNull(),
  resultSummary: text("result_summary"),
  resultMetadata: jsonb("result_metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [index("idx_runner_tasks_subject").on(t.tenantId, t.projectId, t.actorId)]);

export const runnerTokenUsageDaily = pgTable("runner_token_usage_daily", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  usageDate: date("usage_date", { mode: "string" }).notNull(),
  usedTokens: integer("used_tokens").default(0).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.usageDate] })]);

export const runnerTaskQuestions = pgTable(
  "runner_task_questions",
  {
    questionId: text("question_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    projectId: text("project_id").notNull(),
    taskId: text("task_id").notNull(),
    accessPolicyId: text("access_policy_id").notNull(),
    question: text("question").notNull(),
    status: text("status").default("pending").notNull(),
    response: text("response"),
    responseIdempotencyKey: text("response_idempotency_key"),
    answeredBy: text("answered_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true })
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.projectId, t.questionId] }),
    index("idx_rtq_task_status").on(t.tenantId, t.projectId, t.taskId, t.status)
  ]
);

export const testExecutionResults = pgTable("test_execution_results", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  repository: text("repository"),
  accessPolicyId: text("access_policy_id").notNull(),
  provider: text("provider").notNull(),
  runId: text("run_id").notNull(),
  testItemId: text("test_item_id").notNull(),
  commitSha: text("commit_sha").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
  receivedBy: text("received_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  unique("test_execution_results_identity_uq").on(t.tenantId, t.projectId, t.provider, t.runId, t.testItemId),
  index("idx_test_execution_results_latest").on(t.tenantId, t.projectId, t.testItemId, t.executedAt)
]);

export const projectRepositoryHeads = pgTable("project_repository_heads", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  repository: text("repository").notNull(),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.repository, t.branch] })]);

export const gitIngestionHeads = pgTable("git_ingestion_heads", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  repository: text("repository").notNull(),
  branch: text("branch").notNull(),
  commitSha: text("commit_sha").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.repository, t.branch] })]);

export const syncChanges = pgTable("sync_changes", {
  syncSeq: serial("sync_seq").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  itemId: text("item_id").notNull(),
  contentHash: text("content_hash").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const syncProjectLocks = pgTable("sync_project_locks", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId] })]);

export const policyEpochStates = pgTable("policy_epoch_states", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  actorId: text("actor_id").notNull(),
  epoch: integer("epoch").default(1).notNull(),
  revocationFingerprint: text("revocation_fingerprint"),
  allowedPolicyFingerprint: text("allowed_policy_fingerprint"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.actorId] })]);

export const memoryEntries = pgTable("memory_entries", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  actorId: text("actor_id"),
  layer: text("layer").notNull(), // working | episodic | semantic | procedural | organizational
  sessionId: text("session_id"),
  content: text("content").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  hitCount: integer("hit_count").default(0).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [index("idx_memory_entries_subject").on(t.tenantId, t.projectId, t.actorId)]);

export const contextSessionItems = pgTable("context_session_items", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  actorId: text("actor_id").notNull(),
  sessionId: text("session_id").notNull(),
  itemId: text("item_id").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  sourceUri: text("source_uri").notNull(),
  sourceHash: text("source_hash"),
  taskId: text("task_id"),
  hitEvidence: text("hit_evidence").array().default([]).notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
  hitAt: timestamp("hit_at", { withTimezone: true })
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.projectId, t.actorId, t.sessionId, t.itemId] }),
  index("idx_context_session_items_subject").on(t.tenantId, t.projectId, t.actorId, t.sessionId),
  index("idx_context_session_items_path").on(t.tenantId, t.projectId, t.actorId, t.sessionId, t.sourceUri),
  foreignKey({ columns: [t.tenantId, t.projectId, t.itemId], foreignColumns: [knowledgeItems.tenantId, knowledgeItems.projectId, knowledgeItems.id] }).onDelete("cascade")
]);

export const crossServiceContracts = pgTable("cross_service_contracts", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  fromProjectId: text("from_project_id").notNull(),
  fromService: text("from_service").notNull(),
  relation: text("relation").notNull(),
  toProjectId: text("to_project_id").notNull(),
  contractId: text("contract_id").notNull(),
  schemaVersion: text("schema_version").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
});

export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  proposalId: text("proposal_id"),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  itemId: text("item_id").notNull(),
  domainId: integer("domain_id").notNull(),
  itemJson: jsonb("item_json"),
  requestedBy: text("requested_by").notNull(),
  actorType: text("actor_type").default("human").notNull(),
  status: text("status").default("pending").notNull(),
  reviewedBy: text("reviewed_by"),
  assignedTo: text("assigned_to"),
  dueAt: timestamp("due_at", { withTimezone: true }),
  reason: text("reason"),
  reviewNote: text("review_note"),
  prUrl: text("pr_url"),
  accessPolicyId: text("access_policy_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
});

export const approvalReminderEvents = pgTable("approval_reminder_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  proposalId: text("proposal_id").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  eventType: text("event_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [unique("uq_approval_reminder_event").on(t.tenantId, t.projectId, t.proposalId, t.dueAt, t.eventType)]);

export const notificationPreferences = pgTable("notification_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  actorId: text("actor_id").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  channels: text("channels").array().notNull(),
  categories: text("categories").array().notNull(),
  frequency: text("frequency").default("immediate").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [unique("uq_notification_preferences_owner").on(t.tenantId, t.projectId, t.actorId, t.accessPolicyId)]);

export const notificationOutbox = pgTable("notification_outbox", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  actorId: text("actor_id").notNull(),
  accessPolicyId: text("access_policy_id").notNull(),
  channel: text("channel").notNull(),
  category: text("category").notNull(),
  eventKey: text("event_key").notNull(),
  payload: jsonb("payload").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  unique("uq_notification_outbox_event").on(t.tenantId, t.projectId, t.actorId, t.eventKey),
  index("idx_notification_outbox_pending").on(t.tenantId, t.projectId, t.actorId, t.scheduledAt)
]);

export const developerProfiles = pgTable("developer_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  actorId: text("actor_id").notNull(),
  preferredPackageManager: text("preferred_package_manager"),
  preferredTestLayout: text("preferred_test_layout"),
  preferredArchitectureStyle: text("preferred_architecture_style"),
  codingConventions: text("coding_conventions").array().notNull().default([]),
  preferredHarness: text("preferred_harness"),
  optInCrossProject: boolean("opt_in_cross_project").default(true).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [unique("uq_developer_profiles_owner").on(t.tenantId, t.actorId)]);

export const customAccessPolicies = pgTable("custom_access_policies", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  policyId: text("policy_id").notNull(),
  label: text("label").notNull(),
  description: text("description").notNull(),
  allowedRoles: text("allowed_roles").array().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.projectId, t.policyId] }),
  index("idx_custom_access_policies_scope").on(t.tenantId, t.projectId)
]);

export const projectAccessMembers = pgTable("project_access_members", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  actorId: text("actor_id").notNull(),
  roles: text("roles").array().notNull(),
  allowedPolicies: text("allowed_policies").array().notNull(),
  syncedWithKeycloak: boolean("synced_with_keycloak").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.projectId, t.actorId] }),
  index("idx_project_access_members_scope").on(t.tenantId, t.projectId)
]);

export const temporaryAccessGrants = pgTable("temporary_access_grants", {
  grantId: text("grant_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  actorId: text("actor_id").notNull(),
  roles: text("roles").array().notNull(),
  policyIds: text("policy_ids").array().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  grantedBy: text("granted_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [
  primaryKey({ columns: [t.tenantId, t.projectId, t.grantId] }),
  index("idx_temporary_access_grants_active").on(t.tenantId, t.projectId, t.expiresAt)
]);

export const departmentFinopsQuotas = pgTable("department_finops_quotas", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  department: text("department").notNull(),
  monthlyTokenLimit: integer("monthly_token_limit").notNull(),
  monthlyUsdLimit: text("monthly_usd_limit").notNull(),
  downgradeModel: text("downgrade_model"),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.department] })]);

export const integrationFallbackOwners = pgTable("integration_fallback_owners", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  provider: text("provider").notNull(),
  fallbackOwner: text("fallback_owner").notNull(),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.provider] })]);

export const integrationReconnectHistory = pgTable("integration_reconnect_history", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  provider: text("provider").notNull(),
  status: text("status").notNull(),
  actorId: text("actor_id").notNull(),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  lastReconnectAt: timestamp("last_reconnect_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [index("idx_integration_reconnect_history_scope").on(t.tenantId, t.projectId, t.provider, t.lastReconnectAt)]);

export const lgpdShreddedSubjects = pgTable("lgpd_shredded_subjects", {
  tenantId: text("tenant_id").notNull(),
  projectId: text("project_id").notNull(),
  subjectId: text("subject_id").notNull(),
  accessPolicyId: text("access_policy_id").default("internal-project").notNull(),
  shreddedBy: text("shredded_by").notNull(),
  shreddedAt: timestamp("shredded_at", { withTimezone: true }).defaultNow().notNull()
}, (t) => [primaryKey({ columns: [t.tenantId, t.projectId, t.subjectId] })]);

