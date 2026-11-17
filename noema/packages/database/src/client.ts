import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema.js";
import type { AuthContext } from "@noema/auth";
import { BrainError } from "@noema/core";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type RlsSessionContext,
  type RlsSqlClient,
  type RlsTransactionRunner
} from "./rls-context.js";

export type NoemaDb = ReturnType<typeof drizzle<typeof schema>>;

export interface AppPostgresPoolOptions {
  max?: number;
  connect_timeout?: number;
  idle_timeout?: number;
}

export type CloseableRlsSqlClient<TTx extends RlsTransactionRunner = RlsTransactionRunner> =
  RlsSqlClient<TTx> & {
    end?: (opts?: { timeout?: number }) => Promise<unknown>;
  };

export interface AppPostgresClientOptions<
  TTx extends RlsTransactionRunner = RlsTransactionRunner,
  TSql extends CloseableRlsSqlClient<TTx> = CloseableRlsSqlClient<TTx>
> {
  env?: NodeJS.ProcessEnv;
  databaseUrl?: string;
  maxConnections?: number;
  connectTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
  createSql?: (url: string, opts: AppPostgresPoolOptions) => TSql;
}

export interface AppPostgresClient<
  TTx extends RlsTransactionRunner = RlsTransactionRunner,
  TSql extends CloseableRlsSqlClient<TTx> = CloseableRlsSqlClient<TTx>
> {
  readonly role: "brain_app";
  readonly sql: TSql;
  withRlsTransaction<T>(context: RlsSessionContext, callback: (tx: TTx) => Promise<T> | T): Promise<T>;
  close(opts?: { timeoutSeconds?: number }): Promise<void>;
}

function redactCredentials(message: string, secret?: string): string {
  let out = message.replace(/(postgres(?:ql)?:\/\/[^:\s]+:)([^@\s]+)(@)/gi, "$1[REDACTED]$3");
  if (secret && secret.length > 0) {
    out = out.split(secret).join("[REDACTED]");
    out = out.split(encodeURIComponent(secret)).join("[REDACTED]");
  }
  return out;
}

export function getAppDatabaseUrl(env: NodeJS.ProcessEnv = process.env, explicitUrl?: string): string {
  const url = (explicitUrl ?? env.DATABASE_URL)?.trim();
  if (!url) {
    throw new Error("DATABASE_URL is required for brain_app.");
  }
  const parsed = new URL(url);
  if (parsed.username && parsed.username !== "brain_app") {
    throw new Error(`DATABASE_URL must use role 'brain_app', got '${parsed.username}'.`);
  }
  return url;
}

export function createAppPostgresClient<
  TTx extends RlsTransactionRunner = RlsTransactionRunner,
  TSql extends CloseableRlsSqlClient<TTx> = CloseableRlsSqlClient<TTx>
>(opts: AppPostgresClientOptions<TTx, TSql> = {}): AppPostgresClient<TTx, TSql> {
  const url = getAppDatabaseUrl(opts.env, opts.databaseUrl);
  const parsedPassword = decodeURIComponent(new URL(url).password ?? "");
  const poolOpts: AppPostgresPoolOptions = {
    max: opts.maxConnections ?? 10,
    connect_timeout: opts.connectTimeoutSeconds ?? 10,
    idle_timeout: opts.idleTimeoutSeconds ?? 30
  };
  const sqlClient = opts.createSql
    ? opts.createSql(url, poolOpts)
    : (postgres(url, poolOpts) as unknown as TSql);

  let closed = false;

  return {
    role: "brain_app",
    sql: sqlClient,
    async withRlsTransaction<T>(context: RlsSessionContext, callback: (tx: TTx) => Promise<T> | T): Promise<T> {
      if (closed) {
        throw new Error("Application PostgreSQL client is already closed.");
      }
      try {
        return await withRlsTransaction(sqlClient, context, callback);
      } catch (err) {
        if (err instanceof BrainError) {
          throw new BrainError(err.code, redactCredentials(err.message, parsedPassword), err.statusCode);
        }
        if (err instanceof Error) {
          throw new Error(redactCredentials(err.message, parsedPassword), { cause: err });
        }
        throw new Error(redactCredentials(String(err), parsedPassword));
      }
    },
    async close(closeOpts?: { timeoutSeconds?: number }): Promise<void> {
      if (closed) return;
      closed = true;
      if (typeof sqlClient.end === "function") {
        await sqlClient.end({ timeout: closeOpts?.timeoutSeconds ?? 5 });
      }
    }
  };
}

export function createDatabaseClient(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_URL não configurada.");
  }
  const client: Sql = postgres(connectionString);
  const db = drizzle(client, { schema });
  return { client, db };
}

/**
 * Executa qualquer operação dentro de uma transação Drizzle com variáveis de sessão RLS.
 */
export async function withTenantRls<T>(
  db: NoemaDb,
  ctx: AuthContext,
  fn: (tx: NoemaDb) => Promise<T>
): Promise<T> {
  const resolved = resolveRlsSessionContext({
    tenantId: ctx.tenantId,
    allowedProjects: ctx.allowedProjects,
    allowedPolicies: ctx.allowedPolicies
  });
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT
      set_config('app.current_tenant_id', ${resolved.tenantId}, true),
      set_config('app.allowed_projects', ${resolved.allowedProjectsCsv}, true),
      set_config('app.allowed_policies', ${resolved.allowedPoliciesCsv}, true)`);
    return fn(tx as unknown as NoemaDb);
  });
}
