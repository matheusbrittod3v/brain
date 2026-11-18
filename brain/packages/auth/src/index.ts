import { BrainError } from "@brain/core";
import { createRemoteJWKSet, customFetch, importSPKI, jwtVerify } from "jose";
import { verifyUserJwt } from "./jwt.js";

export * from "./password.js";
export * from "./email.js";
export * from "./jwt.js";
export * from "./oauth2.js";
export * from "./users-store.js";
export * from "./casl.js";
export * from "./better-auth.js";

export type ActorType = "human" | "agent" | "system";

export type FineGrainedAction =
  | "read"
  | "write"
  | "create"
  | "update"
  | "approve"
  | "manage_policies";

export interface UserFineGrainedPolicy {
  userId: string;
  linkedAgentIds: string[];
  inheritUserPermissions: boolean;
  roles: string[];
  allowedActions: FineGrainedAction[];
  allowedPolicies: string[];
  allowedDomains: number[];
  allowedPathPrefixes: string[];
  updatedAt?: string;
  updatedBy?: string;
}

export const PERMISSION_CATALOG = [
  // Menus / Guias
  { id: "menu:inbox", group: "Menu & Guias", label: "Ver Caixa de Entrada" },
  { id: "menu:projects", group: "Menu & Guias", label: "Ver Projetos" },
  { id: "menu:knowledge", group: "Menu & Guias", label: "Ver Conhecimento" },
  { id: "menu:search", group: "Menu & Guias", label: "Ver Busca & Grafo" },
  { id: "menu:agents", group: "Menu & Guias", label: "Ver Agentes & Runner" },
  { id: "menu:impact", group: "Menu & Guias", label: "Ver Impacto" },
  { id: "menu:operations", group: "Menu & Guias", label: "Ver Operação & FinOps" },
  { id: "menu:access", group: "Menu & Guias", label: "Ver Acesso & Cargos" },
  { id: "menu:templates", group: "Menu & Guias", label: "Ver Templates" },
  { id: "menu:enterprise", group: "Menu & Guias", label: "Ver Visões Corporativas" },
  // Conhecimento
  { id: "knowledge:view", group: "Conhecimento", label: "Ver itens na listagem" },
  { id: "knowledge:read", group: "Conhecimento", label: "Ler conteúdo completo dos itens" },
  { id: "knowledge:search", group: "Conhecimento", label: "Consultar busca semântica & grafo" },
  { id: "knowledge:write", group: "Conhecimento", label: "Criar, ingerir e editar rascunhos" },
  { id: "knowledge:approve", group: "Conhecimento", label: "Aprovar e alterar status oficial" },
  { id: "knowledge:delete", group: "Conhecimento", label: "Deprecar ou remover itens" },
  // Propostas
  { id: "proposals:view", group: "Propostas", label: "Ver propostas na caixa de entrada" },
  { id: "proposals:create", group: "Propostas", label: "Propor alterações de conhecimento" },
  { id: "proposals:decide", group: "Propostas", label: "Aprovar, revisar ou rejeitar propostas" },
  // Projetos & Agentes
  { id: "projects:create", group: "Projetos & Runner", label: "Criar e atualizar projetos" },
  { id: "runner:view", group: "Projetos & Runner", label: "Ver execuções do Brain Runner" },
  { id: "runner:execute", group: "Projetos & Runner", label: "Executar e delegar tarefas ao Runner" },
  { id: "runner:cancel", group: "Projetos & Runner", label: "Cancelar tarefas do Runner" },
  // Impacto, Integrações, FinOps & Auditoria
  { id: "impact:analyze", group: "Operação & Governança", label: "Executar análise de impacto" },
  { id: "integrations:view", group: "Operação & Governança", label: "Ver status de integrações" },
  { id: "integrations:manage", group: "Operação & Governança", label: "Ingerir GitHub e configurar integrações" },
  { id: "finops:view", group: "Operação & Governança", label: "Ver métricas de FinOps" },
  { id: "finops:manage", group: "Operação & Governança", label: "Configurar cotas FinOps" },
  { id: "audit:view", group: "Operação & Governança", label: "Consultar logs de auditoria" },
  { id: "templates:view", group: "Operação & Governança", label: "Ver recomendações de templates" },
  { id: "enterprise:view", group: "Operação & Governança", label: "Ver visões corporativas e Tech Radar" },
  // Cargos & Permissões
  { id: "roles:view", group: "Cargos & Permissões", label: "Ver cargos, permissões e atribuições" },
  { id: "roles:manage", group: "Cargos & Permissões", label: "Criar, editar e excluir cargos e permissões" },
  { id: "users:assign_roles", group: "Cargos & Permissões", label: "Atribuir cargos e agentes vinculados a usuários" }
] as const;

export type SystemPermission = (typeof PERMISSION_CATALOG)[number]["id"];
export const ALL_SYSTEM_PERMISSIONS: SystemPermission[] = PERMISSION_CATALOG.map((p) => p.id);

export interface RoleDefinition {
  roleId: string;
  name: string;
  description: string;
  permissions: SystemPermission[];
  allowedPolicies: string[];
  isSystem?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface UserRoleAssignment {
  userId: string;
  roleIds: string[];
  linkedAgentIds: string[];
  inheritUserPermissions: boolean;
  extraPermissions: SystemPermission[];
  deniedPermissions: SystemPermission[];
  allowedDomains: number[];
  updatedAt?: string;
  updatedBy?: string;
}

export const DEFAULT_ROLES: RoleDefinition[] = [
  {
    roleId: "admin",
    name: "Administrador",
    description: "Acesso total a todos os módulos, aprovações, cargos e permissões.",
    permissions: [...ALL_SYSTEM_PERMISSIONS],
    allowedPolicies: ["public-org", "internal-project", "confidential-business", "restricted-security"],
    isSystem: true
  },
  {
    roleId: "tech-lead",
    name: "Tech Lead",
    description: "Aprova conhecimento e propostas, analisa impacto, executa runner e visualiza operação.",
    permissions: ALL_SYSTEM_PERMISSIONS.filter((p) => p !== "roles:manage"),
    allowedPolicies: ["public-org", "internal-project", "confidential-business"],
    isSystem: true
  },
  {
    roleId: "developer",
    name: "Desenvolvedor",
    description: "Consulta, cria e edita rascunhos, busca no grafo e executa tarefas no Runner.",
    permissions: [
      "menu:inbox",
      "menu:projects",
      "menu:knowledge",
      "menu:search",
      "menu:agents",
      "menu:impact",
      "menu:templates",
      "knowledge:view",
      "knowledge:read",
      "knowledge:search",
      "knowledge:write",
      "proposals:view",
      "proposals:create",
      "runner:view",
      "runner:execute",
      "impact:analyze",
      "templates:view"
    ],
    allowedPolicies: ["public-org", "internal-project"],
    isSystem: true
  },
  {
    roleId: "viewer",
    name: "Leitor",
    description: "Acesso somente leitura a projetos, conhecimento, busca e templates.",
    permissions: [
      "menu:projects",
      "menu:knowledge",
      "menu:search",
      "menu:templates",
      "knowledge:view",
      "knowledge:read",
      "knowledge:search",
      "templates:view"
    ],
    allowedPolicies: ["public-org", "internal-project"],
    isSystem: true
  }
];

export interface AuthContext {
  tenantId: string;
  actorId: string;
  actorType: ActorType;
  roles: string[];
  allowedProjects: string[];
  allowedPolicies: string[];
  agentId?: string;
  linkedUserId?: string;
  inheritUserPermissions?: boolean;
  allowedActions?: FineGrainedAction[];
  allowedDomains?: number[];
  allowedPathPrefixes?: string[];
  permissions?: SystemPermission[];
  assignedRoleIds?: string[];
}

const CRITICAL_DOMAINS = new Set([1, 2, 3, 7, 11]);
const WRITE_ACTIONS = new Set<PolicyAction>(["write", "create", "update"]);
const WRITE_ROLES = new Set(["developer", "tech-lead", "admin", "ci-bot", "agent"]);
const CRITICAL_APPROVE_ROLES = new Set(["tech-lead", "admin", "appsec"]);
const STANDARD_APPROVE_ROLES = new Set(["tech-lead", "admin", "appsec", "product-owner"]);

/**
 * Autentica requisições locais via API Key ou prepara contexto OIDC.
 * `allowedProjects` deve vir de configuração/identidade confiável; sem escopo,
 * o contexto autentica sem acesso a projetos.
 */
export function authenticateApiKey(
  headerValue: string | undefined,
  expectedKey: string,
  tenantId = "default-org",
  allowedProjects?: readonly string[],
  allowedPolicies?: readonly string[]
): AuthContext {
  if (!headerValue) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Credencial ausente.", 401);
  }
  const token = headerValue.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Credencial ausente.", 401);
  }
  if (!expectedKey || expectedKey.trim().length === 0 || token !== expectedKey) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Credencial inválida.", 401);
  }
  return {
    tenantId,
    actorId: "local-dev",
    actorType: "human",
    roles: ["admin", "developer"],
    allowedProjects: [...(allowedProjects ?? [])],
    allowedPolicies: [...(allowedPolicies ?? ["public-org", "internal-project", "confidential-business"])]
  };
}

export function assertProjectAccess(ctx: AuthContext, projectId: string): void {
  if (!ctx.allowedProjects.includes(projectId)) {
    throw new BrainError(
      "BRAIN_ERR_POLICY_DENIED",
      `Acesso negado ao projeto '${projectId}'.`,
      403
    );
  }
}

export function assertPolicyAccess(ctx: AuthContext, accessPolicyId: string): void {
  if (!ctx.allowedPolicies.includes(accessPolicyId)) {
    throw new BrainError(
      "BRAIN_ERR_POLICY_DENIED",
      `Acesso negado à política '${accessPolicyId}'.`,
      403
    );
  }
}

export function resolveDefaultPermissionsForRoles(
  roles: readonly string[],
  rolesCatalog: readonly RoleDefinition[] = DEFAULT_ROLES
): SystemPermission[] {
  const byId = new Map(rolesCatalog.map((r) => [r.roleId, r]));
  const perms = new Set<SystemPermission>();
  for (const roleId of roles) {
    const def = byId.get(roleId);
    if (def) {
      for (const p of def.permissions) perms.add(p);
    }
  }
  return [...perms];
}

export function hasPermission(ctx: AuthContext, permission: SystemPermission): boolean {
  if (ctx.permissions) {
    return ctx.permissions.includes(permission);
  }
  if (ctx.roles.includes("admin")) {
    return true;
  }
  return resolveDefaultPermissionsForRoles(ctx.roles).includes(permission);
}

export function assertPermission(ctx: AuthContext, permission: SystemPermission): void {
  if (!hasPermission(ctx, permission)) {
    throw new BrainError(
      "BRAIN_ERR_POLICY_DENIED",
      `Permissão '${permission}' necessária para esta operação.`,
      403
    );
  }
}

export function applyUserRoleAssignment(
  ctx: AuthContext,
  assignment: UserRoleAssignment,
  rolesCatalog: readonly RoleDefinition[]
): AuthContext {
  const isUserMatch = ctx.actorId === assignment.userId;
  const isLinkedAgentMatch =
    ctx.actorType === "agent" &&
    assignment.inheritUserPermissions &&
    (assignment.linkedAgentIds.includes("*") ||
      assignment.linkedAgentIds.includes(ctx.actorId) ||
      (ctx.agentId !== undefined && assignment.linkedAgentIds.includes(ctx.agentId)));

  if (!isUserMatch && !isLinkedAgentMatch) {
    return ctx;
  }

  const byId = new Map(rolesCatalog.map((r) => [r.roleId, r]));
  const perms = new Set<SystemPermission>();
  const policies = new Set<string>(ctx.allowedPolicies);

  for (const roleId of assignment.roleIds) {
    const role = byId.get(roleId);
    if (!role) continue;
    for (const p of role.permissions) perms.add(p);
    for (const pol of role.allowedPolicies) policies.add(pol);
  }
  for (const extra of assignment.extraPermissions) perms.add(extra);
  for (const denied of assignment.deniedPermissions) perms.delete(denied);

  const effectiveActions: FineGrainedAction[] = [];
  if (perms.has("knowledge:read") || perms.has("knowledge:view") || perms.has("knowledge:search")) effectiveActions.push("read");
  if (perms.has("knowledge:write") || perms.has("proposals:create")) effectiveActions.push("write", "create", "update");
  if (perms.has("knowledge:approve") || perms.has("proposals:decide")) effectiveActions.push("approve");
  if (perms.has("roles:manage") || perms.has("users:assign_roles")) effectiveActions.push("manage_policies");

  return {
    ...ctx,
    roles: assignment.roleIds.length > 0 ? [...new Set(assignment.roleIds)] : ctx.roles,
    assignedRoleIds: [...assignment.roleIds],
    permissions: [...perms],
    allowedPolicies: [...policies],
    allowedActions: effectiveActions,
    allowedDomains: assignment.allowedDomains.length > 0 ? [...assignment.allowedDomains] : ctx.allowedDomains,
    linkedUserId: assignment.userId,
    inheritUserPermissions: isLinkedAgentMatch ? true : assignment.inheritUserPermissions
  };
}

export function canApproveDomain(ctx: AuthContext, domainId: number): boolean {
  if (ctx.allowedDomains && ctx.allowedDomains.length > 0 && !ctx.allowedDomains.includes(domainId)) {
    return false;
  }
  if (ctx.allowedActions && ctx.allowedActions.length > 0 && !ctx.allowedActions.includes("approve")) {
    return false;
  }
  const actsAsLinkedUser = ctx.actorType === "human" || Boolean(ctx.inheritUserPermissions);
  if (!actsAsLinkedUser && !ctx.allowedActions?.includes("approve")) {
    return false;
  }
  if (!CRITICAL_DOMAINS.has(domainId)) return true;
  return ctx.roles.some((r) => ["admin", "tech-lead", "product-owner", "appsec"].includes(r));
}

export function applyUserFineGrainedPolicy(
  ctx: AuthContext,
  policy: UserFineGrainedPolicy
): AuthContext {
  const isUserMatch = ctx.actorId === policy.userId;
  const isLinkedAgentMatch =
    ctx.actorType === "agent" &&
    policy.inheritUserPermissions &&
    (policy.linkedAgentIds.includes("*") ||
      policy.linkedAgentIds.includes(ctx.actorId) ||
      (ctx.agentId !== undefined && policy.linkedAgentIds.includes(ctx.agentId)));

  if (!isUserMatch && !isLinkedAgentMatch) {
    return ctx;
  }

  return {
    ...ctx,
    roles: policy.roles.length > 0 ? [...new Set([...ctx.roles, ...policy.roles])] : ctx.roles,
    allowedPolicies:
      policy.allowedPolicies.length > 0
        ? [...new Set([...ctx.allowedPolicies, ...policy.allowedPolicies])]
        : ctx.allowedPolicies,
    linkedUserId: policy.userId,
    inheritUserPermissions: isLinkedAgentMatch ? true : ctx.inheritUserPermissions,
    allowedActions: policy.allowedActions.length > 0 ? [...policy.allowedActions] : ctx.allowedActions,
    allowedDomains: policy.allowedDomains.length > 0 ? [...policy.allowedDomains] : ctx.allowedDomains,
    allowedPathPrefixes:
      policy.allowedPathPrefixes.length > 0 ? [...policy.allowedPathPrefixes] : ctx.allowedPathPrefixes
  };
}

export interface OidcClaims {
  sub: string;
  tenant_id: string;
  roles?: string[];
  allowed_projects?: string[];
  allowed_policies?: string[];
  agent_id?: string;
}

/**
 * Converte claims OIDC validados (On-Behalf-Of ou Client Credentials) em AuthContext.
 */
export function authenticateOidcClaims(claims: OidcClaims): AuthContext {
  if (!claims.sub || !claims.tenant_id) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Claims OIDC inválidos (sub/tenant_id).", 401);
  }
  return {
    tenantId: claims.tenant_id,
    actorId: claims.sub,
    actorType: claims.agent_id ? "agent" : "human",
    roles: claims.roles ?? ["developer"],
    allowedProjects: claims.allowed_projects ?? [],
    allowedPolicies: claims.allowed_policies ?? ["public-org", "internal-project"],
    agentId: claims.agent_id
  };
}

export type PolicyAction = "read" | "write" | "create" | "update" | "approve";

export interface VerifyOidcOptions {
  jwksUri?: string;
  hmacSecret?: string;
  publicKeyPem?: string;
  expectedIssuer?: string;
  expectedAudience?: string;
  fetchFn?: typeof fetch;
}

const remoteJwksCache = new WeakMap<typeof fetch, Map<string, ReturnType<typeof createRemoteJWKSet>>>();

function getRemoteJwks(jwksUri: string, fetchFn: typeof fetch = fetch): ReturnType<typeof createRemoteJWKSet> {
  let byUri = remoteJwksCache.get(fetchFn);
  if (!byUri) {
    byUri = new Map();
    remoteJwksCache.set(fetchFn, byUri);
  }
  const cached = byUri.get(jwksUri);
  if (cached) return cached;
  const resolver = createRemoteJWKSet(new URL(jwksUri), { [customFetch]: fetchFn });
  byUri.set(jwksUri, resolver);
  return resolver;
}

/**
 * Valida JWT OIDC usando jose (HS256 local ou RS256 via PEM/JWKS) e converte em AuthContext.
 */
export async function verifyOidcJwt(token: string, opts: VerifyOidcOptions = {}): Promise<AuthContext> {
  const algorithms: Array<"HS256" | "RS256"> = [];
  if (opts.hmacSecret) algorithms.push("HS256");
  if (opts.publicKeyPem || opts.jwksUri) algorithms.push("RS256");
  if (algorithms.length === 0) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Nenhum método de assinatura OIDC foi configurado.", 401);
  }

  try {
    const remoteJwks = opts.jwksUri ? getRemoteJwks(opts.jwksUri, opts.fetchFn) : undefined;
    const { payload } = await jwtVerify(token, async (protectedHeader, jws) => {
      if (protectedHeader.alg === "HS256" && opts.hmacSecret) {
        return new TextEncoder().encode(opts.hmacSecret);
      }
      if (protectedHeader.alg === "RS256" && opts.publicKeyPem) {
        return importSPKI(opts.publicKeyPem, "RS256");
      }
      if (protectedHeader.alg === "RS256" && remoteJwks) {
        return remoteJwks(protectedHeader, jws);
      }
      throw new Error("Algoritmo JWT não suportado ou chave correspondente ausente.");
    }, {
      algorithms,
      ...(opts.expectedIssuer ? { issuer: opts.expectedIssuer } : {}),
      ...(opts.expectedAudience ? { audience: opts.expectedAudience } : {})
    });

    const claims = payload as unknown as OidcClaims & { azp?: string; client_id?: string };
    const actorType: ActorType = claims.agent_id || claims.client_id || claims.azp ? "agent" : "human";
    const ctx = authenticateOidcClaims(claims);
    return {
      ...ctx,
      actorType,
      agentId: claims.agent_id ?? claims.client_id ?? claims.azp
    };
  } catch (error) {
    if (error instanceof BrainError) throw error;
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Token OIDC inválido.", 401);
  }
}

/**
 * Autentica via OIDC JWT (se OIDC_JWKS_URI/OIDC_HMAC_SECRET configurados e header parecer JWT) ou API Key local.
 */
export async function authenticateRequest(
  headerValue: string | undefined,
  expectedApiKey: string | undefined = process.env.BRAIN_LOCAL_API_KEY,
  tenantId = "default-org",
  allowedProjects?: readonly string[],
  oidcOpts: VerifyOidcOptions = {
    jwksUri: process.env.OIDC_JWKS_URI,
    hmacSecret: process.env.OIDC_HMAC_SECRET,
    publicKeyPem: process.env.OIDC_PUBLIC_KEY_PEM,
    expectedIssuer: process.env.OIDC_ISSUER,
    expectedAudience: process.env.OIDC_AUDIENCE
  },
  allowedPolicies?: readonly string[]
): Promise<AuthContext> {
  if (!headerValue) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Credencial ausente.", 401);
  }
  const token = headerValue.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Credencial ausente.", 401);
  }

  const oidcConfigured = Boolean(oidcOpts.jwksUri || oidcOpts.hmacSecret || oidcOpts.publicKeyPem);
  if (token.split(".").length === 3) {
    if (oidcConfigured) {
      try {
        return await verifyOidcJwt(token, oidcOpts);
      } catch {
        // Fallback to checking local signed user JWT
      }
    }
    try {
      return await verifyUserJwt(token);
    } catch {
      // Fallback to API Key check if needed
    }
  }

  const localApiKey = expectedApiKey?.trim();
  if (!localApiKey) {
    throw new BrainError(
      "BRAIN_ERR_UNAUTHORIZED",
      "Autenticação local por API Key não configurada.",
      401
    );
  }
  return authenticateApiKey(headerValue, localApiKey, tenantId, allowedProjects, allowedPolicies);
}

