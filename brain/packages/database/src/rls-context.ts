import type { Sql, TransactionSql } from "postgres";

/**
 * Structural Row-Level Security (RLS) session context for `@brain/database`.
 * Preserves Layer 0/1 boundaries by avoiding any dependency on `@brain/auth` or `@brain/audit-engine`.
 */
export interface RlsSessionContext {
  tenantId: string;
  allowedProjects: readonly string[];
  allowedPolicies: readonly string[];
}

export interface ResolvedRlsSessionGucs {
  tenantId: string;
  allowedProjectsCsv: string;
  allowedPoliciesCsv: string;
  gucs: {
    "app.current_tenant_id": string;
    "app.allowed_projects": string;
    "app.allowed_policies": string;
  };
}

export type RlsTransactionRunner = {
  (template: TemplateStringsArray, ...parameters: readonly any[]): PromiseLike<unknown>;
};

export interface RlsSqlClient<TTx = TransactionSql> {
  begin<T>(callback: (tx: TTx) => T | Promise<T>): Promise<T>;
}

const INVALID_TOKEN_CHARS = /[,\0\r\n]/;

function validateRlsIdentifier(raw: unknown, fieldName: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${fieldName} must be a string.`);
  }
  const value = raw.trim();
  if (value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (value === "*") {
    throw new Error(`${fieldName} cannot use wildcard '*'; explicit IDs are required by RLS policies.`);
  }
  if (INVALID_TOKEN_CHARS.test(value)) {
    throw new Error(`${fieldName} contains invalid characters (comma, null byte, or newline).`);
  }
  return value;
}

function validateRlsIdentifierList(rawList: unknown, fieldName: string): string {
  if (!Array.isArray(rawList) || rawList.length === 0) {
    throw new Error(`${fieldName} must be a non-empty array of identifiers.`);
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const token = validateRlsIdentifier(rawList[i], `${fieldName}[${i}]`);
    if (!seen.has(token)) {
      seen.add(token);
      normalized.push(token);
    }
  }
  return normalized.join(",");
}

/**
 * Validates an `RlsSessionContext` and resolves the exact CSV values required by PostgreSQL
 * `current_setting(..., true)` and `string_to_array(..., ',')` in the normative RLS policies.
 */
export function resolveRlsSessionContext(context: RlsSessionContext): ResolvedRlsSessionGucs {
  if (!context || typeof context !== "object") {
    throw new Error("RlsSessionContext must be a non-null object.");
  }
  const tenantId = validateRlsIdentifier(context.tenantId, "tenantId");
  const allowedProjectsCsv = validateRlsIdentifierList(context.allowedProjects, "allowedProjects");
  const allowedPoliciesCsv = validateRlsIdentifierList(context.allowedPolicies, "allowedPolicies");

  return {
    tenantId,
    allowedProjectsCsv,
    allowedPoliciesCsv,
    gucs: {
      "app.current_tenant_id": tenantId,
      "app.allowed_projects": allowedProjectsCsv,
      "app.allowed_policies": allowedPoliciesCsv
    }
  };
}

/**
 * Executes `callback(tx)` inside a `postgres.js` transaction after setting the three required
 * transaction-local (`is_local = true`) RLS GUCs:
 * - `app.current_tenant_id`
 * - `app.allowed_projects`
 * - `app.allowed_policies`
 *
 * Validation runs before `sql.begin(...)` so an invalid context never opens a database transaction.
 */
export async function withRlsTransaction<T, TTx extends RlsTransactionRunner = TransactionSql>(
  sql: Sql | RlsSqlClient<TTx>,
  context: RlsSessionContext,
  callback: (tx: TTx) => Promise<T> | T
): Promise<T> {
  const resolved = resolveRlsSessionContext(context);
  const client = sql as RlsSqlClient<TTx>;

  return client.begin(async (tx) => {
    await tx`SELECT
      set_config('app.current_tenant_id', ${resolved.tenantId}, true),
      set_config('app.allowed_projects', ${resolved.allowedProjectsCsv}, true),
      set_config('app.allowed_policies', ${resolved.allowedPoliciesCsv}, true)`;

    return await callback(tx);
  });
}
