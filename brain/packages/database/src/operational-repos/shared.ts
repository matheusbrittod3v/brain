import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@brain/auth";
import { BrainError, type ContextSessionEvidence, type ContextSessionHitRate } from "@brain/core";
import type { BrainDb } from "../client.js";
import { contextSessionItems, knowledgeItems } from "../schema.js";

export type MemoryLayer = "working" | "episodic" | "semantic" | "procedural" | "organizational";

export async function getContextHitRateInTransaction(
  tx: BrainDb,
  ctx: AuthContext,
  projectId: string,
  sessionId: string
): Promise<ContextSessionHitRate> {
  const rows = await tx.execute(sql`
    SELECT
      count(*)::int AS items_sent,
      count(*) FILTER (WHERE hit_at IS NOT NULL)::int AS hits
    FROM public.context_session_items
    WHERE tenant_id = ${ctx.tenantId}
      AND project_id = ${projectId}
      AND actor_id = ${ctx.actorId}
      AND session_id = ${sessionId}
  `);
  const itemsSent = Number(rows[0]?.items_sent ?? 0);
  const hits = Number(rows[0]?.hits ?? 0);
  return { sessionId, hits, itemsSent, rate: itemsSent > 0 ? hits / itemsSent : 0 };
}

export async function recordContextEvidenceInTransaction(
  tx: BrainDb,
  ctx: AuthContext,
  projectId: string,
  sessionId: string,
  itemIds: readonly string[],
  evidence: ContextSessionEvidence
): Promise<Array<{ itemId: string; accessPolicyId: string }>> {
  if (!(["read", "citation", "edit"] as string[]).includes(evidence)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Unknown Context Session evidence type.", 400);
  }
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length === 0) return [];
  const rows = await tx.select({
    itemId: contextSessionItems.itemId,
    accessPolicyId: contextSessionItems.accessPolicyId,
    hitAt: contextSessionItems.hitAt
  }).from(contextSessionItems).where(and(
    eq(contextSessionItems.tenantId, ctx.tenantId),
    eq(contextSessionItems.projectId, projectId),
    eq(contextSessionItems.actorId, ctx.actorId),
    eq(contextSessionItems.sessionId, sessionId),
    inArray(contextSessionItems.itemId, uniqueIds)
  )).for("update");
  if (rows.length !== uniqueIds.length) {
    throw new BrainError("BRAIN_ERR_NOT_FOUND", "One or more items were not delivered in this authorized Context Pack session.", 404);
  }
  const newlyHit = rows.filter((row) => row.hitAt === null).map(({ itemId, accessPolicyId }) => ({ itemId, accessPolicyId }));
  await tx.update(contextSessionItems).set({
    hitAt: sql`COALESCE(${contextSessionItems.hitAt}, now())`,
    hitEvidence: sql`CASE WHEN ${evidence} = ANY(${contextSessionItems.hitEvidence}) THEN ${contextSessionItems.hitEvidence} ELSE array_append(${contextSessionItems.hitEvidence}, ${evidence}) END`
  }).where(and(
    eq(contextSessionItems.tenantId, ctx.tenantId),
    eq(contextSessionItems.projectId, projectId),
    eq(contextSessionItems.actorId, ctx.actorId),
    eq(contextSessionItems.sessionId, sessionId),
    inArray(contextSessionItems.itemId, uniqueIds)
  ));

  if (newlyHit.length > 0) {
    const updated = await tx.update(knowledgeItems)
      .set({ contextHitCount: sql`${knowledgeItems.contextHitCount} + 1` })
      .where(and(
        eq(knowledgeItems.tenantId, ctx.tenantId),
        eq(knowledgeItems.projectId, projectId),
        inArray(knowledgeItems.id, newlyHit.map((row) => row.itemId)),
        isNull(knowledgeItems.deletedAt)
      ))
      .returning({ itemId: knowledgeItems.id });
    if (updated.length !== newlyHit.length) throw new BrainError("BRAIN_ERR_NOT_FOUND", "Context feedback could not update every authorized item.", 404);

    const hitItems = await tx.select({
      itemId: contextSessionItems.itemId,
      accessPolicyId: contextSessionItems.accessPolicyId
    }).from(contextSessionItems).where(and(
      eq(contextSessionItems.tenantId, ctx.tenantId),
      eq(contextSessionItems.projectId, projectId),
      eq(contextSessionItems.actorId, ctx.actorId),
      eq(contextSessionItems.sessionId, sessionId),
      sql`${contextSessionItems.hitAt} IS NOT NULL`
    ));
    const newIds = new Set(newlyHit.map((row) => row.itemId));
    const pairKeys = new Set<string>();
    for (const fresh of newlyHit) {
      for (const hit of hitItems) {
        if (fresh.itemId === hit.itemId) continue;
        const [left, right] = [fresh.itemId, hit.itemId].sort();
        if (newIds.has(hit.itemId) && hit.itemId !== left) continue;
        const pairKey = `${left}\u0000${right}`;
        if (pairKeys.has(pairKey)) continue;
        pairKeys.add(pairKey);
        const leftItem = left === fresh.itemId ? fresh : hit;
        const rightItem = right === fresh.itemId ? fresh : hit;
        for (const [from, to] of [[leftItem, rightItem], [rightItem, leftItem]]) {
          await tx.execute(sql`
            INSERT INTO public.knowledge_relations (
              tenant_id, from_project_id, to_project_id, from_item_id, to_item_id,
              from_policy_id, to_policy_id, relation_type, is_inferred, confidence
            ) VALUES (
              ${ctx.tenantId}, ${projectId}, ${projectId}, ${from.itemId}, ${to.itemId},
              ${from.accessPolicyId}, ${to.accessPolicyId}, 'CO_ACCESSED_WITH', true, 0.5
            )
            ON CONFLICT ON CONSTRAINT knowledge_relations_identity_uq DO UPDATE
              SET confidence = LEAST(1.0, knowledge_relations.confidence + 0.1), created_at = now()
              WHERE knowledge_relations.is_inferred AND EXCLUDED.is_inferred
          `);
        }
      }
    }
  }
  return newlyHit;
}

