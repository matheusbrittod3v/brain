import assert from "node:assert/strict";
import test from "node:test";
import {
  type AppPostgresPoolOptions,
  type RlsSessionContext,
  type RlsSqlClient,
  type RlsTransactionRunner,
  createAppPostgresClient,
  getAppDatabaseUrl,
  withRlsTransaction
} from "../index.js";

const secretPassword = "s3cr3t'App!Pass#99";
const encodedSecret = encodeURIComponent(secretPassword);
const validAppUrl = `postgresql://brain_app:${encodedSecret}@localhost:5432/project_brain_os`;
const systemUrl = "postgresql://brain_system:sys-secret@localhost:5432/project_brain_os";
const adminUrl = "postgresql://brain:admin-secret@localhost:5432/project_brain_os";

test("importing @noema/database does not open connections and exports client factories", () => {
  assert.equal(typeof getAppDatabaseUrl, "function");
  assert.equal(typeof createAppPostgresClient, "function");
});

test("requires explicit DATABASE_URL for brain_app and never falls back to system or admin URLs", () => {
  assert.throws(
    () =>
      getAppDatabaseUrl({
        DATABASE_SYSTEM_URL: systemUrl,
        DATABASE_ADMIN_URL: adminUrl
      }),
    /DATABASE_URL is required/
  );

  let factoryCalled = false;
  assert.throws(
    () =>
      createAppPostgresClient({
        env: {
          DATABASE_SYSTEM_URL: systemUrl,
          DATABASE_ADMIN_URL: adminUrl
        },
        createSql: () => {
          factoryCalled = true;
          throw new Error("should not be called");
        }
      }),
    /DATABASE_URL is required/
  );
  assert.equal(factoryCalled, false, "Driver factory must not be called when DATABASE_URL is missing");
});

test("rejects non-brain_app roles, malformed URLs, or missing passwords without leaking secrets", () => {
  const wrongRoleUrls = [
    `postgresql://brain_system:${encodedSecret}@localhost:5432/project_brain_os`,
    `postgresql://brain:${encodedSecret}@localhost:5432/project_brain_os`,
    `postgresql://postgres:${encodedSecret}@localhost:5432/project_brain_os`
  ];

  for (const badUrl of wrongRoleUrls) {
    let factoryCalled = false;
    assert.throws(
      () =>
        createAppPostgresClient({
          databaseUrl: badUrl,
          createSql: () => {
            factoryCalled = true;
            throw new Error("should not be called");
          }
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /brain_app/);
        assert.ok(!err.message.includes(secretPassword), "Must not leak raw password");
        assert.ok(!err.message.includes(encodedSecret), "Must not leak encoded password");
        return true;
      }
    );
    assert.equal(factoryCalled, false);
  }

  // Malformed URL containing secret
  assert.throws(
    () => getAppDatabaseUrl({ DATABASE_URL: `not-a-url://${secretPassword}` }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretPassword));
      return true;
    }
  );

  // Missing password
  assert.throws(
    () => getAppDatabaseUrl({ DATABASE_URL: "postgresql://brain_app@localhost:5432/project_brain_os" }),
    /non-empty password/
  );
});

test("rejects query parameter destination or identity overrides and multi-host URLs before createSql", () => {
  const overrideParams = [
    "host=/tmp/other.sock",
    "hostname=evil.internal",
    "hostaddr=10.0.0.9",
    "port=6543",
    "database=other_db",
    "dbname=other_db",
    "db=other_db",
    "user=brain_system",
    "username=postgres",
    "password=override",
    "pass=override",
    "socket=/var/run/postgresql"
  ];

  for (const queryParam of overrideParams) {
    let factoryCalled = false;
    const urlWithOverride = `${validAppUrl}?${queryParam}`;
    assert.throws(
      () =>
        createAppPostgresClient({
          databaseUrl: urlWithOverride,
          createSql: () => {
            factoryCalled = true;
            throw new Error("should not be called");
          }
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /must not use query parameter/i);
        assert.ok(!err.message.includes(secretPassword));
        assert.ok(!err.message.includes(encodedSecret));
        return true;
      },
      `Expected rejection for query override ?${queryParam}`
    );
    assert.equal(factoryCalled, false, `createSql must not be called for ?${queryParam}`);
  }
});

test("validates pool options before creating SQL client", () => {
  let factoryCalled = false;
  assert.throws(
    () =>
      createAppPostgresClient({
        databaseUrl: validAppUrl,
        maxConnections: 0,
        createSql: () => {
          factoryCalled = true;
          throw new Error("should not be called");
        }
      }),
    /maxConnections/
  );
  assert.equal(factoryCalled, false);
});

test("creates client bound to brain_app, interoperates with withRlsTransaction, and manages close lifecycle", async () => {
  const queries: Array<{ sql: string; params: readonly string[] }> = [];
  let endCalledCount = 0;
  let endTimeoutSeen: number | undefined;
  let capturedPoolOpts: AppPostgresPoolOptions | undefined;

  const mockTx: RlsTransactionRunner = async (template, ...params) => {
    queries.push({ sql: template.join("$P$"), params });
    return [];
  };

  interface MockSql extends RlsSqlClient<RlsTransactionRunner> {
    end(opts?: { timeout?: number }): Promise<void>;
  }

  const fakeSql: MockSql = {
    async begin(cb) {
      return await cb(mockTx);
    },
    async end(opts) {
      endCalledCount += 1;
      endTimeoutSeen = opts?.timeout;
    }
  };

  const client = createAppPostgresClient({
    env: { DATABASE_URL: validAppUrl },
    maxConnections: 8,
    connectTimeoutSeconds: 12,
    idleTimeoutSeconds: 45,
    createSql: (url, opts) => {
      assert.equal(url, validAppUrl);
      capturedPoolOpts = opts;
      return fakeSql;
    }
  });

  assert.equal(client.role, "brain_app");
  assert.equal(client.sql, fakeSql);
  assert.deepEqual(capturedPoolOpts, {
    max: 8,
    connect_timeout: 12,
    idle_timeout: 45
  });

  const rlsCtx: RlsSessionContext = {
    tenantId: "acme",
    allowedProjects: ["__org__", "proj-1"],
    allowedPolicies: ["public-org", "internal-project"]
  };

  // 1. Interoperates via client.withRlsTransaction(...)
  const res1 = await client.withRlsTransaction(rlsCtx, async (tx) => {
    assert.equal(tx, mockTx);
    await tx`SELECT 1`;
    return "ok-1";
  });
  assert.equal(res1, "ok-1");
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0]!.params, ["acme", "__org__,proj-1", "public-org,internal-project"]);

  // 2. Interoperates directly with standalone withRlsTransaction(client.sql, ...)
  const res2 = await withRlsTransaction(client.sql, rlsCtx, async (tx) => {
    assert.equal(tx, mockTx);
    return "ok-2";
  });
  assert.equal(res2, "ok-2");

  // 3. Close lifecycle is idempotent and prevents subsequent transactions
  await client.close({ timeoutSeconds: 3 });
  await client.close({ timeoutSeconds: 3 });
  assert.equal(endCalledCount, 1);
  assert.equal(endTimeoutSeen, 3);

  await assert.rejects(
    () => client.withRlsTransaction(rlsCtx, async () => "should-not-run"),
    /already closed/
  );
});

test("redacts credentials from initialization, transaction, and close errors", async () => {
  // 1. Initialization error containing raw URL and password
  assert.throws(
    () =>
      createAppPostgresClient({
        databaseUrl: validAppUrl,
        createSql: (url) => {
          throw new Error(`Driver init failed for ${url} with pass ${secretPassword}`);
        }
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretPassword), "Init error must redact raw password");
      assert.ok(!err.message.includes(encodedSecret), "Init error must redact encoded password");
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    }
  );

  // 2. Transaction & close errors containing credentials
  const failingClient = createAppPostgresClient({
    databaseUrl: validAppUrl,
    createSql: () => ({
      async begin() {
        throw new Error(`Connection refused to ${validAppUrl} (password=${secretPassword})`);
      },
      async end() {
        throw new Error(`Socket close error for ${validAppUrl}`);
      }
    })
  });

  await assert.rejects(
    () =>
      failingClient.withRlsTransaction(
        {
          tenantId: "acme",
          allowedProjects: ["proj-1"],
          allowedPolicies: ["internal-project"]
        },
        async () => "unreachable"
      ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretPassword));
      assert.ok(!err.message.includes(encodedSecret));
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    }
  );

  await assert.rejects(
    () => failingClient.close(),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!err.message.includes(secretPassword));
      assert.ok(!err.message.includes(encodedSecret));
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    }
  );
});
