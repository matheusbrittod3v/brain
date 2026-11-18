import { config as loadDotEnv } from "dotenv";
import postgres, { type Sql } from "postgres";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface RoleBootstrapConfig {
  adminUrl: string;
  systemUrl: string;
  appUrl: string;
  appPassword: string;
  systemPassword: string;
}

export interface RolePlan {
  name: "brain_app" | "brain_system";
  password: string;
  attributes: string;
  createSql: string;
  alterSql: string;
}

export interface RoleBootstrapPlan {
  roles: RolePlan[];
  extensions: ["pgcrypto", "vector"];
  grants: string[];
}

export type RoleBootstrapClientFactory = (
  url: string,
  options: { max: number; connect_timeout: number }
) => Sql;

export function getMigrationDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const value = env.DATABASE_SYSTEM_URL?.trim();
  if (!value) throw new Error("DATABASE_SYSTEM_URL is required for Drizzle migrations; DATABASE_URL is reserved for the brain_app role.");
  validateDatabaseUrl(value, "DATABASE_SYSTEM_URL", "brain_system");
  return value;
}

const requiredEnvironment = [
  "DATABASE_ADMIN_URL",
  "DATABASE_SYSTEM_URL",
  "DATABASE_URL",
  "BRAIN_APP_DB_PASSWORD",
  "BRAIN_SYSTEM_DB_PASSWORD"
] as const;

function requiredValue(env: NodeJS.ProcessEnv, key: (typeof requiredEnvironment)[number]): string {
  const value = env[key]?.trim();
  if (!value || value.includes("\0")) throw new Error(`${key} must be set to a non-empty value.`);
  return value;
}

function validateDatabaseUrl(value: string, key: string, expectedUser?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${key} must be a valid PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${key} must use the postgres or postgresql scheme.`);
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error(`${key} must include a host and database name.`);
  }
  if (parsed.hostname.includes(",") || parsed.host.includes(",")) {
    throw new Error(`${key} must specify one host; multi-host URLs cannot be compared safely.`);
  }
  const destinationOverrides = new Set([
    "host", "hostname", "hostaddr", "port", "database", "dbname", "db", "user", "username", "password", "pass", "socket"
  ]);
  for (const parameter of parsed.searchParams.keys()) {
    if (destinationOverrides.has(parameter.toLowerCase())) {
      throw new Error(`${key} must not use query parameter '${parameter}' to override validated connection identity or destination.`);
    }
  }
  if (expectedUser && decodeUrlPart(parsed.username, key, "username") !== expectedUser) {
    throw new Error(`${key} must connect as ${expectedUser}.`);
  }
  return parsed;
}

function decodeUrlPart(value: string, key: string, part: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${key} has an invalid encoded ${part}.`);
  }
}

function normalizedDestination(url: URL, key: string): { host: string; port: number; database: string } {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // postgres.js uses URL.pathname.slice(1) directly as the startup database name;
  // do not decode percent escapes and accidentally equate two different destinations.
  const database = url.pathname.slice(1);
  if (!host || !database) throw new Error(`${key} must include a host and database name.`);
  return { host, port: Number(url.port || 5432), database };
}

function validateRoleBootstrapConfig(config: RoleBootstrapConfig): void {
  const adminUrl = validateDatabaseUrl(config.adminUrl, "DATABASE_ADMIN_URL");
  const systemUrl = validateDatabaseUrl(config.systemUrl, "DATABASE_SYSTEM_URL", "brain_system");
  const appUrl = validateDatabaseUrl(config.appUrl, "DATABASE_URL", "brain_app");

  if (!config.appPassword.trim() || !config.systemPassword.trim()) {
    throw new Error("BRAIN_APP_DB_PASSWORD and BRAIN_SYSTEM_DB_PASSWORD must be non-empty values.");
  }
  if (decodeUrlPart(systemUrl.password, "DATABASE_SYSTEM_URL", "password") !== config.systemPassword) {
    throw new Error("DATABASE_SYSTEM_URL password must match BRAIN_SYSTEM_DB_PASSWORD.");
  }
  if (decodeUrlPart(appUrl.password, "DATABASE_URL", "password") !== config.appPassword) {
    throw new Error("DATABASE_URL password must match BRAIN_APP_DB_PASSWORD.");
  }

  const destinations = [
    normalizedDestination(adminUrl, "DATABASE_ADMIN_URL"),
    normalizedDestination(systemUrl, "DATABASE_SYSTEM_URL"),
    normalizedDestination(appUrl, "DATABASE_URL")
  ];
  if (destinations.some((destination) =>
    destination.host !== destinations[0]!.host ||
    destination.port !== destinations[0]!.port ||
    destination.database !== destinations[0]!.database
  )) {
    throw new Error("DATABASE_ADMIN_URL, DATABASE_SYSTEM_URL, and DATABASE_URL must target the same database destination.");
  }
}

export function readRoleBootstrapConfig(env: NodeJS.ProcessEnv): RoleBootstrapConfig {
  const values = Object.fromEntries(requiredEnvironment.map((key) => [key, requiredValue(env, key)])) as Record<(typeof requiredEnvironment)[number], string>;
  const config: RoleBootstrapConfig = {
    adminUrl: values.DATABASE_ADMIN_URL,
    systemUrl: getMigrationDatabaseUrl(env),
    appUrl: values.DATABASE_URL,
    appPassword: values.BRAIN_APP_DB_PASSWORD,
    systemPassword: values.BRAIN_SYSTEM_DB_PASSWORD
  };
  validateRoleBootstrapConfig(config);

  if (env.POSTGRES_ADMIN_PASSWORD !== undefined) {
    const dockerAdminPassword = env.POSTGRES_ADMIN_PASSWORD.trim();
    if (!dockerAdminPassword) throw new Error("POSTGRES_ADMIN_PASSWORD must be non-empty when supplied.");
    const adminUrl = validateDatabaseUrl(config.adminUrl, "DATABASE_ADMIN_URL");
    if (decodeUrlPart(adminUrl.password, "DATABASE_ADMIN_URL", "password") !== dockerAdminPassword) {
      throw new Error("POSTGRES_ADMIN_PASSWORD must match the DATABASE_ADMIN_URL password.");
    }
  }
  return config;
}

export function buildRoleBootstrapPlan(config: RoleBootstrapConfig): RoleBootstrapPlan {
  const appAttributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";
  const systemAttributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS";
  const role = (name: RolePlan["name"], password: string, attributes: string): RolePlan => ({
    name,
    password,
    attributes,
    createSql: `CREATE ROLE "${name}" WITH ${attributes} PASSWORD`,
    alterSql: `ALTER ROLE "${name}" WITH ${attributes} PASSWORD`
  });
  return {
    roles: [
      role("brain_app", config.appPassword, appAttributes),
      role("brain_system", config.systemPassword, systemAttributes)
    ],
    extensions: ["pgcrypto", "vector"],
    grants: [
      "ALTER DEFAULT PRIVILEGES FOR ROLE brain_system IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO brain_app"
    ]
  };
}

export function compileRoleCommand(role: RolePlan, escapedPasswordLiteral: string, exists: boolean): string {
  if (!escapedPasswordLiteral.startsWith("'") || !escapedPasswordLiteral.endsWith("'")) {
    throw new Error("Role password must be a database-escaped SQL literal.");
  }
  return `${exists ? role.alterSql : role.createSql} ${escapedPasswordLiteral}`;
}

export async function assertBrainAppRlsSafe(admin: Sql): Promise<void> {
  const [{ unsafe }] = await admin<{ unsafe: boolean }[]>`
    /* Read-only preflight for pre-existing brain_app role escape paths. */
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS app
      WHERE app.rolname = 'brain_app'
        AND (
          app.rolsuper
          OR app.rolbypassrls
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_roles AS bypass_role
            WHERE (bypass_role.rolsuper OR bypass_role.rolbypassrls)
              AND (
                pg_catalog.pg_has_role(app.oid, bypass_role.oid, 'SET')
                OR pg_catalog.pg_has_role(app.oid, bypass_role.oid, 'MEMBER WITH ADMIN OPTION')
              )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS protected_relation
            JOIN pg_catalog.pg_roles AS owner ON owner.oid = protected_relation.relowner
            WHERE protected_relation.relrowsecurity
              AND (
                owner.oid = app.oid
                OR pg_catalog.pg_has_role(app.oid, owner.oid, 'USAGE')
                OR pg_catalog.pg_has_role(app.oid, owner.oid, 'SET')
                OR pg_catalog.pg_has_role(app.oid, owner.oid, 'MEMBER WITH ADMIN OPTION')
              )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS privileged_function
            JOIN pg_catalog.pg_roles AS function_owner
              ON function_owner.oid = privileged_function.proowner
            WHERE privileged_function.prosecdef
              AND (function_owner.rolsuper OR function_owner.rolbypassrls)
              -- Effective privilege inquiry includes PUBLIC and applicable role memberships.
              AND pg_catalog.has_function_privilege(
                'brain_app', privileged_function.oid, 'EXECUTE'
              )
          )
        )
    ) AS unsafe
  `;

  if (unsafe) {
    throw new Error(
      "Unsafe pre-existing brain_app role state detected: a membership path can assume a SUPERUSER/BYPASSRLS role, inherit/assume ownership of an RLS-enabled relation, or execute a SECURITY DEFINER function owned by a SUPERUSER/BYPASSRLS role. Review role memberships, object owners, and function EXECUTE ACLs manually; bootstrap made no role changes."
    );
  }
}

async function provisionRole(admin: Sql, role: RolePlan): Promise<void> {
  const [{ exists }] = await admin<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${role.name}) AS exists
  `;
  // PostgreSQL utility statements cannot use extended-protocol parameters. Let PostgreSQL
  // quote the bound value, then use only that returned literal in a simple-protocol command.
  const [{ literal }] = await admin<{ literal: string }[]>`SELECT quote_literal(${role.password}) AS literal`;
  const command = compileRoleCommand(role, literal, exists);
  await admin.unsafe(command);
}

async function applySystemGrants(system: Sql, plan: RoleBootstrapPlan): Promise<void> {
  for (const grant of plan.grants) await system.unsafe(grant);
}

export async function bootstrapDatabaseRolesWithClientFactory(
  config: RoleBootstrapConfig,
  createClient: RoleBootstrapClientFactory
): Promise<void> {
  validateRoleBootstrapConfig(config);
  const plan = buildRoleBootstrapPlan(config);
  const admin = createClient(config.adminUrl, { max: 1, connect_timeout: 10 });
  try {
    await assertBrainAppRlsSafe(admin);
    const [{ databaseName }] = await admin<{ databaseName: string }[]>`SELECT current_database() AS "databaseName"`;
    for (const role of plan.roles) await provisionRole(admin, role);
    await admin`GRANT CONNECT ON DATABASE ${admin(databaseName)} TO brain_app`;
    await admin`GRANT CONNECT, CREATE ON DATABASE ${admin(databaseName)} TO brain_system`;
    await admin`GRANT USAGE ON SCHEMA public TO brain_app`;
    await admin`GRANT USAGE, CREATE ON SCHEMA public TO brain_system`;
    for (const extension of plan.extensions) {
      await admin.unsafe(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
    }
  } finally {
    await admin.end();
  }

  // The system role owns future migration-created objects and must set its own defaults.
  const system = createClient(config.systemUrl, { max: 1, connect_timeout: 10 });
  try {
    await applySystemGrants(system, plan);
  } finally {
    await system.end();
  }
}

export async function bootstrapDatabaseRoles(config: RoleBootstrapConfig): Promise<void> {
  await bootstrapDatabaseRolesWithClientFactory(config, postgres as unknown as RoleBootstrapClientFactory);
}

export async function bootstrapDatabaseRolesFromEnv(
  env: NodeJS.ProcessEnv,
  provision: (config: RoleBootstrapConfig) => Promise<void> = bootstrapDatabaseRoles
): Promise<void> {
  const config = readRoleBootstrapConfig(env);
  await provision(config);
}

async function main(): Promise<void> {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(baseDir, "../../../.env"), resolve(baseDir, "../../../../.env")];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (envPath) loadDotEnv({ path: envPath });
  await bootstrapDatabaseRolesFromEnv(process.env);
  console.log("Database roles and privileges are ready.");
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch(() => {
    console.error("Database role bootstrap failed. Check protected PostgreSQL logs; do not share unredacted connection strings or server logs.");
    process.exitCode = 1;
  });
}
