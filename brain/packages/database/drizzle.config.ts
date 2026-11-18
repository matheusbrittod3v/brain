import { defineConfig } from "drizzle-kit";
import { config as loadDotEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getMigrationDatabaseUrl } from "./src/bootstrap-roles.ts";

loadDotEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

const OFFLINE_PLACEHOLDER_URL = "postgresql://brain_system:offline@localhost:5432/brain_offline";
const OFFLINE_COMMANDS = new Set(["generate", "check"]);

// drizzle-kit loads this config for every command. Only commands that open a
// connection (migrate, push, studio, ...) must fail fast without a valid
// DATABASE_SYSTEM_URL authenticated as brain_system; offline commands
// (generate, check) never use dbCredentials and must work without credentials.
function resolveDrizzleDatabaseUrl(env: NodeJS.ProcessEnv, argv: string[]): string {
  try {
    return getMigrationDatabaseUrl(env);
  } catch (error) {
    const command = argv.find((arg) => !arg.startsWith("-"));
    if (command && OFFLINE_COMMANDS.has(command)) return OFFLINE_PLACEHOLDER_URL;
    throw error;
  }
}

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: resolveDrizzleDatabaseUrl(process.env, process.argv.slice(2)) }
});
