import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_ACTIONS,
  InMemoryAuditLogger,
  PostgresAuditLogger,
  createAppPostgresClient,
  createPostgresAuditLogger,
  createPostgresAuditLoggerForTesting,
  validateAuditEventForRlsContext,
  validateAuditEventInput,
  type AppPostgresClient,
  type AuditEvent,
  type AuditEventInput,
  type AuditLogger,
  type AuditSqlClient,
  type AuditSqlParameter,
  type AuditSqlTransactionRunner,
  type RlsSessionContext
} from "../src/index.js";

interface RecordedStatement {
  txId: number;
  sqlTemplate: string;
  params: readonly AuditSqlParameter[];
}

interface PersistedAuditRow {
  txId: number;
  tenant_id: string;
  project_id: string | null;
  actor_id: string;
  actor_type: string;
  access_policy_id: string;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Behavioral in-process fake SQL client that simulates PostgreSQL transaction scoping,
 * `set_config` GUCs from `@noema/database` `withRlsTransaction`, and the `audit_logs`
 * RLS `WITH CHECK` policy on `INSERT`.
 */
function createBehavioralAuditSqlHarness(opts?: {
  failOnInsert?: Error;
  failOnBegin?: Error;
}) {
  let beginCount = 0;
  const statements: RecordedStatement[] = [];
  const rows: PersistedAuditRow[] = [];

  const sql: AuditSqlClient = {
    async begin<T>(callback: (tx: AuditSqlTransactionRunner) => T | Promise<T>): Promise<T> {
      beginCount += 1;
      if (opts?.failOnBegin) {
        throw opts.failOnBegin;
      }

      const txId = beginCount;
      const localGucs = new Map<string, string>();

      const tx: AuditSqlTransactionRunner = async (
        template: TemplateStringsArray,
        ...parameters: readonly AuditSqlParameter[]
      ) => {
        const sqlTemplate = template.join("?");
        statements.push({ txId, sqlTemplate, params: parameters });

        if (sqlTemplate.includes("set_config('app.current_tenant_id'")) {
          localGucs.set("app.current_tenant_id", String(parameters[0] ?? ""));
          localGucs.set("app.allowed_projects", String(parameters[1] ?? ""));
          localGucs.set("app.allowed_policies", String(parameters[2] ?? ""));
          return [];
        }

        if (sqlTemplate.includes("INSERT INTO audit_logs")) {
          if (opts?.failOnInsert) {
            throw opts.failOnInsert;
          }

          // Verify RLS GUCs were set on this exact transaction before INSERT
          const gucTenant = localGucs.get("app.current_tenant_id");
          const gucProjects = localGucs.get("app.allowed_projects")?.split(",").filter(Boolean) ?? [];
          const gucPolicies = localGucs.get("app.allowed_policies")?.split(",").filter(Boolean) ?? [];

          if (!gucTenant || gucProjects.length === 0 || gucPolicies.length === 0) {
            throw new Error("RLS violation: transaction-local GUCs were not set on this tx before INSERT.");
          }

          assert.equal(parameters.length, 10, "Expected 10 bound parameters for INSERT INTO audit_logs");
          const [
            tenant_id,
            project_id,
            actor_id,
            actor_type,
            access_policy_id,
            action,
            target_type,
            target_id,
            metadataJson,
            created_at
          ] = parameters;

          assert.equal(typeof tenant_id, "string");
          assert.ok(project_id === null || typeof project_id === "string");
          assert.equal(typeof actor_id, "string");
          assert.equal(typeof actor_type, "string");
          assert.equal(typeof access_policy_id, "string");
          assert.equal(typeof action, "string");
          assert.equal(typeof target_type, "string");
          assert.ok(target_id === null || typeof target_id === "string");
          assert.equal(typeof metadataJson, "string");
          assert.equal(typeof created_at, "string");

          // Enforce the normative PostgreSQL RLS WITH CHECK predicate on audit_logs:
          // tenant_id = current_setting('app.current_tenant_id', true)
          // AND coalesce(project_id, '__org__') = ANY(allowed_projects)
          // AND access_policy_id = ANY(allowed_policies)
          const effectiveProject = project_id ?? "__org__";
          if (
            tenant_id !== gucTenant ||
            !gucProjects.includes(effectiveProject) ||
            !gucPolicies.includes(access_policy_id!)
          ) {
            throw new Error("new row violates row-level security policy for table \"audit_logs\"");
          }

          rows.push({
            txId,
            tenant_id: tenant_id!,
            project_id,
            actor_id: actor_id!,
            actor_type: actor_type!,
            access_policy_id: access_policy_id!,
            action: action!,
            target_type: target_type!,
            target_id,
            metadata: JSON.parse(metadataJson!) as Record<string, unknown>,
            created_at: created_at!
          });
          return [];
        }

        throw new Error(`Unexpected SQL statement in audit logger: ${sqlTemplate}`);
      };

      return await callback(tx);
    }
  };

  return {
    sql,
    getBeginCount: () => beginCount,
    statements,
    rows
  };
}

test("records project-scoped audit event with explicit accessPolicyId and clones metadata", async () => {
  const logger = new InMemoryAuditLogger();
  const asInterface: AuditLogger = logger;
  const mutableMeta: Record<string, unknown> = { reason: "rule-ingest", count: 2 };

  await asInterface.record({
    tenantId: "acme-corp",
    projectId: "billing-service",
    actorId: "dev-42",
    actorType: "human",
    accessPolicyId: "confidential-business",
    action: "create",
    targetType: "knowledge_item",
    targetId: "BR-BILL-001",
    metadata: mutableMeta
  });

  mutableMeta.reason = "mutated-after-record";

  assert.equal(logger.events.length, 1);
  const recorded = logger.events[0]!;
  assert.equal(recorded.tenantId, "acme-corp");
  assert.equal(recorded.projectId, "billing-service");
  assert.equal(recorded.actorId, "dev-42");
  assert.equal(recorded.actorType, "human");
  assert.equal(recorded.accessPolicyId, "confidential-business");
  assert.equal(recorded.action, "create");
  assert.equal(recorded.targetType, "knowledge_item");
  assert.equal(recorded.targetId, "BR-BILL-001");
  assert.deepEqual(recorded.metadata, { reason: "rule-ingest", count: 2 });
  assert.ok(!Number.isNaN(Date.parse(recorded.createdAt)));
});

test("records organization-scoped audit event when projectId is omitted without inventing defaults", async () => {
  const logger = new InMemoryAuditLogger();

  await logger.record({
    tenantId: "acme-corp",
    actorId: "sync-daemon",
    actorType: "system",
    accessPolicyId: "public-org",
    action: "sync_pull",
    targetType: "organization_catalog"
  });

  assert.equal(logger.events.length, 1);
  const recorded: AuditEvent = logger.events[0]!;
  assert.equal(recorded.tenantId, "acme-corp");
  assert.equal(recorded.projectId, undefined);
  assert.equal("projectId" in recorded, false);
  assert.equal(recorded.accessPolicyId, "public-org");
  assert.equal(recorded.actorId, "sync-daemon");
  assert.equal(recorded.actorType, "system");
  assert.equal(recorded.action, "sync_pull");
  assert.equal(recorded.targetType, "organization_catalog");
  assert.equal(recorded.targetId, undefined);
});

test("enforces explicit accessPolicyId at compile time and runtime without fallback policy", async () => {
  const logger = new InMemoryAuditLogger();

  // @ts-expect-error accessPolicyId is required on AuditEventInput
  const missingPolicyEvent: AuditEventInput = {
    tenantId: "acme-corp",
    projectId: "sub-service",
    actorId: "agent-01",
    actorType: "agent",
    action: "search",
    targetType: "context_pack"
  };

  await assert.rejects(
    () => logger.record(missingPolicyEvent),
    /AuditEvent\.accessPolicyId must be a non-empty string/
  );

  for (const invalidPolicy of ["", "   ", "*", "public-org,internal-project", "public-org\0", "public-org\n"]) {
    await assert.rejects(
      () =>
        logger.record({
          tenantId: "acme-corp",
          projectId: "sub-service",
          actorId: "agent-01",
          actorType: "agent",
          accessPolicyId: invalidPolicy,
          action: "search",
          targetType: "context_pack"
        }),
      /AuditEvent\.accessPolicyId/
    );
  }

  assert.equal(logger.events.length, 0);
});

test("rejects blank or malformed projectId and invalid fields without mutating in-memory log", async () => {
  const logger = new InMemoryAuditLogger();

  for (const badProjectId of ["", "   ", "*", "proj-a,proj-b", "proj\0id"]) {
    await assert.rejects(
      () =>
        logger.record({
          tenantId: "acme-corp",
          projectId: badProjectId,
          actorId: "dev-1",
          actorType: "human",
          accessPolicyId: "internal-project",
          action: "update",
          targetType: "knowledge_item"
        }),
      /AuditEvent\.projectId/
    );
  }

  await assert.rejects(
    () =>
      logger.record({
        tenantId: "   ",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "read_sensitive",
        targetType: "secret_policy"
      }),
    /AuditEvent\.tenantId/
  );

  await assert.rejects(
    () =>
      logger.record({
        tenantId: "acme-corp",
        actorId: "dev-1",
        actorType: "invalid-actor" as never,
        accessPolicyId: "internal-project",
        action: "read_sensitive",
        targetType: "secret_policy"
      }),
    /AuditEvent\.actorType/
  );

  await assert.rejects(
    () =>
      logger.record({
        tenantId: "acme-corp",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "delete_all" as never,
        targetType: "secret_policy"
      }),
    /AuditEvent\.action/
  );

  assert.equal(logger.events.length, 0);
  assert.equal(AUDIT_ACTIONS.length, 9);
  const validated = validateAuditEventInput({
    tenantId: " acme-corp ",
    actorId: " auditor-1 ",
    actorType: "human",
    accessPolicyId: " restricted-security ",
    action: "export",
    targetType: " audit_bundle "
  });
  assert.equal(validated.tenantId, "acme-corp");
  assert.equal(validated.accessPolicyId, "restricted-security");
  assert.equal(validated.projectId, undefined);
});

test("PostgresAuditLogger executes RLS GUC setup and parameterized INSERT in the same transaction", async () => {
  const harness = createBehavioralAuditSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme-corp",
    allowedProjects: ["billing-service", "__org__"],
    allowedPolicies: ["internal-project", "confidential-business"]
  };
  const fixedTime = new Date("2026-11-16T20:10:00.000Z");

  const logger: AuditLogger = createPostgresAuditLoggerForTesting(harness.sql, rlsContext, {
    now: () => fixedTime
  });

  await logger.record({
    tenantId: "acme-corp",
    projectId: "billing-service",
    actorId: "dev-99",
    actorType: "human",
    accessPolicyId: "confidential-business",
    action: "approve",
    targetType: "business_rule",
    targetId: "BR-BILL-007",
    metadata: { prNumber: 128, reviewer: "tech-lead" }
  });

  assert.equal(harness.getBeginCount(), 1, "Must execute inside a single transaction");
  assert.equal(harness.statements.length, 2, "Must run set_config followed by INSERT on the same tx");
  assert.equal(harness.statements[0]!.txId, 1);
  assert.equal(harness.statements[1]!.txId, 1);
  assert.deepEqual(harness.statements[0]!.params, [
    "acme-corp",
    "billing-service,__org__",
    "internal-project,confidential-business"
  ]);

  // Verify no caller values were interpolated into the raw SQL template
  const insertTemplate = harness.statements[1]!.sqlTemplate;
  assert.ok(!insertTemplate.includes("acme-corp"));
  assert.ok(!insertTemplate.includes("billing-service"));
  assert.ok(!insertTemplate.includes("BR-BILL-007"));
  assert.ok(insertTemplate.includes("?::jsonb"));
  assert.ok(insertTemplate.includes("?::timestamptz"));

  assert.equal(harness.rows.length, 1);
  assert.deepEqual(harness.rows[0], {
    txId: 1,
    tenant_id: "acme-corp",
    project_id: "billing-service",
    actor_id: "dev-99",
    actor_type: "human",
    access_policy_id: "confidential-business",
    action: "approve",
    target_type: "business_rule",
    target_id: "BR-BILL-007",
    metadata: { prNumber: 128, reviewer: "tech-lead" },
    created_at: "2026-11-16T20:10:00.000Z"
  });
});

test("PostgresAuditLogger persists NULL project_id for organizational events when __org__ is authorized", async () => {
  const harness = createBehavioralAuditSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme-corp",
    allowedProjects: ["__org__"],
    allowedPolicies: ["public-org"]
  };
  const fixedTime = new Date("2026-11-16T20:15:00.000Z");

  const logger = createPostgresAuditLoggerForTesting(harness.sql, rlsContext, {
    now: () => fixedTime
  });

  await logger.record({
    tenantId: "acme-corp",
    actorId: "edge-sync-worker",
    actorType: "system",
    accessPolicyId: "public-org",
    action: "sync_pull",
    targetType: "org_manifest"
  });

  assert.equal(harness.getBeginCount(), 1);
  assert.equal(harness.rows.length, 1);
  assert.deepEqual(harness.rows[0], {
    txId: 1,
    tenant_id: "acme-corp",
    project_id: null,
    actor_id: "edge-sync-worker",
    actor_type: "system",
    access_policy_id: "public-org",
    action: "sync_pull",
    target_type: "org_manifest",
    target_id: null,
    metadata: {},
    created_at: "2026-11-16T20:15:00.000Z"
  });
});

test("PostgresAuditLogger denies unauthorized tenant, project, __org__, or policy BEFORE opening a transaction", async () => {
  const harness = createBehavioralAuditSqlHarness();

  // 1. Context without __org__ rejects organizational event (projectId omitted) before sql.begin
  const loggerNoOrg = createPostgresAuditLoggerForTesting(harness.sql, {
    tenantId: "acme-corp",
    allowedProjects: ["billing-service"],
    allowedPolicies: ["public-org", "internal-project"]
  });

  await assert.rejects(
    () =>
      loggerNoOrg.record({
        tenantId: "acme-corp",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "public-org",
        action: "search",
        targetType: "org_catalog"
      }),
    /requires '__org__' in RLS context allowedProjects/
  );

  // 2. Event targeting a project outside allowedProjects rejects before sql.begin
  await assert.rejects(
    () =>
      loggerNoOrg.record({
        tenantId: "acme-corp",
        projectId: "unauthorized-project",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "search",
        targetType: "context_pack"
      }),
    /AuditEvent\.projectId 'unauthorized-project' is not authorized/
  );

  // 3. Event targeting a different tenant rejects before sql.begin
  await assert.rejects(
    () =>
      loggerNoOrg.record({
        tenantId: "other-tenant",
        projectId: "billing-service",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "search",
        targetType: "context_pack"
      }),
    /AuditEvent\.tenantId 'other-tenant' does not match RLS context tenantId 'acme-corp'/
  );

  // 4. Event using an accessPolicyId outside allowedPolicies rejects before sql.begin
  await assert.rejects(
    () =>
      loggerNoOrg.record({
        tenantId: "acme-corp",
        projectId: "billing-service",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "restricted-security",
        action: "read_sensitive",
        targetType: "incident_report"
      }),
    /AuditEvent\.accessPolicyId 'restricted-security' is not authorized/
  );

  // 5. Unserializable metadata rejects before sql.begin
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await assert.rejects(
    () =>
      loggerNoOrg.record({
        tenantId: "acme-corp",
        projectId: "billing-service",
        actorId: "dev-1",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "create",
        targetType: "knowledge_item",
        metadata: circular
      }),
    /AuditEvent\.metadata must be JSON-serializable/
  );

  assert.equal(harness.getBeginCount(), 0, "No database transaction may open when validation fails");
  assert.equal(harness.statements.length, 0);
  assert.equal(harness.rows.length, 0);
});

test("PostgresAuditLogger propagates transaction and INSERT errors without silent fallback", async () => {
  const dbInsertError = new Error("connection terminated unexpectedly during INSERT");
  const failingInsertHarness = createBehavioralAuditSqlHarness({ failOnInsert: dbInsertError });
  const rlsContext: RlsSessionContext = {
    tenantId: "acme-corp",
    allowedProjects: ["billing-service"],
    allowedPolicies: ["internal-project"]
  };

  const logger = createPostgresAuditLoggerForTesting(failingInsertHarness.sql, rlsContext);

  await assert.rejects(
    () =>
      logger.record({
        tenantId: "acme-corp",
        projectId: "billing-service",
        actorId: "agent-7",
        actorType: "agent",
        accessPolicyId: "internal-project",
        action: "search",
        targetType: "context_pack"
      }),
    (err: unknown) => err === dbInsertError
  );

  assert.equal(failingInsertHarness.getBeginCount(), 1);
  assert.equal(failingInsertHarness.rows.length, 0);

  const dbBeginError = new Error("FATAL: remaining connection slots are reserved");
  const failingBeginHarness = createBehavioralAuditSqlHarness({ failOnBegin: dbBeginError });
  const beginFailLogger = createPostgresAuditLoggerForTesting(failingBeginHarness.sql, rlsContext);

  await assert.rejects(
    () =>
      beginFailLogger.record({
        tenantId: "acme-corp",
        projectId: "billing-service",
        actorId: "agent-7",
        actorType: "agent",
        accessPolicyId: "internal-project",
        action: "search",
        targetType: "context_pack"
      }),
    (err: unknown) => err === dbBeginError
  );

  assert.equal(failingBeginHarness.rows.length, 0);

  // Also verify validateAuditEventForRlsContext returns normalized payload for valid inputs
  const checked = validateAuditEventForRlsContext(
    {
      tenantId: "acme-corp",
      projectId: "billing-service",
      actorId: "agent-7",
      actorType: "agent",
      accessPolicyId: "internal-project",
      action: "search",
      targetType: "context_pack"
    },
    rlsContext
  );
  assert.equal(checked.projectId, "billing-service");
  assert.equal(checked.accessPolicyId, "internal-project");
});

test("PostgresAuditLogger integrates with createAppPostgresClient (brain_app role, credential redaction, and close lifecycle)", async () => {
  const harness = createBehavioralAuditSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme-corp",
    allowedProjects: ["billing-service", "__org__"],
    allowedPolicies: ["public-org", "internal-project"]
  };
  const fixedTime = new Date("2026-11-16T20:25:00.000Z");

  const appClient: AppPostgresClient<AuditSqlTransactionRunner> = createAppPostgresClient({
    databaseUrl: "postgresql://brain_app:super_secret_pw_123@localhost:5432/project_brain_os",
    createSql: () => harness.sql
  });

  assert.equal(appClient.role, "brain_app");

  const logger = createPostgresAuditLogger(appClient, rlsContext, {
    now: () => fixedTime
  });

  await logger.record({
    tenantId: "acme-corp",
    projectId: "billing-service",
    actorId: "dev-app",
    actorType: "human",
    accessPolicyId: "internal-project",
    action: "create",
    targetType: "knowledge_item",
    targetId: "BR-APP-01",
    metadata: { via: "AppPostgresClient" }
  });

  assert.equal(harness.getBeginCount(), 1);
  assert.equal(harness.rows.length, 1);
  assert.equal(harness.rows[0]!.target_id, "BR-APP-01");
  assert.deepEqual(harness.rows[0]!.metadata, { via: "AppPostgresClient" });

  // Closing the AppPostgresClient prevents subsequent audit writes through the logger
  await appClient.close();
  await appClient.close(); // idempotent

  await assert.rejects(
    () =>
      logger.record({
        tenantId: "acme-corp",
        projectId: "billing-service",
        actorId: "dev-app",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "create",
        targetType: "knowledge_item"
      }),
    /Application PostgreSQL client is already closed/
  );
  assert.equal(harness.getBeginCount(), 1, "Closed AppPostgresClient must not open a new transaction");

  // Credential redaction via AppPostgresClient when an underlying DB error contains the password
  const leakingHarness = createBehavioralAuditSqlHarness({
    failOnInsert: new Error("connect failed for postgresql://brain_app:super_secret_pw_123@localhost:5432/project_brain_os")
  });
  const leakingClient = createAppPostgresClient({
    databaseUrl: "postgresql://brain_app:super_secret_pw_123@localhost:5432/project_brain_os",
    createSql: () => leakingHarness.sql
  });
  const leakingLogger = new PostgresAuditLogger(leakingClient, rlsContext);

  await assert.rejects(
    () =>
      leakingLogger.record({
        tenantId: "acme-corp",
        projectId: "billing-service",
        actorId: "dev-app",
        actorType: "human",
        accessPolicyId: "internal-project",
        action: "create",
        targetType: "knowledge_item"
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes("super_secret_pw_123"), "Password must be redacted by AppPostgresClient");
      assert.ok(err.message.includes("[REDACTED]"));
      return true;
    }
  );

  // Rejects non-brain_app role wrapper at construction time
  assert.throws(
    () =>
      new PostgresAuditLogger(
        {
          sql: harness.sql,
          role: "brain_system" as never,
          withRlsTransaction: appClient.withRlsTransaction,
          close: appClient.close
        },
        rlsContext
      ),
    /requires a verified AppPostgresClient bound to role 'brain_app'/
  );
});

test("PostgresAuditLogger rejects raw RlsSqlClient and forged test seams on the production path (fail-closed)", () => {
  const harness = createBehavioralAuditSqlHarness();
  const rlsContext: RlsSessionContext = {
    tenantId: "acme-corp",
    allowedProjects: ["billing-service"],
    allowedPolicies: ["internal-project"]
  };

  // 1. Direct constructor call with raw RlsSqlClient fails closed
  assert.throws(
    () => new PostgresAuditLogger(harness.sql as never, rlsContext),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 2. Options constructor call with raw RlsSqlClient fails closed
  assert.throws(
    () => new PostgresAuditLogger({ sql: harness.sql as never, context: rlsContext }),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 3. Production factory call with raw RlsSqlClient fails closed
  assert.throws(
    () => createPostgresAuditLogger(harness.sql as never, rlsContext),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 4. Forged external Symbol with the same description cannot bypass the module-private seam
  const forgedSeam = {
    [Symbol("noema.audit.unsafeRawSqlTestSeam")]: true,
    sql: harness.sql
  };
  assert.throws(
    () => new PostgresAuditLogger(forgedSeam as never, rlsContext),
    /raw RlsSqlClient is forbidden on the production path/
  );

  // 5. Partial object claiming role: 'brain_app' without withRlsTransaction / close / valid sql.begin fails closed
  assert.throws(
    () =>
      new PostgresAuditLogger(
        { role: "brain_app", begin: harness.sql.begin } as never,
        rlsContext
      ),
    /requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql\.begin/
  );
  assert.throws(
    () =>
      new PostgresAuditLogger(
        {
          role: "brain_app",
          withRlsTransaction: async () => undefined,
          close: async () => undefined,
          sql: {}
        } as never,
        rlsContext
      ),
    /requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql\.begin/
  );

  // Structural AppPostgresClient with role: 'brain_app', withRlsTransaction, and close (sql omitted) is accepted
  const structuralClient = new PostgresAuditLogger(
    {
      role: "brain_app",
      withRlsTransaction: async (
        _ctx: RlsSessionContext,
        cb: (tx: AuditSqlTransactionRunner) => Promise<unknown> | unknown
      ) => harness.sql.begin(cb),
      close: async () => undefined
    } as never,
    rlsContext
  );
  assert.ok(structuralClient);

  // 6. Test-only seam still rejects explicit non-brain_app role
  assert.throws(
    () =>
      createPostgresAuditLoggerForTesting(
        { begin: harness.sql.begin, role: "brain_system" } as never,
        rlsContext
      ),
    /rejects non-brain_app role 'brain_system'/
  );

  assert.equal(harness.getBeginCount(), 0);
});
