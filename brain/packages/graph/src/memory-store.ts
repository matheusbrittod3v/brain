import type { AuthContext } from "@brain/auth";
import { encodeGraphNodeKey, type GraphEdge, type GraphStoreContract, type TraversalHit, type TraversalOrigin } from "./types.js";

export class KnowledgeGraphStore implements GraphStoreContract {
  private readonly edges: GraphEdge[] = [];

  addEdge(edge: GraphEdge): void {
    const exists = this.edges.some(
      (e) =>
        e.tenantId === edge.tenantId &&
        e.fromProjectId === edge.fromProjectId &&
        e.toProjectId === edge.toProjectId &&
        e.fromItemId === edge.fromItemId &&
        e.toItemId === edge.toItemId &&
        e.relationType === edge.relationType
    );
    if (!exists) this.edges.push(edge);
  }

  traverseRelated(ctx: AuthContext, start: string | TraversalOrigin, maxDepth = 2): TraversalHit[] {
    if (maxDepth <= 0) {
      return [];
    }

    const allowedProjects = new Set(ctx.allowedProjects);
    const allowedPolicies = new Set(ctx.allowedPolicies);
    if (allowedProjects.size === 0 || allowedPolicies.size === 0) {
      return [];
    }

    const startItemId = typeof start === "string" ? start : start.itemId;
    let resolvedStartProjectId = typeof start === "string" ? undefined : start.projectId;

    if (resolvedStartProjectId !== undefined && !allowedProjects.has(resolvedStartProjectId)) {
      return [];
    }

    if (resolvedStartProjectId === undefined) {
      const matchingOriginProjects = new Set<string>();
      for (const edge of this.edges) {
        if (edge.tenantId !== ctx.tenantId) continue;
        if (!allowedProjects.has(edge.fromProjectId) || !allowedProjects.has(edge.toProjectId)) continue;
        if (!allowedPolicies.has(edge.fromPolicyId) || !allowedPolicies.has(edge.toPolicyId)) continue;
        if (edge.fromItemId === startItemId) {
          matchingOriginProjects.add(edge.fromProjectId);
        }
        if (edge.toItemId === startItemId) {
          matchingOriginProjects.add(edge.toProjectId);
        }
      }

      if (matchingOriginProjects.size === 0) {
        return [];
      }
      if (matchingOriginProjects.size > 1) {
        throw new Error(
          `Ambiguous homonymous start itemId '${startItemId}' across multiple authorized projects; pass TraversalOrigin { projectId, itemId }.`
        );
      }
      resolvedStartProjectId = [...matchingOriginProjects][0]!;
    }

    const visited = new Set<string>([encodeGraphNodeKey(resolvedStartProjectId, startItemId)]);
    const queue: Array<{ projectId: string; id: string; depth: number }> = [
      { projectId: resolvedStartProjectId, id: startItemId, depth: 0 }
    ];
    const hits: TraversalHit[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      for (const edge of this.edges) {
        if (edge.tenantId !== ctx.tenantId) continue;
        if (!allowedProjects.has(edge.fromProjectId) || !allowedProjects.has(edge.toProjectId)) continue;
        if (!allowedPolicies.has(edge.fromPolicyId) || !allowedPolicies.has(edge.toPolicyId)) continue;

        let neighborId: string | null = null;
        let neighborProject = "";

        const matchesFrom =
          edge.fromItemId === current.id && edge.fromProjectId === current.projectId;
        const matchesTo =
          edge.toItemId === current.id && edge.toProjectId === current.projectId;

        if (matchesFrom) {
          neighborId = edge.toItemId;
          neighborProject = edge.toProjectId;
        } else if (matchesTo) {
          neighborId = edge.fromItemId;
          neighborProject = edge.fromProjectId;
        }

        if (neighborId) {
          const visitKey = encodeGraphNodeKey(neighborProject, neighborId);
          if (!visited.has(visitKey)) {
            visited.add(visitKey);
            hits.push({
              itemId: neighborId,
              projectId: neighborProject,
              hops: current.depth + 1,
              via: edge.relationType,
              isInferred: edge.isInferred
            });
            queue.push({ projectId: neighborProject, id: neighborId, depth: current.depth + 1 });
          }
        }
      }
    }

    return hits;
  }
}

