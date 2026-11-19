import type { ResolvedRlsSessionGucs } from "@brain/database";
import type { TraversalHit } from "@brain/graph";
import { compositeItemKey } from "./helpers.js";
import type { RetrievalGraphWalkRow, RetrievalSqlTransactionRunner } from "./types.js";

/**
 * Executes a recursive CTE graph walk inside an active RLS transaction.
 */
export async function traverseGraphInTransaction<TTx extends RetrievalSqlTransactionRunner>(
  tx: TTx,
  resolved: ResolvedRlsSessionGucs,
  allowedProjects: Set<string>,
  seedProjectId: string,
  seedItemId: string,
  maxDepth: number
): Promise<TraversalHit[]> {
  const rows = await tx<RetrievalGraphWalkRow>`WITH RECURSIVE params AS (
    SELECT
      ${resolved.tenantId} AS tenant_id,
      ${seedProjectId} AS origin_project,
      ${seedItemId} AS origin_item,
      string_to_array(${resolved.allowedProjectsCsv}, ',') AS allowed_projects,
      string_to_array(${resolved.allowedPoliciesCsv}, ',') AS allowed_policies,
      ${maxDepth}::integer AS max_depth
  ),
  graph_walk AS (
    SELECT
      p.origin_project AS root_project_id,
      CASE
        WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
          THEN kr.to_project_id
        ELSE kr.from_project_id
      END AS project_id,
      CASE
        WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
          THEN kr.to_item_id
        ELSE kr.from_item_id
      END AS item_id,
      1 AS hops,
      kr.relation_type AS via,
      kr.is_inferred AS is_inferred,
      ARRAY[
        jsonb_build_array(p.origin_project, p.origin_item)::text,
        jsonb_build_array(
          CASE
            WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
              THEN kr.to_project_id
            ELSE kr.from_project_id
          END,
          CASE
            WHEN kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item
              THEN kr.to_item_id
            ELSE kr.from_item_id
          END
        )::text
      ] AS visited_path
    FROM knowledge_relations kr
    CROSS JOIN params p
    WHERE kr.tenant_id = p.tenant_id
      AND kr.from_project_id = ANY(p.allowed_projects)
      AND kr.to_project_id = ANY(p.allowed_projects)
      AND kr.from_policy_id = ANY(p.allowed_policies)
      AND kr.to_policy_id = ANY(p.allowed_policies)
      AND (
        (kr.from_project_id = p.origin_project AND kr.from_item_id = p.origin_item)
        OR
        (kr.to_project_id = p.origin_project AND kr.to_item_id = p.origin_item)
      )

    UNION ALL

    SELECT
      gw.root_project_id AS root_project_id,
      CASE
        WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
          THEN kr.to_project_id
        ELSE kr.from_project_id
      END AS project_id,
      CASE
        WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
          THEN kr.to_item_id
        ELSE kr.from_item_id
      END AS item_id,
      gw.hops + 1 AS hops,
      kr.relation_type AS via,
      kr.is_inferred AS is_inferred,
      gw.visited_path || jsonb_build_array(
        CASE
          WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
            THEN kr.to_project_id
          ELSE kr.from_project_id
        END,
        CASE
          WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
            THEN kr.to_item_id
          ELSE kr.from_item_id
        END
      )::text
    FROM graph_walk gw
    CROSS JOIN params p
    JOIN knowledge_relations kr
      ON kr.tenant_id = p.tenant_id
     AND (
       (kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id)
       OR
       (kr.to_project_id = gw.project_id AND kr.to_item_id = gw.item_id)
     )
    WHERE gw.hops < p.max_depth
      AND kr.from_project_id = ANY(p.allowed_projects)
      AND kr.to_project_id = ANY(p.allowed_projects)
      AND kr.from_policy_id = ANY(p.allowed_policies)
      AND kr.to_policy_id = ANY(p.allowed_policies)
      AND NOT (
        jsonb_build_array(
          CASE
            WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
              THEN kr.to_project_id
            ELSE kr.from_project_id
          END,
          CASE
            WHEN kr.from_project_id = gw.project_id AND kr.from_item_id = gw.item_id
              THEN kr.to_item_id
            ELSE kr.from_item_id
          END
        )::text = ANY(gw.visited_path)
      )
  )
  SELECT
    root_project_id,
    project_id,
    item_id,
    hops,
    via,
    is_inferred
  FROM graph_walk
  ORDER BY hops ASC`;

  const seen = new Set<string>([compositeItemKey(seedProjectId, seedItemId)]);
  const hits: TraversalHit[] = [];
  for (const row of rows) {
    const projId = String(row.project_id);
    const itemId = String(row.item_id);
    const hops = Number(row.hops);
    if (!allowedProjects.has(projId)) continue;
    if (!Number.isInteger(hops) || hops < 1 || hops > maxDepth) continue;
    const key = compositeItemKey(projId, itemId);
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      itemId,
      projectId: projId,
      hops,
      via: row.via,
      isInferred: Boolean(row.is_inferred)
    });
  }
  return hits;
}
