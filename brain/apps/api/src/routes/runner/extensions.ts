import type { FastifyInstance } from "fastify";
import {
  deleteRunnerMcpServer,
  importLocalMcpConfigs,
  importMcpServersJson,
  installRunnerPlugin,
  listRunnerMcpServers,
  listRunnerPlugins,
  testRunnerMcpServer,
  uninstallRunnerPlugin,
  updateRunnerMcpServerStatus,
  updateRunnerPlugin,
  upsertRunnerMcpServer,
  type McpTransportType,
  type PluginSource,
  type RunnerPluginItem
} from "@brain/agent-runner";
import { assertSafeExternalUrl, maskSensitiveRecord, type RunnerRouteDeps } from "./security.js";

export function registerRunnerExtensionRoutes(app: FastifyInstance, deps: RunnerRouteDeps) {
  const { authenticateProjectRequest, enforceOpa, recordAudit } = deps;

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/runner/plugins",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      return listRunnerPlugins(req.params.projectId);
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      id: string;
      name?: string;
      version?: string;
      description?: string;
      source?: PluginSource;
      sourceRef?: string;
      category?: RunnerPluginItem["category"];
      skills?: string[];
      tools?: string[];
      hooks?: string[];
      config?: Record<string, string>;
      env?: Record<string, string>;
      enabled?: boolean;
    };
  }>(
    "/v1/projects/:projectId/runner/plugins",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const plugin = installRunnerPlugin(req.params.projectId, req.body);
      return { plugin };
    }
  );

  app.patch<{
    Params: { projectId: string; pluginId: string };
    Body: {
      enabled?: boolean;
      config?: Record<string, string>;
      env?: Record<string, string>;
      skills?: string[];
      tools?: string[];
      hooks?: string[];
    };
  }>(
    "/v1/projects/:projectId/runner/plugins/:pluginId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const plugin = updateRunnerPlugin(req.params.projectId, req.params.pluginId, req.body || {});
      return { plugin };
    }
  );

  app.delete<{ Params: { projectId: string; pluginId: string } }>(
    "/v1/projects/:projectId/runner/plugins/:pluginId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      return { removed: uninstallRunnerPlugin(req.params.projectId, req.params.pluginId) };
    }
  );

  app.get<{ Params: { projectId: string } }>(
    "/v1/projects/:projectId/runner/mcp-servers",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "read" });
      const data = listRunnerMcpServers(req.params.projectId);
      return {
        ...data,
        servers: data.servers.map((s) => ({
          ...s,
          env: maskSensitiveRecord(s.env),
          headers: maskSensitiveRecord(s.headers)
        }))
      };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: {
      id: string;
      name?: string;
      description?: string;
      transport?: McpTransportType;
      command?: string;
      args?: string[];
      url?: string;
      headers?: Record<string, string>;
      env?: Record<string, string>;
      enabled?: boolean;
    };
  }>(
    "/v1/projects/:projectId/runner/mcp-servers",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (req.body.url) assertSafeExternalUrl(req.body.url);
      const server = upsertRunnerMcpServer(req.params.projectId, req.body);
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "update",
        targetType: "runner_mcp_server",
        targetId: server.id,
        metadata: { transport: server.transport, enabled: server.enabled }
      });
      return {
        server: {
          ...server,
          env: maskSensitiveRecord(server.env),
          headers: maskSensitiveRecord(server.headers)
        }
      };
    }
  );

  app.post<{
    Params: { projectId: string };
    Body: { mode?: "local" | "json"; json?: unknown };
  }>(
    "/v1/projects/:projectId/runner/mcp-servers/import",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      if (req.body?.mode === "json") {
        const imported = importMcpServersJson(req.params.projectId, req.body.json, "imported");
        return { imported, sources: ["json"] };
      }
      return importLocalMcpConfigs(req.params.projectId);
    }
  );

  app.patch<{
    Params: { projectId: string; serverId: string };
    Body: { enabled: boolean };
  }>(
    "/v1/projects/:projectId/runner/mcp-servers/:serverId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      const server = updateRunnerMcpServerStatus(req.params.projectId, req.params.serverId, Boolean(req.body?.enabled));
      return { server };
    }
  );

  app.post<{ Params: { projectId: string; serverId: string } }>(
    "/v1/projects/:projectId/runner/mcp-servers/:serverId/test",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      return testRunnerMcpServer(req.params.projectId, req.params.serverId);
    }
  );

  app.delete<{ Params: { projectId: string; serverId: string } }>(
    "/v1/projects/:projectId/runner/mcp-servers/:serverId",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      await enforceOpa(ctx, { projectId: req.params.projectId, accessPolicyId: "internal-project", action: "write" });
      return { removed: deleteRunnerMcpServer(req.params.projectId, req.params.serverId) };
    }
  );
}

