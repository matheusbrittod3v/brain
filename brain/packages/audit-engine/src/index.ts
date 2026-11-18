import type { ActorType } from "@brain/auth";
import {
  createAppPostgresClient,
  getAppDatabaseUrl,
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type AppPostgresClientOptions,
  type AppPostgresPoolOptions,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";

export {
  createAppPostgresClient,
  getAppDatabaseUrl,
  type AppPostgresClient,
  type AppPostgresClientOptions,
  type AppPostgresPoolOptions,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";

export type AuditAction =
  | "read_sensitive"
  | "search"
  | "create"
  | "update"
  | "approve"
  | "revoke"
  | "sync_pull"
  | "sync_push"
  | "export";

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  "read_sensitive",
  "search",
  "create",
  "update",
  "approve",
  "revoke",
  "sync_pull",
  "sync_push",
  "export"
];

const VALID_ACTOR_TYPES = new Set<ActorType>(["human", "agent", "system"]);
const VALID_AUDIT_ACTIONS = new Set<AuditAction>(AUDIT_ACTIONS);
const INVALID_SCOPE_TOKEN_CHARS = /[,\0\r\n]/;

export interface AuditEvent {
  tenantId: string;
  projectId?: string;
  actorId: string;
  actorType: ActorType;
  accessPolicyId: string;
  action: AuditAction;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type AuditEventInput = Omit<AuditEvent, "createdAt">;

export interface AuditLogger {
  record(event: Omit<AuditEvent, "createdAt">): Promise<void>;
}

export type AuditSqlParameter = string | null;

export type AuditSqlTransactionRunner = {
  (template: TemplateStringsArray, ...parameters: readonly AuditSqlParameter[]): PromiseLike<unknown>;
};

export type AuditSqlClient<TTx extends AuditSqlTransactionRunner = AuditSqlTransactionRunner> =
  RlsSqlClient<TTx>;

export type AuditPostgresTarget<TTx extends AuditSqlTransactionRunner = AuditSqlTransactionRunner> =
  AppPostgresClient<TTx>;

export type PostgresAuditLoggerOptions<
  TTx extends AuditSqlTransactionRunner = AuditSqlTransactionRunner
> =
  | {
      client: AppPostgresClient<TTx>;
      context: RlsSessionContext;
      now?: () => Date;
    }
  | {
      sql: AppPostgresClient<TTx>;
      context: RlsSessionContext;
      now?: () => Date;
    };

const UNSAFE_RAW_SQL_TEST_SEAM = Symbol("brain.audit.unsafeRawSqlTestSeam");

interface UnsafeTestSeamTarget<TTx extends AuditSqlTransactionRunner> {
  readonly [UNSAFE_RAW_SQL_TEST_SEAM]: true;
  readonly sql: AuditSqlClient<TTx>;
}

function isUnsafeTestSeamTarget<TTx extends AuditSqlTransactionRunner>(
  candidate: unknown
): candidate is UnsafeTestSeamTarget<TTx> {
  return (
    Boolean(candidate) &&
    typeof candidate === "object" &&
    UNSAFE_RAW_SQL_TEST_SEAM in (candidate as Record<symbol, unknown>) &&
    (candidate as Record<symbol, unknown>)[UNSAFE_RAW_SQL_TEST_SEAM] === true
  );
}

function assertVerifiedAppPostgresClient<TTx extends AuditSqlTransactionRunner>(
  candidate: unknown
): AppPostgresClient<TTx> {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      "PostgresAuditLogger requires a verified AppPostgresClient bound to role 'brain_app'; raw RlsSqlClient is forbidden on the production path."
    );
  }
  const obj = candidate as Partial<AppPostgresClient<TTx>> & { begin?: unknown };
  if (obj.role !== "brain_app") {
    const receivedRole = "role" in obj ? `'${String(obj.role)}'` : "unverified raw SQL client";
    throw new Error(
      `PostgresAuditLogger requires a verified AppPostgresClient bound to role 'brain_app' (received ${receivedRole}); raw RlsSqlClient is forbidden on the production path.`
    );
  }
  if (
    typeof obj.withRlsTransaction !== "function" ||
    typeof obj.close !== "function" ||
    (obj.sql !== undefined && (!obj.sql || typeof obj.sql.begin !== "function"))
  ) {
    throw new Error(
      "PostgresAuditLogger requires a valid AppPostgresClient with withRlsTransaction, close, and underlying sql.begin."
    );
  }
  return obj as AppPostgresClient<TTx>;
}

function requireNonEmptyString(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`AuditEvent.${fieldName} must be a non-empty string.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`AuditEvent.${fieldName} must be a non-empty string.`);
  }
  return trimmed;
}

function requireScopeToken(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`AuditEvent.${fieldName} must be a non-empty string.`);
  }
  if (INVALID_SCOPE_TOKEN_CHARS.test(raw)) {
    throw new Error(`AuditEvent.${fieldName} contains invalid characters (comma, null byte, or newline).`);
  }
  const token = requireNonEmptyString(raw, fieldName);
  if (token === "*") {
    throw new Error(`AuditEvent.${fieldName} cannot be wildcard '*'; an explicit value is required.`);
  }
  return token;
}

function serializeAuditMetadata(metadata: Record<string, unknown> | undefined): string {
  try {
    const json = JSON.stringify(metadata ?? {});
    if (typeof json !== "string") {
      throw new Error("AuditEvent.metadata must serialize to a JSON object.");
    }
    return json;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`AuditEvent.metadata must be JSON-serializable: ${detail}`);
  }
}

function resolveAuditTimestamp(nowFn: () => Date): string {
  const date = nowFn();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error("PostgresAuditLogger clock returned an invalid Date.");
  }
  return date.toISOString();
}

/**
 * Validates an incoming audit event payload without inventing default policies
 * or inferring `accessPolicyId` from an actor's `allowedPolicies`.
 */
export function validateAuditEventInput(event: AuditEventInput): AuditEventInput {
  if (!event || typeof event !== "object") {
    throw new Error("AuditEvent must be a non-null object.");
  }

  const tenantId = requireScopeToken(event.tenantId, "tenantId");
  const accessPolicyId = requireScopeToken(event.accessPolicyId, "accessPolicyId");
  const actorId = requireNonEmptyString(event.actorId, "actorId");
  const targetType = requireNonEmptyString(event.targetType, "targetType");

  if (!VALID_ACTOR_TYPES.has(event.actorType)) {
    throw new Error(`AuditEvent.actorType must be one of: human, agent, system.`);
  }

  if (!VALID_AUDIT_ACTIONS.has(event.action)) {
    throw new Error(`AuditEvent.action must be a valid AuditAction.`);
  }

  let projectId: string | undefined;
  if (event.projectId !== undefined) {
    projectId = requireScopeToken(event.projectId, "projectId");
  }

  let targetId: string | undefined;
  if (event.targetId !== undefined) {
    targetId = requireNonEmptyString(event.targetId, "targetId");
  }

  let metadata: Record<string, unknown> | undefined;
  if (event.metadata !== undefined) {
    if (event.metadata === null || typeof event.metadata !== "object" || Array.isArray(event.metadata)) {
      throw new Error("AuditEvent.metadata must be a plain object when provided.");
    }
    metadata = { ...event.metadata };
  }

  return {
    tenantId,
    ...(projectId !== undefined ? { projectId } : {}),
    actorId,
    actorType: event.actorType,
    accessPolicyId,
    action: event.action,
    targetType,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(metadata !== undefined ? { metadata } : {})
  };
}

/**
 * Validates an `AuditEventInput` against a trusted `RlsSessionContext` before
 * opening a database transaction.
 *
 * - Requires `event.tenantId` to match `context.tenantId`.
 * - When `event.projectId` is present, requires it in `context.allowedProjects`.
 * - When `event.projectId` is omitted (`undefined`), requires `"__org__"` in `context.allowedProjects`.
 * - Requires `event.accessPolicyId` in `context.allowedPolicies`.
 */
export function validateAuditEventForRlsContext(
  event: AuditEventInput,
  context: RlsSessionContext
): AuditEventInput {
  const resolvedContext = resolveRlsSessionContext(context);
  const validated = validateAuditEventInput(event);

  if (validated.tenantId !== resolvedContext.tenantId) {
    throw new Error(
      `AuditEvent.tenantId '${validated.tenantId}' does not match RLS context tenantId '${resolvedContext.tenantId}'.`
    );
  }

  const allowedProjects = new Set(resolvedContext.allowedProjectsCsv.split(","));
  if (validated.projectId === undefined) {
    if (!allowedProjects.has("__org__")) {
      throw new Error(
        "AuditEvent with omitted projectId (organizational scope) requires '__org__' in RLS context allowedProjects."
      );
    }
  } else if (!allowedProjects.has(validated.projectId)) {
    throw new Error(
      `AuditEvent.projectId '${validated.projectId}' is not authorized in RLS context allowedProjects.`
    );
  }

  const allowedPolicies = new Set(resolvedContext.allowedPoliciesCsv.split(","));
  if (!allowedPolicies.has(validated.accessPolicyId)) {
    throw new Error(
      `AuditEvent.accessPolicyId '${validated.accessPolicyId}' is not authorized in RLS context allowedPolicies.`
    );
  }

  return validated;
}

export class InMemoryAuditLogger implements AuditLogger {
  public readonly events: AuditEvent[] = [];

  async record(event: Omit<AuditEvent, "createdAt">): Promise<void> {
    const validated = validateAuditEventInput(event);
    this.events.push({
      ...validated,
      createdAt: new Date().toISOString()
    });
  }
}

/**
 * Append-only PostgreSQL audit logger backed by `@brain/database` `withRlsTransaction`.
 *
 * Validates both the trusted `RlsSessionContext` and the incoming `AuditEvent` before
 * opening a transaction, binds transaction-local RLS GUCs (`app.current_tenant_id`,
 * `app.allowed_projects`, `app.allowed_policies`), and executes a parameterized
 * `INSERT INTO audit_logs` inside the same transaction.
 */
export class PostgresAuditLogger<
  TTx extends AuditSqlTransactionRunner = AuditSqlTransactionRunner
> implements AuditLogger {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly context: RlsSessionContext;
  private readonly resolvedContext: ResolvedRlsSessionGucs;
  private readonly now: () => Date;

  constructor(
    client: AppPostgresClient<TTx>,
    context: RlsSessionContext,
    options?: { now?: () => Date }
  );
  constructor(options: PostgresAuditLoggerOptions<TTx>);
  constructor(
    clientOrOptions: AppPostgresClient<TTx> | PostgresAuditLoggerOptions<TTx>,
    maybeContext?: RlsSessionContext,
    maybeOptions?: { now?: () => Date }
  ) {
    let target: unknown;
    let context: RlsSessionContext;
    let now: (() => Date) | undefined;

    if (
      clientOrOptions &&
      typeof clientOrOptions === "object" &&
      "context" in clientOrOptions &&
      ("client" in clientOrOptions || "sql" in clientOrOptions) &&
      !("withRlsTransaction" in clientOrOptions)
    ) {
      target = "client" in clientOrOptions ? clientOrOptions.client : clientOrOptions.sql;
      context = clientOrOptions.context;
      now = clientOrOptions.now;
    } else {
      target = clientOrOptions;
      context = maybeContext as RlsSessionContext;
      now = maybeOptions?.now;
    }

    if (isUnsafeTestSeamTarget<TTx>(target)) {
      const sqlClient = target.sql;
      this.runInRlsTransaction = (ctx, cb) => withRlsTransaction(sqlClient, ctx, cb);
    } else {
      const appClient = assertVerifiedAppPostgresClient<TTx>(target);
      this.runInRlsTransaction = (ctx, cb) => appClient.withRlsTransaction(ctx, cb);
    }

    this.resolvedContext = resolveRlsSessionContext(context);
    this.context = {
      tenantId: this.resolvedContext.tenantId,
      allowedProjects: this.resolvedContext.allowedProjectsCsv.split(","),
      allowedPolicies: this.resolvedContext.allowedPoliciesCsv.split(",")
    };
    this.now = now ?? (() => new Date());
  }

  async record(event: Omit<AuditEvent, "createdAt">): Promise<void> {
    const validated = validateAuditEventForRlsContext(event, this.context);
    const metadataJson = serializeAuditMetadata(validated.metadata);
    const createdAt = resolveAuditTimestamp(this.now);
    const projectIdParam: string | null = validated.projectId ?? null;
    const targetIdParam: string | null = validated.targetId ?? null;

    await this.runInRlsTransaction(this.context, async (tx) => {
      await tx`INSERT INTO audit_logs (
        tenant_id,
        project_id,
        actor_id,
        actor_type,
        access_policy_id,
        action,
        target_type,
        target_id,
        metadata,
        created_at
      ) VALUES (
        ${validated.tenantId},
        ${projectIdParam},
        ${validated.actorId},
        ${validated.actorType},
        ${validated.accessPolicyId},
        ${validated.action},
        ${validated.targetType},
        ${targetIdParam},
        ${metadataJson}::jsonb,
        ${createdAt}::timestamptz
      )`;
    });
  }
}

export function createPostgresAuditLogger<
  TTx extends AuditSqlTransactionRunner = AuditSqlTransactionRunner
>(
  client: AppPostgresClient<TTx>,
  context: RlsSessionContext,
  options?: { now?: () => Date }
): PostgresAuditLogger<TTx> {
  return new PostgresAuditLogger(client, context, options);
}

/**
 * Explicit test-only factory that allows injecting a fake `AuditSqlClient` (`{ begin }`)
 * in offline behavioral unit tests without a full `AppPostgresClient`.
 *
 * Production code MUST use `new PostgresAuditLogger(appClient, context)` or
 * `createPostgresAuditLogger(appClient, context)` with a verified `brain_app` client.
 */
export function createPostgresAuditLoggerForTesting<
  TTx extends AuditSqlTransactionRunner = AuditSqlTransactionRunner
>(
  sql: AuditSqlClient<TTx>,
  context: RlsSessionContext,
  options?: { now?: () => Date }
): PostgresAuditLogger<TTx> {
  if (!sql || typeof sql !== "object" || typeof sql.begin !== "function") {
    throw new Error(
      "createPostgresAuditLoggerForTesting requires a valid fake AuditSqlClient with a begin(callback) method."
    );
  }
  if ("role" in sql && (sql as { role?: unknown }).role !== "brain_app") {
    throw new Error(
      `createPostgresAuditLoggerForTesting rejects non-brain_app role '${String((sql as { role?: unknown }).role)}'.`
    );
  }
  const seamTarget: UnsafeTestSeamTarget<TTx> = {
    [UNSAFE_RAW_SQL_TEST_SEAM]: true,
    sql
  };
  return new PostgresAuditLogger(
    seamTarget as unknown as AppPostgresClient<TTx>,
    context,
    options
  );
}



