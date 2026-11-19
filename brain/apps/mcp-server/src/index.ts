#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAppPostgresClient, type RlsSessionContext } from "@brain/audit-engine";
import { assertPolicyAccess, type AuthContext } from "@brain/auth";
import { MCP_CONNECTION_PROFILES, type McpConnectionProfileName } from "./connection-profile.js";
import { loadStoredCredentials, runMcpLoginFlow, runStdioHttpProxy } from "./cli-auth.js";
import { registerExtendedMcpTools } from "./extended-tools.js";
import { createBrainRuntime, createSqlBrainRuntime, type BrainRuntime, type CreateSqlBrainRuntimeOptions, type McpContextEngineContract, type McpRetrievalContract } from "./runtime.js";
import { registerCoreGovernanceTools } from "./tools/core-governance.js";
import { registerCoreRetrievalTools } from "./tools/core-retrieval.js";

export { cancelRunnerSchedule, createRunnerSchedule, listRunnerSchedules } from "./runner-schedules.js";
export {
  createBrainRuntime,
  createSqlBrainRuntime,
  type BrainRuntime,
  type CreateSqlBrainRuntimeOptions,
  type McpContextEngineContract,
  type McpRetrievalContract
};

export function createBrainMcpServer(
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName = "service"
): McpServer {
  if (!auditPolicyId?.trim() || /[* ,\0\r\n]/.test(auditPolicyId)) {
    throw new Error("auditPolicyId must be an explicit policy identifier");
  }
  assertPolicyAccess(ctx, auditPolicyId);
  const connection = MCP_CONNECTION_PROFILES[profile];
  const server = new McpServer(
    { name: connection.serverName, version: "0.1.0" },
    { instructions: connection.instructions }
  );

  registerCoreRetrievalTools(server, runtime, ctx, auditPolicyId, profile);
  registerCoreGovernanceTools(server, runtime, ctx, auditPolicyId, profile);
  registerExtendedMcpTools(server, runtime, ctx, auditPolicyId, profile);

  return server;
}

if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("brain-mcp")) {
  if (process.argv[2] === "login") {
    runMcpLoginFlow(process.argv[3]).catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
  } else {
    (async () => {
      const credentials = process.env.BRAIN_FORCE_DIRECT_DB === "1" ? null : await loadStoredCredentials();
      if (credentials) {
        await runStdioHttpProxy(credentials);
        return;
      }

      const configuredList = (value: string | undefined) => (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
      const baseCtx: AuthContext = {
        tenantId: process.env.BRAIN_TENANT_ID ?? "default-org",
        actorId: process.env.BRAIN_ACTOR_ID ?? "local-agent",
        actorType: "agent",
        roles: ["developer"],
        allowedProjects: configuredList(process.env.BRAIN_ALLOWED_PROJECTS),
        allowedPolicies: configuredList(process.env.BRAIN_ALLOWED_POLICIES)
      };
      const auditPolicyId = process.env.BRAIN_AUDIT_POLICY_ID ?? "internal-project";
      const appPostgresClient = createAppPostgresClient();
      const bootstrapRuntime = createSqlBrainRuntime(appPostgresClient, {
        tenantId: baseCtx.tenantId,
        allowedProjects: baseCtx.allowedProjects,
        allowedPolicies: baseCtx.allowedPolicies
      });
      const localCtx = bootstrapRuntime.opRepo
        ? await bootstrapRuntime.opRepo.resolveDynamicMcpScope(baseCtx, baseCtx.allowedProjects, baseCtx.allowedPolicies)
        : baseCtx;
      assertPolicyAccess(localCtx, auditPolicyId);
      const rlsContext: RlsSessionContext = {
        tenantId: localCtx.tenantId,
        allowedProjects: localCtx.allowedProjects,
        allowedPolicies: localCtx.allowedPolicies
      };
      const runtime = createSqlBrainRuntime(appPostgresClient, rlsContext);
      const server = createBrainMcpServer(runtime, localCtx, auditPolicyId, "local");
      const transport = new StdioServerTransport();
      await server.connect(transport).catch((err) => {
        appPostgresClient.close().catch(() => {});
        throw err;
      });
    })().catch((err) => {
      console.error(err);
      process.exit(1);
    });
  }
}
