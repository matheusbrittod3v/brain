import type { FastifyInstance } from "fastify";
import { assertPermission, authenticateRequest, type AuthContext, type SystemPermission } from "@noema/auth";

export function requiredPermissionForRoute(method: string, routeUrl: string): SystemPermission | null {
  const m = method.toUpperCase();
  if (m === "POST" && routeUrl === "/v1/projects") return "projects:create";
  if (m === "GET" && routeUrl === "/v1/audit-logs") return "audit:view";
  if (!routeUrl.startsWith("/v1/projects/:projectId/")) return null;
  const sub = routeUrl.slice("/v1/projects/:projectId/".length);
  if (sub === "access/profile" || sub === "access/permissions") return null;
  if (sub.startsWith("access/roles")) return m === "GET" ? "roles:view" : "roles:manage";
  if (
    sub.startsWith("access/assignments") ||
    sub.startsWith("access/members") ||
    sub.startsWith("access/grants") ||
    sub.startsWith("access/user-policies")
  ) {
    return m === "GET" ? "roles:view" : "users:assign_roles";
  }
  if (sub.startsWith("proposals")) {
    if (m === "GET") return "proposals:view";
    if (sub.includes("approve")) return "proposals:decide";
    return "proposals:create";
  }
  if (sub.startsWith("approvals/")) return "proposals:decide";
  if (sub.startsWith("knowledge")) return m === "GET" ? "knowledge:read" : "knowledge:write";
  if (sub.startsWith("search")) return "knowledge:search";
  if (sub.startsWith("graph")) return m === "GET" ? "knowledge:search" : "knowledge:write";
  if (sub.startsWith("ingest")) return "knowledge:write";
  if (sub.startsWith("runner")) {
    if (m === "GET") return "runner:view";
    if (sub.includes("cancel")) return "runner:cancel";
    return "runner:execute";
  }
  if (sub.startsWith("change/impact")) return "impact:analyze";
  if (sub.startsWith("integrations")) return m === "GET" ? "integrations:view" : "integrations:manage";
  if (sub.startsWith("github")) return "integrations:manage";
  if (sub.startsWith("finops")) return m === "GET" ? "finops:view" : "finops:manage";
  if (sub.startsWith("scaffold")) return "templates:view";
  if (sub.startsWith("enterprise")) return "enterprise:view";
  return null;
}

export function registerRbacGuard(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    configuredApiKey: string;
    allowedProjects: readonly string[];
    allowedPolicies: readonly string[];
  }
) {
  app.addHook("preHandler", async (req) => {
    const routeUrl = req.routeOptions?.url ?? "";
    const required = requiredPermissionForRoute(req.method, routeUrl);
    if (!required || !req.headers.authorization) return;
    const params = req.params as { projectId?: string } | undefined;
    const query = req.query as { projectId?: string } | undefined;
    const pid = params?.projectId ?? query?.projectId;
    const ctx = pid
      ? await deps.authenticateProjectRequest(req.headers.authorization, pid)
      : await authenticateRequest(
          req.headers.authorization,
          deps.configuredApiKey,
          "default-org",
          deps.allowedProjects,
          undefined,
          deps.allowedPolicies
        );
    assertPermission(ctx, required);
  });
}

