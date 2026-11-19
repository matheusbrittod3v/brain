import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HandoffStore } from "@brain/agent-handoff";
import type { BrainRunnerQueue } from "@brain/agent-runner";
import type { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import type { AuditLogger } from "@brain/audit-engine";
import { authenticateRequest, type AuthContext } from "@brain/auth";
import type { ContextEngine } from "@brain/context-engine";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import type { PgOperationalRepository } from "@brain/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import type { PostgresKnowledgeRepository } from "@brain/knowledge";
import { createBrainMcpServer, createRunnerSchedule } from "@brain/mcp-server";
import type { PostgresMemoryManager } from "@brain/memory";
import type { AsyncRetrievalEngine, PostgresRetrievalEngine } from "@brain/retrieval";

export interface McpGatewayDeps {
  deploymentMode: "local" | "cloud";
  configuredApiKey: string;
  allowedProjects: readonly string[];
  allowedPolicies: readonly string[];
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  opRepo?: PgOperationalRepository;
  pgGraph?: PostgresGraphStore;
  graph: KnowledgeGraphStore;
  queryAwareRetrieval: AsyncRetrievalEngine;
  pgRetrieval?: PostgresRetrievalEngine;
  contextEngine: ContextEngine<AsyncRetrievalEngine>;
  handoffs: HandoffStore;
  runner: BrainRunnerQueue;
  pgMemory?: PostgresMemoryManager;
  pgKnowledge?: PostgresKnowledgeRepository;
  pgCrossService?: PostgresCrossServiceRegistry;
  crossService: CrossServiceContractRegistry;
  pgApprovals?: PostgresApprovalQueue;
  approvals?: ApprovalQueue;
  registeredProjects: Map<string, unknown>;
}

function resolveOrigins(req: FastifyRequest): { apiOrigin: string; webOrigin: string } {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() || "http";
  const host = (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host || `localhost:${process.env.PORT || "3333"}`;
  const apiOrigin = process.env.BRAIN_PUBLIC_API_URL?.replace(/\/+$/, "") || `${proto}://${host}`;
  const webOrigin = process.env.BRAIN_CORS_ORIGIN?.split(",")[0]?.trim().replace(/\/+$/, "") || "http://localhost:3000";
  return { apiOrigin, webOrigin };
}

/**
 * Registers OAuth Discovery metadata endpoints and the Streamable HTTP MCP gateway (`POST`/`GET`/`DELETE /mcp`)
 * with dynamic PostgreSQL RBAC & project scope resolution.
 */
export function registerMcpGatewayRoutes(app: FastifyInstance, deps: McpGatewayDeps): void {
  app.get("/gateway", async () => ({
    gateway: "brain-universal-agent-gateway",
    deploymentMode: deps.deploymentMode,
    transports: ["streamable-http", "stdio", "rest"],
    mcpEndpoint: "/mcp",
    oauthDiscovery: "/.well-known/oauth-protected-resource",
    toolsCount: 59,
    pgStoresEnabled: Boolean(deps.pgGraph && deps.pgRetrieval)
  }));

  app.get("/.well-known/oauth-protected-resource", async (req) => {
    const { apiOrigin } = resolveOrigins(req);
    return {
      resource: `${apiOrigin}/mcp`,
      authorization_servers: [apiOrigin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["projects:all", "knowledge:read", "knowledge:write", "runner:execute"]
    };
  });

  app.get("/.well-known/oauth-authorization-server", async (req) => {
    const { apiOrigin, webOrigin } = resolveOrigins(req);
    return {
      issuer: apiOrigin,
      authorization_endpoint: `${webOrigin}/auth/oauth`,
      token_endpoint: `${apiOrigin}/v1/auth/oauth/token`,
      device_authorization_endpoint: `${apiOrigin}/v1/auth/oauth/device/code`,
      response_types_supported: ["code", "token"],
      grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"]
    };
  });

  const handleMcpRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    const rawAuth = req.headers.authorization || (typeof req.headers["x-api-key"] === "string" ? `Bearer ${req.headers["x-api-key"]}` : undefined);
    if (!rawAuth) {
      const { apiOrigin } = resolveOrigins(req);
      reply
        .code(401)
        .header("WWW-Authenticate", `Bearer resource_metadata="${apiOrigin}/.well-known/oauth-protected-resource"`)
        .send({
          error: "BRAIN_ERR_UNAUTHORIZED",
          message: "Autenticação Bearer ou OAuth2 necessária para acessar /mcp."
        });
      return;
    }

    const baseCtx = await authenticateRequest(
      rawAuth,
      deps.configuredApiKey,
      "default-org",
      deps.allowedProjects,
      undefined,
      deps.allowedPolicies
    );

    let ctx = deps.opRepo
      ? await deps.opRepo.resolveDynamicMcpScope(baseCtx, deps.allowedProjects, deps.allowedPolicies)
      : baseCtx;

    if (!deps.opRepo && ctx.roles.some((r) => ["admin", "owner"].includes(r.toLowerCase()))) {
      const mergedProjects = new Set([...ctx.allowedProjects, ...deps.registeredProjects.keys()]);
      ctx = { ...ctx, allowedProjects: Array.from(mergedProjects) };
    }

    const auditPolicyId =
      process.env.BRAIN_AUDIT_POLICY_ID ||
      (ctx.allowedPolicies.includes("internal-project") ? "internal-project" : ctx.allowedPolicies[0] || "public-org");

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpRuntime = {
      graph: deps.pgGraph ?? deps.graph,
      retrieval: deps.queryAwareRetrieval,
      contextEngine: deps.contextEngine,
      handoffs: deps.handoffs,
      runner: deps.runner,
      scheduleRunnerTask: (process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL)
        ? async (input: Parameters<typeof createRunnerSchedule>[0] & { cron: string }) => ({
            scheduleId: await createRunnerSchedule(input, input.cron, process.env.DATABASE_SYSTEM_URL ?? process.env.DATABASE_URL!)
          })
        : undefined,
      opRepo: deps.opRepo,
      memory: deps.pgMemory,
      knowledge: deps.pgKnowledge,
      crossServiceRegistry: deps.pgCrossService ?? deps.crossService,
      approvals: deps.pgApprovals,
      registeredProjects: deps.registeredProjects,
      audit: {
        record: (event: Parameters<AuditLogger["record"]>[0]) => deps.recordAudit(ctx, event)
      }
    };

    const mcpServer = createBrainMcpServer(mcpRuntime as never, ctx, auditPolicyId, "service");
    await mcpServer.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, req.body);
  };

  app.post("/mcp", handleMcpRequest);
  app.get("/mcp", handleMcpRequest);
  app.delete("/mcp", handleMcpRequest);
}

