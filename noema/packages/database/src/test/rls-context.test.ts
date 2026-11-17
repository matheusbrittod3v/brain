import assert from "node:assert/strict";
import test from "node:test";
import {
  type RlsSessionContext,
  type RlsSqlClient,
  type RlsTransactionRunner,
  organizations,
  knowledgeItems,
  auditLogs,
  resolveRlsSessionContext,
  withRlsTransaction
} from "../index.js";

const validContext: RlsSessionContext = {
  tenantId: "acme-corp",
  allowedProjects: ["__org__", "billing-service", "billing-service"],
  allowedPolicies: ["public-org", "internal-project", "public-org"]
};

test("index re-exports Drizzle schema tables alongside RLS helpers", () => {
  assert.ok(organizations);
  assert.ok(knowledgeItems);
  assert.ok(auditLogs);
  assert.equal(typeof resolveRlsSessionContext, "function");
  assert.equal(typeof withRlsTransaction, "function");
});

test("resolveRlsSessionContext normalizes, deduplicates, and formats CSV GUC values", () => {
  const resolved = resolveRlsSessionContext({
    tenantId: "  acme-corp  ",
    allowedProjects: [" __org__ ", "sub-api", "__org__"],
    allowedPolicies: [" public-org ", "internal-project"]
  });

  assert.equal(resolved.tenantId, "acme-corp");
  assert.equal(resolved.allowedProjectsCsv, "__org__,sub-api");
  assert.equal(resolved.allowedPoliciesCsv, "public-org,internal-project");
  assert.deepEqual(resolved.gucs, {
    "app.current_tenant_id": "acme-corp",
    "app.allowed_projects": "__org__,sub-api",
    "app.allowed_policies": "public-org,internal-project"
  });
});

test("invalid RlsSessionContext is rejected and never opens a transaction", async () => {
  const invalidContexts: Array<{ label: string; ctx: RlsSessionContext; match: RegExp }> = [
    {
      label: "empty tenantId",
      ctx: { ...validContext, tenantId: "   " },
      match: /tenantId/
    },
    {
      label: "wildcard tenantId",
      ctx: { ...validContext, tenantId: "*" },
      match: /wildcard/
    },
    {
      label: "comma in tenantId",
      ctx: { ...validContext, tenantId: "acme,evil" },
      match: /tenantId/
    },
    {
      label: "empty allowedProjects array",
      ctx: { ...validContext, allowedProjects: [] },
      match: /allowedProjects/
    },
    {
      label: "wildcard in allowedProjects",
      ctx: { ...validContext, allowedProjects: ["*"] },
      match: /wildcard/
    },
    {
      label: "comma injection in allowedProjects",
      ctx: { ...validContext, allowedProjects: ["proj-a,proj-b"] },
      match: /allowedProjects\[0\]/
    },
    {
      label: "null byte in allowedPolicies",
      ctx: { ...validContext, allowedPolicies: ["public\0evil"] },
      match: /allowedPolicies\[0\]/
    },
    {
      label: "empty allowedPolicies array",
      ctx: { ...validContext, allowedPolicies: [] },
      match: /allowedPolicies/
    }
  ];

  for (const { label, ctx, match } of invalidContexts) {
    let beginCalled = false;
    let callbackCalled = false;
    const fakeSql: RlsSqlClient = {
      async begin() {
        beginCalled = true;
        throw new Error("begin should not be called");
      }
    };

    await assert.rejects(
      () =>
        withRlsTransaction(fakeSql, ctx, () => {
          callbackCalled = true;
        }),
      match,
      `Expected rejection for ${label}`
    );
    assert.equal(beginCalled, false, `sql.begin must not be called for ${label}`);
    assert.equal(callbackCalled, false, `callback must not be called for ${label}`);
  }
});

test("withRlsTransaction binds the 3 GUC parameters separately from SQL and passes the same tx to callback after setting GUCs", async () => {
  const events: string[] = [];
  const recordedQueries: Array<{ strings: readonly string[]; params: readonly unknown[] }> = [];

  const mockTx: RlsTransactionRunner = async (template, ...parameters) => {
    events.push(`query:${recordedQueries.length}`);
    recordedQueries.push({ strings: [...template], params: parameters });
    return [];
  };

  let beginCount = 0;
  const fakeSql: RlsSqlClient<RlsTransactionRunner> = {
    async begin(cb) {
      beginCount += 1;
      events.push("begin");
      return await cb(mockTx);
    }
  };

  const sneakyContext: RlsSessionContext = {
    tenantId: "tenant' OR '1'='1",
    allowedProjects: ["__org__", "proj'--;"],
    allowedPolicies: ["internal-project", "restricted'policy"]
  };

  const result = await withRlsTransaction(fakeSql, sneakyContext, async (tx, ...extraArgs: unknown[]) => {
    events.push("callback");
    assert.equal(tx, mockTx, "Callback must receive the exact transaction object");
    assert.equal(extraArgs.length, 0, "Callback must receive only tx");
    assert.equal(recordedQueries.length, 1, "All 3 GUCs must already be set before callback runs");

    await tx`SELECT 1`;
    return "tx-complete";
  });

  assert.equal(result, "tx-complete");
  assert.equal(beginCount, 1);
  assert.deepEqual(events, ["begin", "query:0", "callback", "query:1"]);

  const gucQuery = recordedQueries[0]!;
  const rawSqlTemplate = gucQuery.strings.join("$PARAM$");
  assert.match(rawSqlTemplate, /set_config\('app\.current_tenant_id',\s*\$PARAM\$,\s*true\)/);
  assert.match(rawSqlTemplate, /set_config\('app\.allowed_projects',\s*\$PARAM\$,\s*true\)/);
  assert.match(rawSqlTemplate, /set_config\('app\.allowed_policies',\s*\$PARAM\$,\s*true\)/);

  // Parameters must be bound separately, never interpolated into the SQL template string
  assert.ok(!rawSqlTemplate.includes(sneakyContext.tenantId));
  assert.ok(!rawSqlTemplate.includes("proj'--;"));
  assert.ok(!rawSqlTemplate.includes("restricted'policy"));
  assert.deepEqual(gucQuery.params, [
    "tenant' OR '1'='1",
    "__org__,proj'--;",
    "internal-project,restricted'policy"
  ]);
});

test("withRlsTransaction propagates errors from set_config or callback", async () => {
  const callbackError = new Error("domain failure inside transaction");
  const mockTx: RlsTransactionRunner = async () => [];
  const fakeSql: RlsSqlClient<RlsTransactionRunner> = {
    async begin(cb) {
      return await cb(mockTx);
    }
  };

  await assert.rejects(
    () =>
      withRlsTransaction(fakeSql, validContext, async () => {
        throw callbackError;
      }),
    (err) => err === callbackError
  );

  const gucError = new Error("set_config failed on connection");
  const failingTx: RlsTransactionRunner = async () => {
    throw gucError;
  };
  let callbackRan = false;
  const failingSql: RlsSqlClient<RlsTransactionRunner> = {
    async begin(cb) {
      return await cb(failingTx);
    }
  };

  await assert.rejects(
    () =>
      withRlsTransaction(failingSql, validContext, () => {
        callbackRan = true;
      }),
    (err) => err === gucError
  );
  assert.equal(callbackRan, false, "Callback must not run if setting GUCs fails");
});
