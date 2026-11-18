import { Type } from "@sinclair/typebox";
import type { FastifyInstance } from "fastify";
import { authenticateRequest, type AuthContext } from "@brain/auth";
import type { RealtimeSyncEvent } from "../realtime.js";

export function registerRealtimeRoutes(
  app: FastifyInstance,
  deps: {
    realtime: {
      issueTicket: (params: {
        tenantId: string;
        actorId: string;
        projectId: string;
        allowedProjects: string[];
      }) => { ticket: string; expiresInMs: number; wsPath: string };
      publish: (event: RealtimeSyncEvent) => void;
      close: () => Promise<void>;
    };
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
  }
) {
  const { realtime, authenticateProjectRequest, configuredApiKey, allowedProjects, allowedPolicies } = deps;

  app.addHook("onClose", async () => {
    await realtime.close();
  });

  app.addHook("onResponse", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && reply.statusCode < 400) {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (path === "/v1/ws/ticket" || path.endsWith("/search")) return;
      const projectMatch = /^\/v1\/projects\/([^/]+)(?:\/(.*))?$/.exec(path);
      if (path === "/v1/projects") {
        realtime.publish({ tenantId: "default-org", channel: "projects", action: req.method.toLowerCase() });
      } else if (projectMatch) {
        const pid = decodeURIComponent(projectMatch[1] ?? "");
        const sub = projectMatch[2] ?? "";
        const channels: RealtimeSyncEvent["channel"][] = ["audit"];
        if (sub.startsWith("approvals") || sub.startsWith("proposals")) channels.push("proposals", "overview", "search", "enterprise");
        else if (sub.startsWith("ingest") || sub.startsWith("change") || sub.startsWith("knowledge"))
          channels.push("overview", "search", "graph", "proposals", "enterprise");
        else if (sub.startsWith("runner")) channels.push("runner", "overview");
        else if (sub.startsWith("github") || sub.startsWith("integrations")) channels.push("integrations", "overview");
        else if (sub.startsWith("finops")) channels.push("finops");
        else if (sub.startsWith("access")) channels.push("access");
        else channels.push("overview");
        for (const channel of channels) {
          realtime.publish({
            tenantId: "default-org",
            projectId: pid,
            channel,
            action: `${req.method.toLowerCase()}:${sub || "project"}`
          });
        }
      }
    }
  });

  app.post<{ Body: { projectId?: string } }>(
    "/v1/ws/ticket",
    { schema: { body: Type.Optional(Type.Object({ projectId: Type.Optional(Type.String()) })) } },
    async (req) => {
      const requestedProjectId = req.body?.projectId?.trim() || "";
      const ctx = requestedProjectId
        ? await authenticateProjectRequest(req.headers.authorization, requestedProjectId)
        : await authenticateRequest(
            req.headers.authorization,
            configuredApiKey,
            "default-org",
            allowedProjects,
            undefined,
            allowedPolicies
          );
      return realtime.issueTicket({
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        projectId: requestedProjectId || ctx.allowedProjects[0] || "",
        allowedProjects: ctx.allowedProjects
      });
    }
  );
}

