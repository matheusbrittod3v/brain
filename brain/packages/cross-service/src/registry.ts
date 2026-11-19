import type { AuthContext } from "@brain/auth";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext,
  type RlsSqlClient
} from "@brain/database";
import type { CrossServiceContractEdge, DistributedBlastRadius, ServiceContractRelation } from "./types.js";

function buildBlastRadius(
  contractId: string,
  visible: readonly CrossServiceContractEdge[]
): DistributedBlastRadius {
  const impactedProjects = [...new Set(visible.flatMap((e) => [e.fromProjectId, e.toProjectId]))];
  const impactedServices = visible.map((e) => ({
    projectId: e.fromProjectId,
    service: e.fromService,
    relation: e.relation
  }));
  return { contractId, impactedProjects, impactedServices };
}

/**
 * In-memory Cross-Service Contract Registry & Dependency Radar.
 */
export class CrossServiceContractRegistry {
  private readonly edges: CrossServiceContractEdge[] = [];

  registerContract(edge: CrossServiceContractEdge): void {
    this.edges.push(edge);
  }

  getContracts(ctx: AuthContext, projectIds?: readonly string[]): CrossServiceContractEdge[] {
    return this.edges.filter(
      (e) =>
        e.tenantId === ctx.tenantId &&
        ctx.allowedProjects.includes(e.fromProjectId) &&
        ctx.allowedProjects.includes(e.toProjectId) &&
        ctx.allowedPolicies.includes(e.accessPolicyId) &&
        (!projectIds ||
          projectIds.includes(e.fromProjectId) ||
          projectIds.includes(e.toProjectId))
    );
  }

  computeDistributedBlastRadius(ctx: AuthContext, contractId: string): DistributedBlastRadius {
    const visible = this.edges.filter(
      (e) =>
        e.tenantId === ctx.tenantId &&
        e.contractId === contractId &&
        ctx.allowedProjects.includes(e.fromProjectId) &&
        ctx.allowedProjects.includes(e.toProjectId) &&
        ctx.allowedPolicies.includes(e.accessPolicyId)
    );
    return buildBlastRadius(contractId, visible);
  }

  buildFederatedContextPack(ctx: AuthContext, projectIds: string[]): {
    projects: string[];
    contracts: CrossServiceContractEdge[];
  } {
    const allowed = projectIds.filter((p) => ctx.allowedProjects.includes(p));
    const contracts = this.edges.filter(
      (e) =>
        e.tenantId === ctx.tenantId &&
        (allowed.includes(e.fromProjectId) || allowed.includes(e.toProjectId)) &&
        ctx.allowedProjects.includes(e.fromProjectId) &&
        ctx.allowedProjects.includes(e.toProjectId) &&
        ctx.allowedPolicies.includes(e.accessPolicyId)
    );
    return { projects: allowed, contracts };
  }
}

export type CrossServiceSqlTransactionRunner = {
  (template: TemplateStringsArray, ...parameters: readonly unknown[]): PromiseLike<unknown>;
};

interface CrossServiceContractRow {
  tenant_id: string;
  from_project_id: string;
  from_service: string;
  relation: ServiceContractRelation;
  to_project_id: string;
  contract_id: string;
  schema_version: string;
  access_policy_id: string;
}

function rowToEdge(row: CrossServiceContractRow): CrossServiceContractEdge {
  return {
    tenantId: row.tenant_id,
    fromProjectId: row.from_project_id,
    fromService: row.from_service,
    relation: row.relation,
    toProjectId: row.to_project_id,
    contractId: row.contract_id,
    schemaVersion: row.schema_version,
    accessPolicyId: row.access_policy_id
  };
}

/**
 * PostgreSQL-backed Cross-Service Contract Registry executing inside `@brain/database`
 * `withRlsTransaction` against the `cross_service_contracts` table.
 */
export class PostgresCrossServiceRegistry<
  TTx extends CrossServiceSqlTransactionRunner = CrossServiceSqlTransactionRunner
> {
  private readonly runInRlsTransaction: <T>(
    context: RlsSessionContext,
    callback: (tx: TTx) => Promise<T> | T
  ) => Promise<T>;
  private readonly defaultContext?: RlsSessionContext;
  private readonly resolvedDefaultContext?: ResolvedRlsSessionGucs;

  constructor(
    client: AppPostgresClient<TTx> | RlsSqlClient<TTx>,
    defaultContext?: RlsSessionContext
  ) {
    if (
      client &&
      typeof client === "object" &&
      "withRlsTransaction" in client &&
      typeof client.withRlsTransaction === "function"
    ) {
      this.runInRlsTransaction = (ctx, cb) => client.withRlsTransaction(ctx, cb);
    } else if (
      client &&
      typeof client === "object" &&
      "begin" in client &&
      typeof client.begin === "function"
    ) {
      this.runInRlsTransaction = (ctx, cb) => withRlsTransaction(client, ctx, cb);
    } else {
      throw new Error(
        "PostgresCrossServiceRegistry requires an AppPostgresClient (withRlsTransaction) or RlsSqlClient (begin)."
      );
    }

    if (defaultContext !== undefined) {
      this.resolvedDefaultContext = resolveRlsSessionContext(defaultContext);
      this.defaultContext = {
        tenantId: this.resolvedDefaultContext.tenantId,
        allowedProjects: this.resolvedDefaultContext.allowedProjectsCsv.split(","),
        allowedPolicies: this.resolvedDefaultContext.allowedPoliciesCsv.split(",")
      };
    }
  }

  private resolveContext(callerContext?: AuthContext | RlsSessionContext): RlsSessionContext {
    const raw = callerContext ?? this.defaultContext;
    if (!raw) {
      throw new Error("PostgresCrossServiceRegistry requires an explicit RlsSessionContext or AuthContext.");
    }
    const resolved = resolveRlsSessionContext({
      tenantId: raw.tenantId,
      allowedProjects: raw.allowedProjects,
      allowedPolicies: raw.allowedPolicies
    });
    if (this.resolvedDefaultContext && resolved.tenantId !== this.resolvedDefaultContext.tenantId) {
      throw new Error(
        `Context tenantId '${resolved.tenantId}' does not match registry RLS tenantId '${this.resolvedDefaultContext.tenantId}'.`
      );
    }
    return {
      tenantId: resolved.tenantId,
      allowedProjects: resolved.allowedProjectsCsv.split(","),
      allowedPolicies: resolved.allowedPoliciesCsv.split(",")
    };
  }

  async registerContract(
    edge: CrossServiceContractEdge,
    ctx?: AuthContext | RlsSessionContext
  ): Promise<void> {
    const rlsContext = this.resolveContext(ctx);
    if (edge.tenantId !== rlsContext.tenantId) {
      throw new Error(
        `Cross-service edge tenantId '${edge.tenantId}' does not match RLS context tenantId '${rlsContext.tenantId}'.`
      );
    }

    await this.runInRlsTransaction(rlsContext, async (tx) => {
      await tx`
        INSERT INTO cross_service_contracts (
          tenant_id,
          from_project_id,
          from_service,
          relation,
          to_project_id,
          contract_id,
          schema_version,
          access_policy_id
        ) VALUES (
          ${edge.tenantId},
          ${edge.fromProjectId},
          ${edge.fromService},
          ${edge.relation},
          ${edge.toProjectId},
          ${edge.contractId},
          ${edge.schemaVersion},
          ${edge.accessPolicyId}
        )
      `;
    });
  }

  async computeDistributedBlastRadius(
    ctx: AuthContext,
    contractId: string
  ): Promise<DistributedBlastRadius> {
    const rlsContext = this.resolveContext(ctx);
    const rows = (await this.runInRlsTransaction(rlsContext, async (tx) => {
      return (await tx`
        SELECT
          tenant_id,
          from_project_id,
          from_service,
          relation,
          to_project_id,
          contract_id,
          schema_version,
          access_policy_id
        FROM cross_service_contracts
        WHERE tenant_id = ${ctx.tenantId}
          AND contract_id = ${contractId}
      `) as CrossServiceContractRow[];
    })) ?? [];

    const visible = rows
      .map(rowToEdge)
      .filter(
        (e) =>
          e.tenantId === ctx.tenantId &&
          e.contractId === contractId &&
          ctx.allowedProjects.includes(e.fromProjectId) &&
          ctx.allowedProjects.includes(e.toProjectId) &&
          ctx.allowedPolicies.includes(e.accessPolicyId)
      );

    return buildBlastRadius(contractId, visible);
  }

  async buildFederatedContextPack(
    ctx: AuthContext,
    projectIds: string[]
  ): Promise<{ projects: string[]; contracts: CrossServiceContractEdge[] }> {
    const allowed = projectIds.filter((p) => ctx.allowedProjects.includes(p));
    if (allowed.length === 0) {
      return { projects: [], contracts: [] };
    }

    const rlsContext = this.resolveContext(ctx);
    const rows = (await this.runInRlsTransaction(rlsContext, async (tx) => {
      return (await tx`
        SELECT
          tenant_id,
          from_project_id,
          from_service,
          relation,
          to_project_id,
          contract_id,
          schema_version,
          access_policy_id
        FROM cross_service_contracts
        WHERE tenant_id = ${ctx.tenantId}
      `) as CrossServiceContractRow[];
    })) ?? [];

    const contracts = rows
      .map(rowToEdge)
      .filter(
        (e) =>
          e.tenantId === ctx.tenantId &&
          (allowed.includes(e.fromProjectId) || allowed.includes(e.toProjectId)) &&
          ctx.allowedProjects.includes(e.fromProjectId) &&
          ctx.allowedProjects.includes(e.toProjectId) &&
          ctx.allowedPolicies.includes(e.accessPolicyId)
      );

    return { projects: allowed, contracts };
  }

  async getContracts(ctx: AuthContext, projectIds?: readonly string[]): Promise<CrossServiceContractEdge[]> {
    const targetProjects = projectIds ? [...projectIds] : [...ctx.allowedProjects];
    const { contracts } = await this.buildFederatedContextPack(ctx, targetProjects);
    return contracts;
  }
}

