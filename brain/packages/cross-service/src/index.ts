import type { AuthContext } from "@brain/auth";
import {
  resolveRlsSessionContext,
  withRlsTransaction,
  type AppPostgresClient,
  type ResolvedRlsSessionGucs,
  type RlsSessionContext,
  type RlsSqlClient,
  type RlsTransactionRunner
} from "@brain/database";

export type ServiceContractRelation = "CONSUMES_API" | "PUBLISHES_EVENT" | "SUBSCRIBES_TO";
export type ServiceContractFormat = "openapi" | "asyncapi" | "protobuf";

export interface CrossServiceContractEdge {
  tenantId: string;
  fromProjectId: string;
  fromService: string;
  relation: ServiceContractRelation;
  toProjectId: string;
  contractId: string;
  schemaVersion: string;
  accessPolicyId: string;
}

export interface DistributedBlastRadius {
  contractId: string;
  impactedProjects: string[];
  impactedServices: Array<{ projectId: string; service: string; relation: ServiceContractRelation }>;
}

export interface ParsedServiceContractItem {
  kind: "endpoint" | "event" | "message" | "rpc";
  id: string;
  name: string;
  method?: string;
  path?: string;
  service?: string;
  relationHint: ServiceContractRelation;
}

export interface ParsedServiceContractSpec {
  format: ServiceContractFormat;
  title?: string;
  version: string;
  items: ParsedServiceContractItem[];
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

function tryParseJson(rawContent: string): Record<string, unknown> | null {
  const trimmed = rawContent.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function unquoteYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function sortContractItems(items: ParsedServiceContractItem[]): ParsedServiceContractItem[] {
  return [...items].sort((a, b) => {
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.id.localeCompare(b.id);
  });
}

function parseOpenApiSpec(rawContent: string): ParsedServiceContractSpec {
  const json = tryParseJson(rawContent);
  const items: ParsedServiceContractItem[] = [];
  let title: string | undefined;
  let version = "1.0.0";

  if (json) {
    const info = json.info as Record<string, unknown> | undefined;
    if (typeof info?.title === "string") title = info.title;
    if (typeof info?.version === "string") version = info.version;

    const paths = json.paths as Record<string, Record<string, unknown>> | undefined;
    if (paths && typeof paths === "object") {
      for (const pathKey of Object.keys(paths).sort()) {
        const pathObj = paths[pathKey];
        if (!pathObj || typeof pathObj !== "object") continue;
        for (const methodKey of Object.keys(pathObj).sort()) {
          const lower = methodKey.toLowerCase();
          if (!HTTP_METHODS.has(lower)) continue;
          const op = pathObj[methodKey] as Record<string, unknown> | undefined;
          const method = lower.toUpperCase();
          const id = `${method} ${pathKey}`;
          items.push({
            kind: "endpoint",
            id,
            name: typeof op?.operationId === "string" ? op.operationId : id,
            method,
            path: pathKey,
            relationHint: "CONSUMES_API"
          });
        }
      }
    }

    return {
      format: "openapi",
      ...(title ? { title } : {}),
      version,
      items: sortContractItems(items)
    };
  }

  // Deterministic line-based YAML extraction for OpenAPI
  let section: "root" | "info" | "paths" = "root";
  let currentPath: string | null = null;
  let pathIndent = -1;

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.search(/\S/);
    const trimmed = withoutComment.trim();

    if (indent === 0) {
      currentPath = null;
      if (trimmed === "info:") {
        section = "info";
      } else if (trimmed === "paths:") {
        section = "paths";
      } else {
        section = "root";
      }
      continue;
    }

    if (section === "info") {
      const match = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(trimmed);
      if (match) {
        if (match[1] === "title") title = unquoteYamlScalar(match[2]!);
        if (match[1] === "version") version = unquoteYamlScalar(match[2]!);
      }
    } else if (section === "paths") {
      if (trimmed.startsWith("/") && trimmed.endsWith(":")) {
        currentPath = trimmed.slice(0, -1).trim();
        pathIndent = indent;
      } else if (currentPath && indent > pathIndent) {
        const methodMatch = /^([a-zA-Z]+):\s*$/.exec(trimmed);
        if (methodMatch) {
          const lower = methodMatch[1]!.toLowerCase();
          if (HTTP_METHODS.has(lower)) {
            const method = lower.toUpperCase();
            const id = `${method} ${currentPath}`;
            items.push({
              kind: "endpoint",
              id,
              name: id,
              method,
              path: currentPath,
              relationHint: "CONSUMES_API"
            });
          }
        }
      }
    }
  }

  return {
    format: "openapi",
    ...(title ? { title } : {}),
    version,
    items: sortContractItems(items)
  };
}

function parseAsyncApiSpec(rawContent: string): ParsedServiceContractSpec {
  const json = tryParseJson(rawContent);
  const items: ParsedServiceContractItem[] = [];
  let title: string | undefined;
  let version = "1.0.0";

  if (json) {
    const info = json.info as Record<string, unknown> | undefined;
    if (typeof info?.title === "string") title = info.title;
    if (typeof info?.version === "string") version = info.version;

    const channels = json.channels as Record<string, Record<string, unknown>> | undefined;
    if (channels && typeof channels === "object") {
      for (const channelName of Object.keys(channels).sort()) {
        const ch = channels[channelName];
        if (!ch || typeof ch !== "object") continue;
        let matchedOp = false;
        if ("publish" in ch) {
          matchedOp = true;
          const pub = ch.publish as Record<string, unknown> | undefined;
          const msg = pub?.message as Record<string, unknown> | undefined;
          const name = typeof msg?.name === "string"
            ? msg.name
            : typeof pub?.operationId === "string"
              ? pub.operationId
              : channelName;
          items.push({
            kind: "event",
            id: channelName,
            name,
            path: channelName,
            relationHint: "PUBLISHES_EVENT"
          });
        }
        if ("subscribe" in ch) {
          matchedOp = true;
          const sub = ch.subscribe as Record<string, unknown> | undefined;
          const msg = sub?.message as Record<string, unknown> | undefined;
          const name = typeof msg?.name === "string"
            ? msg.name
            : typeof sub?.operationId === "string"
              ? sub.operationId
              : channelName;
          items.push({
            kind: "event",
            id: `${channelName}#subscribe`,
            name,
            path: channelName,
            relationHint: "SUBSCRIBES_TO"
          });
        }
        if (!matchedOp) {
          items.push({
            kind: "event",
            id: channelName,
            name: channelName,
            path: channelName,
            relationHint: "PUBLISHES_EVENT"
          });
        }
      }
    }

    return {
      format: "asyncapi",
      ...(title ? { title } : {}),
      version,
      items: sortContractItems(items)
    };
  }

  let section: "root" | "info" | "channels" = "root";
  let currentChannel: string | null = null;
  let channelIndent = -1;
  let currentChannelHasOp = false;

  const flushChannelFallback = () => {
    if (currentChannel && !currentChannelHasOp) {
      items.push({
        kind: "event",
        id: currentChannel,
        name: currentChannel,
        path: currentChannel,
        relationHint: "PUBLISHES_EVENT"
      });
    }
  };

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/\s+#.*$/, "");
    if (!withoutComment.trim()) continue;
    const indent = withoutComment.search(/\S/);
    const trimmed = withoutComment.trim();

    if (indent === 0) {
      flushChannelFallback();
      currentChannel = null;
      currentChannelHasOp = false;
      if (trimmed === "info:") section = "info";
      else if (trimmed === "channels:") section = "channels";
      else section = "root";
      continue;
    }

    if (section === "info") {
      const match = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(trimmed);
      if (match) {
        if (match[1] === "title") title = unquoteYamlScalar(match[2]!);
        if (match[1] === "version") version = unquoteYamlScalar(match[2]!);
      }
    } else if (section === "channels") {
      if (currentChannel === null || indent <= channelIndent) {
        if (trimmed.endsWith(":")) {
          flushChannelFallback();
          currentChannel = unquoteYamlScalar(trimmed.slice(0, -1));
          channelIndent = indent;
          currentChannelHasOp = false;
        }
      } else if (currentChannel && indent > channelIndent) {
        if (trimmed === "publish:") {
          currentChannelHasOp = true;
          items.push({
            kind: "event",
            id: currentChannel,
            name: currentChannel,
            path: currentChannel,
            relationHint: "PUBLISHES_EVENT"
          });
        } else if (trimmed === "subscribe:") {
          currentChannelHasOp = true;
          items.push({
            kind: "event",
            id: `${currentChannel}#subscribe`,
            name: currentChannel,
            path: currentChannel,
            relationHint: "SUBSCRIBES_TO"
          });
        }
      }
    }
  }
  flushChannelFallback();

  return {
    format: "asyncapi",
    ...(title ? { title } : {}),
    version,
    items: sortContractItems(items)
  };
}

function parseProtobufSpec(rawContent: string): ParsedServiceContractSpec {
  const items: ParsedServiceContractItem[] = [];
  let title: string | undefined;
  let version = "1.0.0";

  const pkgMatch = /^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m.exec(rawContent);
  if (pkgMatch) {
    title = pkgMatch[1];
    const verMatch = /\b(v\d+(?:alpha\d*|beta\d*)?)\b/.exec(pkgMatch[1]!);
    if (verMatch) {
      version = verMatch[1]!;
    }
  }

  let currentService: string | null = null;
  let serviceBraceDepth = 0;

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    const svcMatch = /^service\s+([A-Za-z0-9_]+)\s*\{/.exec(line);
    if (svcMatch) {
      currentService = svcMatch[1]!;
      serviceBraceDepth = 1;
      continue;
    }

    if (currentService) {
      const rpcMatch = /^rpc\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
      if (rpcMatch) {
        const rpcName = rpcMatch[1]!;
        items.push({
          kind: "rpc",
          id: `${currentService}.${rpcName}`,
          name: rpcName,
          method: rpcName,
          service: currentService,
          relationHint: "CONSUMES_API"
        });
      }
      for (const ch of line) {
        if (ch === "{") serviceBraceDepth += 1;
        else if (ch === "}") serviceBraceDepth -= 1;
      }
      if (serviceBraceDepth <= 0) {
        currentService = null;
        serviceBraceDepth = 0;
      }
      continue;
    }

    const msgMatch = /^message\s+([A-Za-z0-9_]+)\s*\{/.exec(line);
    if (msgMatch) {
      const msgName = msgMatch[1]!;
      items.push({
        kind: "message",
        id: msgName,
        name: msgName,
        relationHint: "PUBLISHES_EVENT"
      });
    }
  }

  return {
    format: "protobuf",
    ...(title ? { title } : {}),
    version,
    items: sortContractItems(items)
  };
}

/**
 * Deterministically parses OpenAPI, AsyncAPI, or Protobuf specifications into
 * normalized endpoints, events, messages, and RPC contracts.
 */
export function parseServiceContractSpec(
  rawContent: string,
  format: ServiceContractFormat
): ParsedServiceContractSpec {
  if (format === "openapi") return parseOpenApiSpec(rawContent);
  if (format === "asyncapi") return parseAsyncApiSpec(rawContent);
  if (format === "protobuf") return parseProtobufSpec(rawContent);
  throw new Error(`Unsupported service contract format '${String(format)}'.`);
}

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
