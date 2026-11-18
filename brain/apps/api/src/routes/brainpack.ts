import type { FastifyInstance } from "fastify";
import type { AuditLogger } from "@brain/audit-engine";
import { assertPolicyAccess, type AuthContext } from "@brain/auth";
import type { KnowledgeItem } from "@brain/core";
import { scanForSecrets } from "@brain/ingestion";
import { assertSecretScanClean } from "../services/ai-worker.js";

export function registerBrainpackRoutes(
  app: FastifyInstance,
  deps: {
    authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
    recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
    queryAwareRetrieval: { search: (ctx: AuthContext, q: { projectId: string; query: string; limit: number }) => Promise<Array<{ item: KnowledgeItem }>> };
    upsertKnowledgeItem: (ctx: AuthContext, item: KnowledgeItem) => Promise<void>;
  }
) {
  const { authenticateProjectRequest, recordAudit, queryAwareRetrieval, upsertKnowledgeItem } = deps;

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/brainpack", async (req) => {
    const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
    const hits = await queryAwareRetrieval.search(ctx, { projectId: req.params.projectId, query: "", limit: 500 });
    const items = hits.map((h) => h.item);
    await recordAudit(ctx, {
      tenantId: ctx.tenantId,
      projectId: req.params.projectId,
      accessPolicyId: "internal-project",
      actorId: ctx.actorId,
      actorType: ctx.actorType,
      action: "export",
      targetType: "brainpack",
      targetId: req.params.projectId,
      metadata: { itemCount: items.length }
    });
    return { format: "brain-brainpack-v1", projectId: req.params.projectId, exportedAt: new Date().toISOString(), items };
  });

  app.post<{ Params: { projectId: string }; Body: { items: KnowledgeItem[] } }>(
    "/v1/projects/:projectId/brainpack/import",
    async (req) => {
      const ctx = await authenticateProjectRequest(req.headers.authorization, req.params.projectId);
      let importedCount = 0;
      for (const item of req.body.items ?? []) {
        const scan = scanForSecrets(item.content);
        if (scan.engine === "unavailable") assertSecretScanClean(scan, "Gitleaks indisponível para importar Brainpack");
        if (!scan.clean) continue;
        assertPolicyAccess(ctx, item.accessPolicyId);
        await upsertKnowledgeItem(ctx, { ...item, tenantId: ctx.tenantId, projectId: req.params.projectId });
        importedCount += 1;
      }
      await recordAudit(ctx, {
        tenantId: ctx.tenantId,
        projectId: req.params.projectId,
        accessPolicyId: "internal-project",
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        action: "create",
        targetType: "brainpack_import",
        targetId: req.params.projectId,
        metadata: { importedCount }
      });
      return { imported: true, importedCount };
    }
  );
}

