import { createConnection } from "node:net";
import type { AppPostgresClient } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import type { PgOperationalRepository } from "@brain/database";

export async function probeHttp(url: string) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1800) });
    return { online: res.ok, latencyMs: Date.now() - t0, status: res.status };
  } catch {
    return { online: false, latencyMs: Date.now() - t0, status: 0 };
  }
}

export async function probeOllama(baseUrl: string, modelName: string) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(1800) });
    if (!res.ok) {
      return { online: false, serverUp: false, modelInstalled: false, latencyMs: Date.now() - t0 };
    }
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const models = Array.isArray(data.models) ? data.models : [];
    const target = modelName.toLowerCase();
    const modelInstalled = models.some((m) => {
      const id = (m.name ?? m.model ?? "").toLowerCase();
      return id === target || id.startsWith(`${target}:`);
    });
    return { online: modelInstalled, serverUp: true, modelInstalled, latencyMs: Date.now() - t0 };
  } catch {
    return { online: false, serverUp: false, modelInstalled: false, latencyMs: Date.now() - t0 };
  }
}

export async function probeValkey(redisUrl: string): Promise<{ online: boolean; latencyMs: number }> {
  const t0 = Date.now();
  let host = "localhost";
  let port = 6379;
  try {
    const parsed = new URL(redisUrl);
    host = parsed.hostname || "localhost";
    port = Number(parsed.port || 6379);
  } catch {
    // default localhost:6379
  }
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (online: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ online, latencyMs: Date.now() - t0 });
    };
    socket.setTimeout(1200);
    socket.on("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.on("data", (chunk) => finish(chunk.toString("utf8").includes("PONG")));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
  });
}

export async function probePostgresHealth(deps: {
  appPostgresClient?: AppPostgresClient;
  opRepo?: PgOperationalRepository;
  ctx: AuthContext;
  projectId: string;
}): Promise<{ online: boolean; latencyMs: number; embeddedCount: number | null; totalCount: number | null }> {
  const { appPostgresClient, opRepo, ctx, projectId } = deps;
  const t0 = Date.now();
  if (appPostgresClient) {
    try {
      const stats = await appPostgresClient.withRlsTransaction(
        { tenantId: ctx.tenantId, allowedProjects: ctx.allowedProjects, allowedPolicies: ctx.allowedPolicies },
        async (sql) => {
          const [row] = (await sql`
            SELECT
              (SELECT COUNT(*)::int FROM knowledge_items WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId} AND deleted_at IS NULL) AS total_count,
              (SELECT COUNT(DISTINCT knowledge_item_id)::int FROM knowledge_embeddings WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId}) AS embedded_count
          `) as Array<{ total_count: number; embedded_count: number }>;
          return row;
        }
      );
      return {
        online: true,
        latencyMs: Date.now() - t0,
        totalCount: stats?.total_count ?? null,
        embeddedCount: stats?.embedded_count ?? null
      };
    } catch {
      return { online: false, latencyMs: Date.now() - t0, totalCount: null, embeddedCount: null };
    }
  }
  if (opRepo) {
    try {
      await opRepo.listDepartmentFinopsQuotas(ctx, projectId);
      return { online: true, latencyMs: Date.now() - t0, totalCount: null, embeddedCount: null };
    } catch {
      return { online: false, latencyMs: Date.now() - t0, totalCount: null, embeddedCount: null };
    }
  }
  return { online: false, latencyMs: 0, totalCount: null, embeddedCount: null };
}
