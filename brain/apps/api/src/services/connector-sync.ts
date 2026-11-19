import { createHash } from "node:crypto";
import type { AppPostgresClient } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import {
  buildConnectorRelationsAndConflicts,
  deduplicateCanonicalItems,
  runWithExponentialBackoff,
  type ExternalConnector
} from "@brain/connector-framework";
import type { KnowledgeItem } from "@brain/core";
import type { AsyncRetrievalEngine } from "@brain/retrieval";
import {
  DurableWorkflowEngine,
  PostgresDurableWorkflowStore,
  saasSyncWorkflow,
  transitionWorkflowState
} from "@brain/temporal-workflows";
import { uploadObjectToMinio } from "./minio-storage.js";

export interface ConnectorStateEntry {
  provider: string;
  name: string;
  incrementalCursor: string;
  lastSyncedAt: string | null;
  syncedItemsCount: number;
  status: string;
}

export async function executeIncrementalConnectorSync(deps: {
  ctx: AuthContext;
  searchCtx: AuthContext;
  projectId: string;
  provider: "github" | "gitlab" | "gdrive" | "notion";
  current: ConnectorStateEntry;
  targetRef?: string;
  appPostgresClient?: AppPostgresClient;
  queryAwareRetrieval: AsyncRetrievalEngine;
}) {
  const { ctx, searchCtx, projectId, provider, current, targetRef, appPostgresClient, queryAwareRetrieval } = deps;

  const workflowEngine = new DurableWorkflowEngine(
    appPostgresClient ? new PostgresDurableWorkflowStore(appPostgresClient.sql as any) : undefined
  );
  let wfState = saasSyncWorkflow.initialState;
  const wf = await workflowEngine.startDurable({
    tenantId: ctx.tenantId,
    projectId,
    kind: "saas_sync",
    checkpoint: { provider, cursor: current.incrementalCursor, state: wfState }
  });

  const now = new Date().toISOString();
  const nextCursor = `${provider}-sync-${createHash("sha256").update(`${now}:${targetRef ?? ""}`).digest("hex").slice(0, 10)}`;

  const connectorAdapter: ExternalConnector = {
    provider,
    async syncIncremental(cursor) {
      const externalId = `${provider}:${projectId}:${cursor.cursor ?? nextCursor}`;
      const item: KnowledgeItem = {
        id: `EXT-${provider.toUpperCase()}-${nextCursor.slice(-6).toUpperCase()}`,
        tenantId: ctx.tenantId,
        projectId,
        domainId: 6,
        type: "document",
        title: `Sincronização ${current.name} (${targetRef ?? cursor.cursor ?? "incremental"})`,
        content: `Delta incremental capturado pelo conector '${provider}' no cursor '${nextCursor}'.`,
        summary: `Snapshot incremental do conector ${provider}`,
        status: "approved",
        sourceId: externalId,
        sourceOrigin: "external_reference",
        sourceKind: "connector",
        sourceVersion: nextCursor,
        sourceUri: `connector://${provider}/${projectId}/${nextCursor}`,
        version: 1,
        contentHash: createHash("sha256").update(`${externalId}:${now}`).digest("hex"),
        confidence: 0.9,
        trustLevel: "verified",
        isInferred: false,
        tags: ["connector", provider, "incremental-sync"],
        relatedIds: [],
        metadata: { externalProvider: provider, externalId, syncedAt: now, cursor: nextCursor },
        accessPolicyId: "internal-project",
        createdAt: now,
        updatedAt: now
      };
      return { items: [item], nextCursor };
    }
  };

  wfState = transitionWorkflowState(saasSyncWorkflow, wfState, "START").nextState;
  const batch = await runWithExponentialBackoff(() =>
    connectorAdapter.syncIncremental({
      provider,
      connectionId: current.provider,
      cursor: current.incrementalCursor,
      lastSyncedAt: current.lastSyncedAt ?? undefined
    })
  );
  wfState = transitionWorkflowState(saasSyncWorkflow, wfState, "DELTA_FETCHED").nextState;

  const deduplicatedItems = deduplicateCanonicalItems(batch.items);
  const existingHits = await queryAwareRetrieval.search(searchCtx, { projectId, query: "", limit: 100 }).catch(() => []);
  const existingItems = existingHits.map((h) => h.item);

  const conflicts = [];
  const relations = [];
  for (const item of deduplicatedItems) {
    const analysis = buildConnectorRelationsAndConflicts(item, existingItems);
    conflicts.push(...analysis.conflicts);
    relations.push(...analysis.edges);
  }
  wfState = transitionWorkflowState(saasSyncWorkflow, wfState, "NORMALIZED").nextState;

  current.incrementalCursor = batch.nextCursor ?? nextCursor;
  current.lastSyncedAt = now;
  current.status = "synced";
  current.syncedItemsCount += deduplicatedItems.length;

  await uploadObjectToMinio({
    key: `${ctx.tenantId}/${projectId}/connectors/${provider}/${current.incrementalCursor}.json`,
    body: JSON.stringify({
      provider,
      projectId,
      cursor: current.incrementalCursor,
      syncedAt: now,
      actorId: ctx.actorId,
      deduplicatedCount: deduplicatedItems.length,
      conflictsCount: conflicts.length,
      relationsCount: relations.length
    }),
    contentType: "application/json"
  });

  wfState = transitionWorkflowState(saasSyncWorkflow, wfState, "INDEXED").nextState;
  const completedWf = await workflowEngine.advanceDurable(wf.workflowId, {
    status: "completed",
    checkpoint: { provider, cursor: current.incrementalCursor, state: wfState, deduplicatedCount: deduplicatedItems.length }
  });

  return {
    now,
    completedWf,
    wfState,
    deduplicatedItems,
    relations,
    conflicts
  };
}
