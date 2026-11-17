import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MemoryManager,
  createPostgresMemoryManagerForTesting,
  type MemoryEntryRow,
  type MemorySqlParameter,
  type MemorySqlTransactionRunner
} from "../src/index.js";

const devCtx = {
  tenantId: "acme",
  actorId: "u1",
  actorType: "human" as const,
  roles: ["developer"],
  allowedProjects: ["sub"],
  allowedPolicies: ["internal-project"]
};

test("MemoryManager enforces organizational approval and decays old episodic entries", () => {
  const mgr = new MemoryManager();
  assert.throws(() =>
    mgr.record(devCtx, { projectId: "sub", layer: "organizational", content: "Sem aprovação" })
  );

  const ep = mgr.record(devCtx, { projectId: "sub", layer: "episodic", content: "Descoberta antiga" });
  ep.createdAt = new Date(Date.now() - 90 * 86_400_000).toISOString();

  const decay = mgr.runDecay(devCtx, "sub");
  assert.equal(decay.archivedCount, 1);
  assert.equal(decay.semanticCreated?.layer, "semantic");
  assert.equal(decay.semanticCreated?.isInferred, true);
});

test("MemoryManager.record sets 24h TTL for working and 60d expiresAt for episodic entries", () => {
  const mgr = new MemoryManager();
  const working = mgr.record(devCtx, { projectId: "sub", layer: "working", content: "Contexto sessao" });
  const episodic = mgr.record(devCtx, { projectId: "sub", layer: "episodic", content: "Execucao passada" });
  const semantic = mgr.record(devCtx, { projectId: "sub", layer: "semantic", content: "Fato consolidado" });

  assert.ok(working.expiresAt);
  assert.ok(episodic.expiresAt);
  assert.equal(semantic.expiresAt, undefined);

  const workingTtl = Date.parse(working.expiresAt!) - Date.parse(working.createdAt);
  const episodicTtl = Date.parse(episodic.expiresAt!) - Date.parse(episodic.createdAt);
  assert.equal(workingTtl, 24 * 60 * 60 * 1000);
  assert.equal(episodicTtl, 60 * 24 * 60 * 60 * 1000);
});

test("PostgresMemoryManager enforces RLS, 24h/60d TTLs, compactEpisodicToSemantic, and runDecay", async () => {
  const rows: MemoryEntryRow[] = [];
  let currentNowMs = Date.parse("2026-11-16T12:00:00.000Z");

  const fakeSql = {
    async begin<T>(cb: (tx: MemorySqlTransactionRunner) => T | Promise<T>): Promise<T> {
      let gucTenant = "";
      let gucProjects = new Set<string>();
      let gucPolicies = new Set<string>();

      const tx = (async <TRow = Record<string, unknown>>(
        template: TemplateStringsArray,
        ...params: readonly MemorySqlParameter[]
      ): Promise<readonly TRow[]> => {
        const sqlText = template.join("$P$").replace(/\s+/g, " ").trim();
        if (sqlText.includes("set_config('app.current_tenant_id'")) {
          gucTenant = String(params[0] ?? "");
          gucProjects = new Set(String(params[1] ?? "").split(",").filter(Boolean));
          gucPolicies = new Set(String(params[2] ?? "").split(",").filter(Boolean));
          return [] as unknown as readonly TRow[];
        }
        if (!gucTenant) throw new Error("Missing RLS GUCs");

        if (sqlText.startsWith("INSERT INTO memory_entries")) {
          const [tenantId, projectId, layer, sessionId, content, accessPolicyId, expiresAtIso, createdAtIso] =
            params as [string, string, string, string | null, string, string, string | null, string];
          const inserted: MemoryEntryRow = {
            id: randomUUID(),
            tenant_id: tenantId,
            project_id: projectId,
            layer,
            session_id: sessionId,
            content,
            access_policy_id: accessPolicyId,
            expires_at: expiresAtIso,
            created_at: createdAtIso
          };
          rows.push(inserted);
          return [inserted] as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("SELECT") && sqlText.includes("FROM memory_entries") && sqlText.includes("layer = 'episodic'")) {
          const [tenantId, projectId, policiesCsv, nowIso, cutoffIso] = params as [
            string,
            string,
            string,
            string,
            string
          ];
          const allowedPol = new Set(policiesCsv.split(",").filter(Boolean));
          const nowMs = Date.parse(nowIso);
          const cutoffMs = Date.parse(cutoffIso);
          const stale = rows.filter(
            (r) =>
              r.tenant_id === gucTenant &&
              gucProjects.has(r.project_id) &&
              gucPolicies.has(r.access_policy_id) &&
              r.tenant_id === tenantId &&
              r.project_id === projectId &&
              r.layer === "episodic" &&
              allowedPol.has(r.access_policy_id) &&
              ((r.expires_at !== null && Date.parse(String(r.expires_at)) <= nowMs) ||
                Date.parse(String(r.created_at)) < cutoffMs)
          );
          return stale as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("SELECT") && sqlText.includes("FROM memory_entries")) {
          const [tenantId, projectId, policiesCsv, nowIso] = params as [string, string, string, string];
          const allowedPol = new Set(policiesCsv.split(",").filter(Boolean));
          const nowMs = Date.parse(nowIso);
          const visible = rows.filter(
            (r) =>
              r.tenant_id === gucTenant &&
              gucProjects.has(r.project_id) &&
              gucPolicies.has(r.access_policy_id) &&
              r.tenant_id === tenantId &&
              r.project_id === projectId &&
              allowedPol.has(r.access_policy_id) &&
              (r.expires_at === null || Date.parse(String(r.expires_at)) > nowMs)
          );
          return visible as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("DELETE FROM memory_entries") && sqlText.includes("layer = 'working'")) {
          const [tenantId, projectId, policiesCsv, nowIso] = params as [string, string, string, string];
          const allowedPol = new Set(policiesCsv.split(",").filter(Boolean));
          const nowMs = Date.parse(nowIso);
          const deleted: Array<{ id: string }> = [];
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (
              r.tenant_id === tenantId &&
              r.project_id === projectId &&
              r.layer === "working" &&
              allowedPol.has(r.access_policy_id) &&
              r.expires_at !== null &&
              Date.parse(String(r.expires_at)) <= nowMs
            ) {
              deleted.push({ id: r.id });
              rows.splice(i, 1);
            }
          }
          return deleted as unknown as readonly TRow[];
        }

        if (sqlText.startsWith("DELETE FROM memory_entries")) {
          const [tenantId, projectId, idsCsv] = params as [string, string, string];
          const ids = new Set(idsCsv.split(",").filter(Boolean));
          for (let i = rows.length - 1; i >= 0; i--) {
            const r = rows[i]!;
            if (r.tenant_id === tenantId && r.project_id === projectId && ids.has(r.id)) {
              rows.splice(i, 1);
            }
          }
          return [] as unknown as readonly TRow[];
        }

        return [] as unknown as readonly TRow[];
      }) as MemorySqlTransactionRunner;

      return await cb(tx);
    }
  };

  const pgMem = createPostgresMemoryManagerForTesting(fakeSql, { now: () => new Date(currentNowMs) });

  const w = await pgMem.record(devCtx, {
    projectId: "sub",
    layer: "working",
    sessionId: "sess-1",
    content: "Working note"
  });
  const ep = await pgMem.record(devCtx, {
    projectId: "sub",
    layer: "episodic",
    content: "Old episodic discovery"
  });

  assert.equal(Date.parse(w.expiresAt!) - Date.parse(w.createdAt), 24 * 60 * 60 * 1000);
  assert.equal(Date.parse(ep.expiresAt!) - Date.parse(ep.createdAt), 60 * 24 * 60 * 60 * 1000);

  const visibleNow = await pgMem.listVisible(devCtx, "sub", "sess-1");
  assert.equal(visibleNow.length, 2);

  // Advance 61 days -> both working (24h) and episodic (60d) are expired
  currentNowMs += 61 * 24 * 60 * 60 * 1000;
  const decayRes = await pgMem.runDecay(devCtx, "sub");
  assert.equal(decayRes.expiredWorkingRemoved, 1);
  assert.equal(decayRes.archivedCount, 1);
  assert.equal(decayRes.semanticCreated?.layer, "semantic");
  assert.ok(decayRes.semanticCreated?.content.includes("Old episodic discovery"));

  const visibleAfter = await pgMem.listVisible(devCtx, "sub");
  assert.equal(visibleAfter.length, 1);
  assert.equal(visibleAfter[0]!.layer, "semantic");
});

