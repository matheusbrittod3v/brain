import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { RoleBootstrapConfig } from "../bootstrap-roles.js";
import {
  buildRoleBootstrapPlan,
  compileRoleCommand,
  getMigrationDatabaseUrl,
  bootstrapDatabaseRolesFromEnv,
  readRoleBootstrapConfig
} from "../bootstrap-roles.js";

const packageRoot = new URL("../../", import.meta.url);

function baselineMigrationSql(): string {
  const journal = JSON.parse(
    readFileSync(new URL("drizzle/meta/_journal.json", packageRoot), "utf8")
  ) as { entries: { tag: string }[] };
  return readFileSync(new URL(`drizzle/${journal.entries[0]!.tag}.sql`, packageRoot), "utf8");
}

function latestMigrationSql(): string {
  const journal = JSON.parse(
    readFileSync(new URL("drizzle/meta/_journal.json", packageRoot), "utf8")
  ) as { entries: { tag: string }[] };
  const latest = journal.entries.at(-1);
  assert.ok(latest, "drizzle journal must contain at least one migration");
  return readFileSync(new URL(`drizzle/${latest.tag}.sql`, packageRoot), "utf8");
}

const appPassword = "app p'ass; --word $\\";
const systemPassword = "system\"quoted' secret;";
const validEnv = {
  DATABASE_ADMIN_URL: "postgresql://admin:admin-secret@localhost:5432/project_brain_os",
  DATABASE_SYSTEM_URL: `postgresql://brain_system:${encodeURIComponent(systemPassword)}@localhost:5432/project_brain_os`,
  DATABASE_URL: `postgresql://brain_app:${encodeURIComponent(appPassword)}@localhost:5432/project_brain_os`,
  BRAIN_APP_DB_PASSWORD: appPassword,
  BRAIN_SYSTEM_DB_PASSWORD: systemPassword
};

test("requires every role-bootstrap credential before attempting connections", () => {
  for (const key of Object.keys(validEnv)) {
    const env = { ...validEnv, [key]: "   " };
    assert.throws(() => readRoleBootstrapConfig(env), new RegExp(key));
  }
});

test("does not invoke provisioning when required environment values are missing", async () => {
  let provisionCalled = false;
  await assert.rejects(
    bootstrapDatabaseRolesFromEnv({}, async () => { provisionCalled = true; }),
    /DATABASE_ADMIN_URL/
  );
  assert.equal(provisionCalled, false);
});

test("requires the system URL for migrations and never falls back to the app URL", () => {
  assert.throws(() => getMigrationDatabaseUrl({ DATABASE_URL: validEnv.DATABASE_URL }), /DATABASE_SYSTEM_URL/);
  assert.equal(getMigrationDatabaseUrl({ DATABASE_SYSTEM_URL: validEnv.DATABASE_SYSTEM_URL }), validEnv.DATABASE_SYSTEM_URL);
});

test("rejects local URLs that use the wrong role or password", () => {
  assert.throws(() => readRoleBootstrapConfig({ ...validEnv, DATABASE_URL: validEnv.DATABASE_SYSTEM_URL }), /brain_app/);
  assert.throws(() => readRoleBootstrapConfig({ ...validEnv, DATABASE_SYSTEM_URL: "postgresql://brain_system:wrong@localhost:5432/project_brain_os" }), /must match/);
});

test("requires admin, system, and app URLs to resolve to one normalized database destination", () => {
  const mismatchedDestinations = [
    { DATABASE_ADMIN_URL: "postgresql://admin:admin-secret@admin-host:5432/project_brain_os" },
    { DATABASE_SYSTEM_URL: validEnv.DATABASE_SYSTEM_URL.replace(":5432/", ":5433/") },
    { DATABASE_URL: validEnv.DATABASE_URL.replace("/project_brain_os", "/another_database") }
  ];

  for (const override of mismatchedDestinations) {
    assert.throws(() => readRoleBootstrapConfig({ ...validEnv, ...override }), /same database destination/i);
  }
});

test("rejects query parameters that can override validated connection identity or destination", () => {
  for (const override of ["host=elsewhere", "port=5544", "dbname=other_db", "user=postgres"]) {
    const env = { ...validEnv, DATABASE_URL: `${validEnv.DATABASE_URL}?${override}` };
    assert.throws(() => readRoleBootstrapConfig(env), /query parameter.*override/i);
  }
});

test("normalizes host case, trailing dot, and default port before comparing destinations", () => {
  const env = {
    ...validEnv,
    DATABASE_ADMIN_URL: "postgresql://admin:admin-secret@LOCALHOST./project_brain_os",
    DATABASE_SYSTEM_URL: `postgresql://brain_system:${encodeURIComponent(systemPassword)}@localhost:5432/project_brain_os`,
    DATABASE_URL: `postgresql://brain_app:${encodeURIComponent(appPassword)}@localhost:5432/project_brain_os`
  };

  assert.equal(readRoleBootstrapConfig(env).appUrl, env.DATABASE_URL);
});

test("does not treat percent-encoded database paths as the same destination", () => {
  const env = {
    ...validEnv,
    DATABASE_URL: `postgresql://brain_app:${encodeURIComponent(appPassword)}@localhost:5432/project%5Fbrain_os`
  };
  assert.throws(() => readRoleBootstrapConfig(env), /same database destination/i);
});

test("validates the Docker admin password only when that optional variable is supplied", () => {
  assert.doesNotThrow(() => readRoleBootstrapConfig(validEnv));
  assert.doesNotThrow(() => readRoleBootstrapConfig({ ...validEnv, POSTGRES_ADMIN_PASSWORD: "admin-secret" }));
  assert.throws(
    () => readRoleBootstrapConfig({ ...validEnv, POSTGRES_ADMIN_PASSWORD: "different-secret" }),
    /POSTGRES_ADMIN_PASSWORD.*DATABASE_ADMIN_URL/i
  );
  assert.throws(
    () => readRoleBootstrapConfig({ ...validEnv, POSTGRES_ADMIN_PASSWORD: "   " }),
    /POSTGRES_ADMIN_PASSWORD/
  );
});

test("preflight fails on a brain_app RLS escape path and never emits role-changing SQL", async () => {
  const capturedQueries: string[] = [];
  const fakeAdmin = (async (strings: TemplateStringsArray) => {
    capturedQueries.push(strings.join(" "));
    return [{ unsafe: true }];
  }) as never;
  const bootstrapModule = await import("../bootstrap-roles.js") as unknown as Record<string, unknown>;
  const preflight = bootstrapModule.assertBrainAppRlsSafe as ((admin: never) => Promise<void>) | undefined;

  assert.equal(typeof preflight, "function", "bootstrap must expose its database-backed read-only preflight");
  await assert.rejects(preflight!(fakeAdmin), /pre-existing brain_app role state.*manually/i);
  assert.equal(capturedQueries.length, 1);
  assert.match(capturedQueries[0]!, /pg_has_role/);
  assert.match(capturedQueries[0]!, /'SET'/, "BYPASSRLS is only reachable through a permitted SET ROLE path");
  assert.match(capturedQueries[0]!, /'USAGE'/, "inherited ownership privileges must be inspected separately");
  assert.doesNotMatch(capturedQueries[0]!, /CREATE ROLE|ALTER ROLE|GRANT |REVOKE /i);
});

test("preflight rejects executable SECURITY DEFINER functions owned by privileged roles", async () => {
  const capturedQueries: string[] = [];
  const fakeAdmin = (async (strings: TemplateStringsArray) => {
    capturedQueries.push(strings.join(" "));
    return [{ unsafe: true }];
  }) as never;
  const bootstrapModule = await import("../bootstrap-roles.js") as unknown as Record<string, unknown>;
  const preflight = bootstrapModule.assertBrainAppRlsSafe as ((admin: never) => Promise<void>) | undefined;

  assert.equal(typeof preflight, "function");
  await assert.rejects(preflight!(fakeAdmin), /SECURITY DEFINER.*EXECUTE/i);
  assert.match(capturedQueries[0]!, /pg_catalog\.pg_proc/);
  assert.match(capturedQueries[0]!, /prosecdef/);
  assert.match(capturedQueries[0]!, /function_owner\.rolsuper\s+OR\s+function_owner\.rolbypassrls/);
  assert.match(capturedQueries[0]!, /has_function_privilege\([\s\S]*'brain_app',[\s\S]*'EXECUTE'\s*\)/);
  assert.doesNotMatch(capturedQueries[0]!, /CREATE ROLE|ALTER ROLE|GRANT |REVOKE |ALTER FUNCTION/i);
});

test("preflight treats INHERIT without SET as distinct from the ability to SET ROLE into BYPASSRLS", async () => {
  const capturedQueries: string[] = [];
  const fakeAdmin = (async (strings: TemplateStringsArray) => {
    capturedQueries.push(strings.join(" "));
    return [{ unsafe: false }];
  }) as never;
  const bootstrapModule = await import("../bootstrap-roles.js") as unknown as Record<string, unknown>;
  const preflight = bootstrapModule.assertBrainAppRlsSafe as ((admin: never) => Promise<void>) | undefined;

  assert.equal(typeof preflight, "function");
  await preflight!(fakeAdmin);
  assert.match(capturedQueries[0]!, /bypass_role\.rolbypassrls[\s\S]*pg_has_role\(app\.oid, bypass_role\.oid, 'SET'\)/);
  assert.doesNotMatch(capturedQueries[0]!, /pg_has_role\(app\.oid, bypass_role\.oid, 'USAGE'\)/);
});

test("bootstrap runs the read-only role preflight before connecting as system or changing roles", async () => {
  const config = readRoleBootstrapConfig(validEnv);
  const connections: string[] = [];
  const reads: string[] = [];
  const mutations: string[] = [];
  const fakeAdmin = (async (strings: TemplateStringsArray) => {
    reads.push(strings.join(" "));
    return [{ unsafe: true }];
  }) as unknown as { (...args: unknown[]): Promise<unknown[]>; unsafe(sql: string): Promise<unknown>; end(): Promise<void> };
  fakeAdmin.unsafe = async (sql: string) => { mutations.push(sql); return []; };
  fakeAdmin.end = async () => {};
  const createClient = ((url: string) => {
    connections.push(url);
    return fakeAdmin;
  }) as never;
  const bootstrapModule = await import("../bootstrap-roles.js") as unknown as Record<string, unknown>;
  const bootstrapWithFactory = bootstrapModule.bootstrapDatabaseRolesWithClientFactory as (
    config: RoleBootstrapConfig,
    createClient: never
  ) => Promise<void>;

  assert.equal(typeof bootstrapWithFactory, "function", "bootstrap must support a testable connection factory");
  await assert.rejects(bootstrapWithFactory(config, createClient), /pre-existing brain_app role state.*manually/i);
  assert.deepEqual(connections, [config.adminUrl], "a rejected app role must not open the system connection");
  assert.equal(reads.length, 1, "only the read-only preflight may run before rejection");
  assert.deepEqual(mutations, [], "unsafe legacy memberships or ownership must never be altered automatically");
});

test("direct bootstrap configuration mismatches fail before opening any connection", async () => {
  const config = readRoleBootstrapConfig(validEnv);
  const mismatchedConfig = {
    ...config,
    adminUrl: config.adminUrl.replace("localhost", "admin-alias")
  };
  let connectionAttempts = 0;
  const bootstrapModule = await import("../bootstrap-roles.js") as unknown as Record<string, unknown>;
  const bootstrapWithFactory = bootstrapModule.bootstrapDatabaseRolesWithClientFactory as (
    config: RoleBootstrapConfig,
    createClient: never
  ) => Promise<void>;

  await assert.rejects(
    bootstrapWithFactory(mismatchedConfig, (() => { connectionAttempts += 1; throw new Error("unexpected connection"); }) as never),
    /same database destination/i
  );
  assert.equal(connectionAttempts, 0);
});

test("plans isolated login roles and safe pre-migration defaults", () => {
  const config = readRoleBootstrapConfig(validEnv);
  const plan = buildRoleBootstrapPlan(config);

  const appAttributes = plan.roles.find((role) => role.name === "brain_app")!.attributes;
  const systemAttributes = plan.roles.find((role) => role.name === "brain_system")!.attributes;
  assert.ok(appAttributes.includes("LOGIN") && appAttributes.includes("NOSUPERUSER") && appAttributes.includes("NOBYPASSRLS"));
  assert.ok(systemAttributes.includes("LOGIN") && systemAttributes.includes("NOSUPERUSER") && systemAttributes.includes("BYPASSRLS"));
  assert.deepEqual(plan.extensions, ["pgcrypto", "vector"]);
  assert.ok(plan.grants.every((sql) => !/^(?:GRANT|REVOKE).*ON (?:ALL )?TABLES?\b/i.test(sql)));
  assert.ok(plan.grants.some((sql) => /ALTER DEFAULT PRIVILEGES FOR ROLE brain_system IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO brain_app/.test(sql)));
  assert.ok(plan.grants.every((sql) => !/ALTER DEFAULT PRIVILEGES[\s\S]*\bUPDATE\b|ALTER DEFAULT PRIVILEGES[\s\S]*\bDELETE\b/i.test(sql)));
  assert.ok(plan.roles.every((role) => !role.createSql.includes(role.password)));
});

test("migration grants current-table DML while keeping audit_logs append-only", () => {
  const canonical = readFileSync(new URL("../../src/rls-and-indexes.sql", import.meta.url), "utf8");
  const migration = baselineMigrationSql();
  for (const sql of [canonical, migration]) {
    assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.organizations[\s\S]*public\.knowledge_relations TO brain_app;/);
    assert.match(sql, /REVOKE UPDATE, DELETE ON TABLE public\.audit_logs FROM brain_app;/);
    assert.match(sql, /GRANT SELECT, INSERT ON TABLE public\.audit_logs TO brain_app;/);
    assert.doesNotMatch(sql, /ALTER DEFAULT PRIVILEGES[\s\S]*\bUPDATE\b|ALTER DEFAULT PRIVILEGES[\s\S]*\bDELETE\b/);
  }
});

test("baseline migration contains a single copy of each policy, index and grant", () => {
  const migration = baselineMigrationSql();
  const count = (pattern: RegExp) => migration.match(pattern)?.length ?? 0;
  assert.equal(count(/CREATE POLICY org_tenant_policy/g), 1);
  assert.equal(count(/CREATE POLICY ki_tenant_policy/g), 1);
  assert.equal(count(/CREATE POLICY kiv_tenant_policy/g), 1);
  assert.equal(count(/CREATE POLICY ke_tenant_policy/g), 1);
  assert.equal(count(/CREATE POLICY kr_tenant_policy/g), 1);
  assert.equal(count(/CREATE POLICY audit_tenant_policy/g), 1);
  assert.equal(count(/CREATE POLICY project_tenant_policy/g), 1);
  assert.equal(count(/CREATE INDEX IF NOT EXISTS idx_ki_tags/g), 1);
  assert.equal(count(/CREATE INDEX IF NOT EXISTS idx_ke_policy/g), 1);
  assert.equal(count(/GRANT SELECT, INSERT ON TABLE public\.audit_logs TO brain_app;/g), 1);
  assert.equal(count(/REVOKE UPDATE, DELETE ON TABLE public\.audit_logs FROM brain_app;/g), 1);
});

test("drizzle-kit generate works offline without DATABASE_SYSTEM_URL and without schema drift", () => {
  const drizzleDir = new URL("drizzle/", packageRoot);
  const metaDir = new URL("drizzle/meta/", packageRoot);
  const beforeDrizzle = readdirSync(drizzleDir);
  const beforeMeta = readdirSync(metaDir);
  const env = { PATH: process.env.PATH ?? "" };
  const drizzleKitBin = fileURLToPath(
    new URL("../../node_modules/.bin/drizzle-kit", packageRoot)
  );
  let output = "";
  let error: unknown;
  try {
    output = execFileSync(drizzleKitBin, ["generate"], {
      cwd: fileURLToPath(packageRoot),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (caught) {
    error = caught;
  } finally {
    for (const created of readdirSync(drizzleDir).filter((name) => !beforeDrizzle.includes(name))) {
      rmSync(new URL(`drizzle/${created}`, packageRoot), { recursive: true, force: true });
    }
    for (const created of readdirSync(metaDir).filter((name) => !beforeMeta.includes(name))) {
      rmSync(new URL(`drizzle/meta/${created}`, packageRoot), { recursive: true, force: true });
    }
  }
  assert.ifError(error);
  assert.match(output, /No schema changes/i);
});

test("compiles password commands only from a separately escaped SQL literal", () => {
  const config = readRoleBootstrapConfig(validEnv);
  const role = buildRoleBootstrapPlan(config).roles[0]!;
  const escapedLiteral = "'app p''ass; --word $\\\\'";
  const command = compileRoleCommand(role, escapedLiteral, false);

  assert.ok(command.endsWith(`PASSWORD ${escapedLiteral}`));
  assert.ok(!command.includes(role.password));
});
