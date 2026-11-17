import { BrainError } from "@noema/core";
import { createRemoteJWKSet, customFetch, importSPKI, jwtVerify } from "jose";

export type ActorType = "human" | "agent" | "system";

export interface AuthContext {
  tenantId: string;
  actorId: string;
  actorType: ActorType;
  roles: string[];
  allowedProjects: string[];
  allowedPolicies: string[];
  agentId?: string;
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

export function canApproveDomain(ctx: AuthContext, domainId: number): boolean {
  if (ctx.actorType === "agent") return false; // Agentes nunca aprovam conhecimento oficial
  if (!CRITICAL_DOMAINS.has(domainId)) return true;
  return ctx.roles.some((r) => ["admin", "tech-lead", "product-owner", "appsec"].includes(r));
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

export interface OpaPolicyInput {
  projectId: string;
  accessPolicyId: string;
  action: PolicyAction;
  tenantId?: string;
  domainId?: number;
}

function evaluateLocalOpaFallback(ctx: AuthContext, input: OpaPolicyInput): boolean {
  if (!ctx.tenantId || typeof ctx.tenantId !== "string") {
    return false;
  }
  if (input.tenantId !== undefined && input.tenantId !== ctx.tenantId) {
    return false;
  }
  if (!input.projectId || !ctx.allowedProjects.includes(input.projectId)) {
    return false;
  }
  if (!input.accessPolicyId || !ctx.allowedPolicies.includes(input.accessPolicyId)) {
    return false;
  }
  if (input.action === "read") {
    return true;
  }
  if (WRITE_ACTIONS.has(input.action)) {
    return ctx.roles.some((role) => WRITE_ROLES.has(role));
  }
  if (input.action === "approve") {
    if (ctx.actorType !== "human") {
      return false;
    }
    const allowedRoles =
      input.domainId !== undefined && CRITICAL_DOMAINS.has(input.domainId)
        ? CRITICAL_APPROVE_ROLES
        : STANDARD_APPROVE_ROLES;
    return ctx.roles.some((role) => allowedRoles.has(role));
  }
  return false;
}

/**
 * Consulta servidor OPA externo (/v1/data/noema/authz/allow) com fallback determinístico fail-closed.
 */
export async function evaluateOpaPolicy(
  ctx: AuthContext,
  input: OpaPolicyInput,
  opaUrl = process.env.OPA_URL,
  fetchFn: typeof fetch = fetch
): Promise<boolean> {
  if (!evaluateLocalOpaFallback(ctx, input)) {
    return false;
  }
  if (!opaUrl) {
    return true;
  }
  const res = await fetchFn(`${opaUrl}/v1/data/noema/authz/allow`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: { subject: ctx, resource: input } })
  });
  if (!res.ok) return false;
  const body = (await res.json()) as { result?: boolean };
  return body.result === true;
}

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
  expectedApiKey: string | undefined = process.env.NOEMA_LOCAL_API_KEY,
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
  if (oidcConfigured && token.split(".").length === 3) {
    return verifyOidcJwt(token, oidcOpts);
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

