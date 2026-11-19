import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { HandoffStore } from "@brain/agent-handoff";
import type { BrainRunnerQueue } from "@brain/agent-runner";
import type { ApprovalQueue, PostgresApprovalQueue } from "@brain/approval-engine";
import type { AuditLogger } from "@brain/audit-engine";
import { authenticateRequest, type AuthContext } from "@brain/auth";
import type { ContextEngine } from "@brain/context-engine";
import type { CrossServiceContractRegistry, PostgresCrossServiceRegistry } from "@brain/cross-service";
import { createDatabaseClient, type BrainDb, type PgMcpAuthRepository, type PgOperationalRepository, type PgSystemSettingsRepository } from "@brain/database";
import type { KnowledgeGraphStore, PostgresGraphStore } from "@brain/graph";
import type { PostgresKnowledgeRepository } from "@brain/knowledge";
import { createBrainMcpServer, createRunnerSchedule } from "@brain/mcp-server";
import type { PostgresMemoryManager } from "@brain/memory";
import type { AsyncRetrievalEngine, PostgresRetrievalEngine } from "@brain/retrieval";
import { enqueueEmbedJob } from "@brain/worker";
import { sha256Hex } from "./oauth-pkce.js";

export interface McpGatewayDeps {
  deploymentMode: "local" | "cloud";
  configuredApiKey: string;
  allowedProjects: readonly string[];
  allowedPolicies: readonly string[];
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  opRepo?: PgOperationalRepository;
  systemSettingsRepo?: PgSystemSettingsRepository;
  mcpAuthRepo?: PgMcpAuthRepository;
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
 * Registers OAuth 2.1 Discovery (RFC 9728 / RFC 8414) and stateful Streamable HTTP MCP gateway
 * (`POST`/`GET`/`DELETE /mcp`) with PostgreSQL token tracking, dynamic RBAC scope, and client audit attribution.
 */
export function registerMcpGatewayRoutes(app: FastifyInstance, deps: McpGatewayDeps): void {
  const activeSessions = new Map<string, StreamableHTTPServerTransport>();
  const systemDb: BrainDb | undefined = process.env.DATABASE_SYSTEM_URL
    ? createDatabaseClient(process.env.DATABASE_SYSTEM_URL).db
    : undefined;

  app.get("/gateway", async (req) => {
    const { apiOrigin, webOrigin } = resolveOrigins(req);
    return {
      gateway: "brain-universal-agent-gateway",
      deploymentMode: deps.deploymentMode,
      transports: ["streamable-http", "stdio", "rest"],
      mcpEndpoint: "/mcp",
      oauthDiscovery: "/.well-known/oauth-protected-resource",
      toolsCount: 59,
      activeMcpSessions: activeSessions.size,
      pgStoresEnabled: Boolean(deps.pgGraph && deps.pgRetrieval),
      auth: {
        methods: ["oauth2_pkce", "oauth2_device_flow", "bearer_jwt", "stdio_credentials_file"],
        oauthProtectedResource: `${apiOrigin}/.well-known/oauth-protected-resource`,
        oauthAuthorizationServer: `${apiOrigin}/.well-known/oauth-authorization-server`,
        registrationEndpoint: `${apiOrigin}/oauth/register`,
        tokenEndpoint: `${apiOrigin}/oauth/token`,
        deviceCodeEndpoint: `${apiOrigin}/v1/auth/oauth/device/code`,
        webApprovalUrl: `${webOrigin}/auth/oauth`,
        uiTokenGenerator: `${webOrigin} -> Acesso, CASL & Políticas -> Token MCP (POST ${apiOrigin}/v1/auth/mcp-token)`,
        cliLoginCommand: "brain-mcp login"
      }
    };
  });

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
      token_endpoint: `${apiOrigin}/oauth/token`,
      registration_endpoint: `${apiOrigin}/oauth/register`,
      device_authorization_endpoint: `${apiOrigin}/v1/auth/oauth/device/code`,
      response_types_supported: ["code", "token"],
      grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"]
    };
  });

  const handleMcpRequest = async (req: FastifyRequest, reply: FastifyReply) => {
    const rawAuth = req.headers.authorization || (typeof req.headers["x-api-key"] === "string" ? `Bearer ${req.headers["x-api-key"]}` : undefined);
    if (!rawAuth) {
      const { apiOrigin, webOrigin } = resolveOrigins(req);
      reply
        .code(401)
        .header("WWW-Authenticate", `Bearer resource_metadata="${apiOrigin}/.well-known/oauth-protected-resource"`)
        .send({
          error: "BRAIN_ERR_UNAUTHORIZED",
          message: "Autenticação Bearer ou OAuth2 necessária para acessar /mcp.",
          login: {
            howToAuthenticate: [
              `1) OAuth 2.1 PKCE (automático): registre cliente em POST ${apiOrigin}/oauth/register, abra ${webOrigin}/auth/oauth e troque o código em POST ${apiOrigin}/oauth/token.`,
              `2) OAuth2 Device Flow: POST ${apiOrigin}/v1/auth/oauth/device/code, aprove em ${webOrigin}/auth/oauth?code=<user_code> e faça polling em POST ${apiOrigin}/v1/auth/oauth/token.`,
              `3) Bearer Token / CLI: gere em ${webOrigin} -> Acesso, CASL & Políticas -> Token MCP ou execute 'brain-mcp login'.`
            ],
            oauthProtectedResource: `${apiOrigin}/.well-known/oauth-protected-resource`,
            oauthAuthorizationServer: `${apiOrigin}/.well-known/oauth-authorization-server`,
            registrationEndpoint: `${apiOrigin}/oauth/register`,
            tokenEndpoint: `${apiOrigin}/oauth/token`,
            deviceCodeEndpoint: `${apiOrigin}/v1/auth/oauth/device/code`,
            webApprovalUrl: `${webOrigin}/auth/oauth`,
            cliLoginCommand: "brain-mcp login"
          }
        });
      return;
    }

    const rawBearer = rawAuth.replace(/^Bearer\s+/i, "").trim();
    const tokenRecord = deps.mcpAuthRepo && rawBearer
      ? await deps.mcpAuthRepo.findActiveTokenByHash(sha256Hex(rawBearer)).catch(() => null)
      : null;
    if (tokenRecord) {
      deps.mcpAuthRepo?.touchLastUsed(tokenRecord.id).catch(() => {});
    }

    const baseCtx: AuthContext = tokenRecord
      ? await authenticateRequest(
          rawAuth,
          deps.configuredApiKey,
          tokenRecord.tenantId || "default-org",
          tokenRecord.allowedProjects.length > 0 ? tokenRecord.allowedProjects : deps.allowedProjects,
          undefined,
          deps.allowedPolicies
        ).catch(() => ({
          tenantId: tokenRecord.tenantId || "default-org",
          actorId: tokenRecord.userId,
          actorType: "agent" as const,
          roles: ["admin", "developer", "tech-lead"],
          allowedProjects: tokenRecord.allowedProjects.length > 0 ? [...tokenRecord.allowedProjects] : [...deps.allowedProjects],
          allowedPolicies: [...deps.allowedPolicies, "public-org", "internal-project"]
        }))
      : await authenticateRequest(
          rawAuth,
          deps.configuredApiKey,
          "default-org",
          deps.allowedProjects,
          undefined,
          deps.allowedPolicies
        );

    let ctx = deps.opRepo
      ? await deps.opRepo.resolveDynamicMcpScope(baseCtx, deps.allowedProjects, deps.allowedPolicies, systemDb)
      : baseCtx;

    if (tokenRecord && tokenRecord.allowedProjects.length > 0) {
      const restricted = new Set(tokenRecord.allowedProjects);
      ctx = { ...ctx, allowedProjects: ctx.allowedProjects.filter((p) => restricted.has(p)) };
    }

    if (!deps.opRepo && ctx.roles.some((r) => ["admin", "owner"].includes(r.toLowerCase()))) {
      const mergedProjects = new Set([...ctx.allowedProjects, ...deps.registeredProjects.keys()]);
      ctx = { ...ctx, allowedProjects: Array.from(mergedProjects) };
    }

    const rawAccept = String(req.raw.headers["accept"] || "");
    if (!rawAccept.includes("application/json") || !rawAccept.includes("text/event-stream")) {
      req.raw.headers["accept"] = "application/json, text/event-stream";
    }

    const sessionId = typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    if (sessionId && activeSessions.has(sessionId)) {
      const existingTransport = activeSessions.get(sessionId)!;
      reply.hijack();
      await existingTransport.handleRequest(req.raw, reply.raw, req.body);
      if (req.method === "DELETE") {
        activeSessions.delete(sessionId);
      }
      return;
    }

    const auditPolicyId =
      process.env.BRAIN_AUDIT_POLICY_ID ||
      (ctx.allowedPolicies.includes("internal-project") ? "internal-project" : ctx.allowedPolicies[0] || "public-org");

    const clientName =
      tokenRecord?.clientName ||
      (typeof req.headers["x-brain-client"] === "string" ? req.headers["x-brain-client"] : "mcp-http-client");
    const clientId = tokenRecord?.clientId || clientName;

    const isInitRequest =
      req.method === "POST" &&
      req.body !== null &&
      typeof req.body === "object" &&
      (Array.isArray(req.body)
        ? req.body.some((m) => (m as { method?: string })?.method === "initialize")
        : (req.body as { method?: string }).method === "initialize");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: isInitRequest || req.method === "GET" ? () => randomUUID() : undefined,
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        activeSessions.set(sid, transport);
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) activeSessions.delete(transport.sessionId);
    };

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
      enqueueEmbedding:
        process.env.BRAIN_PG_BOSS === "1" && process.env.DATABASE_URL
          ? async (item: {
              tenantId: string;
              projectId: string;
              id: string;
              sourceVersion: string;
              accessPolicyId: string;
              content: string;
            }) =>
              enqueueEmbedJob({
                tenantId: item.tenantId,
                projectId: item.projectId,
                itemId: item.id,
                sourceVersion: item.sourceVersion,
                accessPolicyId: item.accessPolicyId,
                content: item.content
              })
          : undefined,
      opRepo: deps.opRepo,
      systemSettings: deps.systemSettingsRepo,
      memory: deps.pgMemory,
      knowledge: deps.pgKnowledge,
      crossServiceRegistry: deps.pgCrossService ?? deps.crossService,
      approvals: deps.pgApprovals,
      registeredProjects: deps.registeredProjects,
      audit: {
        record: (event: Parameters<AuditLogger["record"]>[0]) =>
          deps.recordAudit(ctx, {
            ...event,
            metadata: {
              ...(event.metadata ?? {}),
              mcpClientId: clientId,
              mcpClientName: clientName,
              ...(tokenRecord ? { mcpTokenId: tokenRecord.id } : {})
            }
          })
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
