import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { issueUserJwt, type AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgAuthRepository, PgMcpAuthRepository } from "@brain/database";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

const memoryClients = new Map<
  string,
  { clientId: string; clientName: string; redirectUris: string[]; grantTypes: string[]; scope: string }
>();
const memoryAuthCodes = new Map<
  string,
  {
    code: string;
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    allowedProjects: string[];
    expiresAt: Date;
    consumedAt: Date | null;
  }
>();

export function registerOAuthPkceRoutes(
  app: FastifyInstance,
  deps: {
    authenticateRequest: (headerValue: string | undefined) => Promise<AuthContext>;
    authRepo?: PgAuthRepository;
    mcpAuthRepo?: PgMcpAuthRepository;
  }
): void {
  // RFC 7591: Dynamic Client Registration
  app.post<{
    Body: {
      client_name?: string;
      redirect_uris?: string[];
      grant_types?: string[];
      scope?: string;
    };
  }>("/oauth/register", async (req, reply) => {
    const redirectUris = Array.isArray(req.body?.redirect_uris)
      ? req.body.redirect_uris.map((u) => String(u).trim()).filter(Boolean)
      : [];
    if (redirectUris.length === 0) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "redirect_uris é obrigatório para Dynamic Client Registration.", 400);
    }

    const clientId = `mcp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const clientName = req.body?.client_name?.trim() || "MCP Client (OAuth 2.1)";
    const grantTypes = Array.isArray(req.body?.grant_types) && req.body.grant_types.length > 0
      ? req.body.grant_types
      : ["authorization_code", "refresh_token"];
    const scope = req.body?.scope?.trim() || "projects:all knowledge:read knowledge:write";

    if (deps.mcpAuthRepo) {
      await deps.mcpAuthRepo.registerOAuthClient({ clientId, clientName, redirectUris, grantTypes, scope });
    } else {
      memoryClients.set(clientId, { clientId, clientName, redirectUris, grantTypes, scope });
    }

    reply.code(201);
    return {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope
    };
  });

  // Consultar cliente registrado para tela de consentimento (/auth/oauth)
  app.get<{ Params: { clientId: string } }>("/v1/auth/oauth/client/:clientId", async (req) => {
    const client = deps.mcpAuthRepo
      ? await deps.mcpAuthRepo.findOAuthClient(req.params.clientId)
      : memoryClients.get(req.params.clientId);
    if (!client) {
      return {
        clientId: req.params.clientId,
        clientName: req.params.clientId,
        redirectUris: [] as string[],
        scope: "projects:all"
      };
    }
    return client;
  });

  // Autorização OAuth 2.1 PKCE pela Web UI (/auth/oauth)
  app.post<{
    Body: {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      codeChallengeMethod?: string;
      scope?: string;
      allowedProjects?: string[];
      state?: string;
    };
  }>("/v1/auth/oauth/authorize", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    const { clientId, redirectUri, codeChallenge, codeChallengeMethod = "S256", scope = "projects:all", allowedProjects = [], state } =
      req.body ?? {};

    if (!clientId || !redirectUri || !codeChallenge) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "clientId, redirectUri e codeChallenge são obrigatórios.", 400);
    }
    if (codeChallengeMethod !== "S256") {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Apenas code_challenge_method=S256 é suportado.", 400);
    }

    const client = deps.mcpAuthRepo
      ? await deps.mcpAuthRepo.findOAuthClient(clientId)
      : memoryClients.get(clientId);
    if (client && client.redirectUris.length > 0 && !client.redirectUris.includes(redirectUri)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "redirect_uri não corresponde ao cliente registrado.", 403);
    }

    const code = `brc_${randomBytes(24).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const cleanProjects = Array.isArray(allowedProjects) ? allowedProjects.map((p) => p.trim()).filter(Boolean) : [];

    if (deps.mcpAuthRepo) {
      await deps.mcpAuthRepo.createAuthCode({
        code,
        clientId,
        userId: ctx.actorId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
        allowedProjects: cleanProjects,
        expiresAt
      });
    } else {
      memoryAuthCodes.set(code, {
        code,
        clientId,
        userId: ctx.actorId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
        allowedProjects: cleanProjects,
        expiresAt,
        consumedAt: null
      });
    }

    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    if (state) target.searchParams.set("state", state);
    return { code, redirectTo: target.toString() };
  });

  // OAuth 2.1 Token Endpoint (authorization_code + refresh_token rotation)
  app.post<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      code_verifier?: string;
      refresh_token?: string;
    };
  }>("/oauth/token", async (req) => {
    const body = req.body ?? {};
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      if (!body.code || !body.redirect_uri || !body.code_verifier) {
        throw new BrainError("BRAIN_ERR_CONFLICT", "code, redirect_uri e code_verifier são obrigatórios.", 400);
      }

      const authCode = deps.mcpAuthRepo
        ? await deps.mcpAuthRepo.consumeAuthCode(body.code)
        : (() => {
            const c = memoryAuthCodes.get(body.code!);
            if (!c || c.consumedAt) return null;
            c.consumedAt = new Date();
            return c;
          })();

      if (!authCode || authCode.expiresAt.getTime() <= Date.now()) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Código de autorização inválido ou expirado.", 401);
      }
      if (authCode.redirectUri !== body.redirect_uri || (body.client_id && authCode.clientId !== body.client_id)) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "redirect_uri ou client_id inválido.", 401);
      }
      if (!verifyPkceS256(body.code_verifier, authCode.codeChallenge)) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Falha na verificação PKCE code_verifier.", 401);
      }

      const dbUser = deps.authRepo ? await deps.authRepo.findUserById(authCode.userId) : null;
      const client = deps.mcpAuthRepo ? await deps.mcpAuthRepo.findOAuthClient(authCode.clientId) : memoryClients.get(authCode.clientId);
      const clientName = client?.clientName ?? authCode.clientId;
      const tokenId = `mcpt_${randomUUID()}`;
      const refreshToken = `brt_${randomBytes(32).toString("base64url")}`;
      const scopes = authCode.scope.split(/\s+/).filter(Boolean);
      const restrictedProjects = authCode.allowedProjects;
      const allowedProjects = restrictedProjects.length > 0 ? restrictedProjects : dbUser?.allowedProjects ?? [];

      const accessToken = await issueUserJwt(
        {
          sub: authCode.userId,
          email: dbUser?.email ?? `${authCode.userId}@brain.local`,
          name: `${dbUser?.name ?? authCode.userId} (${clientName})`,
          tenant_id: dbUser?.tenantId ?? "default-org",
          roles: dbUser?.roles ?? ["developer"],
          allowed_projects: allowedProjects,
          allowed_policies: dbUser?.allowedPolicies ?? ["public-org", "internal-project"],
          permissions: (dbUser?.customPermissions as never) ?? undefined,
          actor_type: "agent"
        },
        undefined,
        "1h"
      );

      if (deps.mcpAuthRepo) {
        await deps.mcpAuthRepo.createMcpToken({
          id: tokenId,
          tenantId: dbUser?.tenantId ?? "default-org",
          userId: authCode.userId,
          clientId: authCode.clientId,
          clientName,
          label: `${clientName} (OAuth 2.1)`,
          tokenHash: sha256Hex(accessToken),
          refreshTokenHash: sha256Hex(refreshToken),
          scopes,
          allowedProjects: restrictedProjects,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        });
      }

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
        scope: authCode.scope
      };
    }

    if (grantType === "refresh_token") {
      if (!body.refresh_token || !deps.mcpAuthRepo) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "refresh_token inválido.", 401);
      }
      const existing = await deps.mcpAuthRepo.findActiveTokenByRefreshHash(sha256Hex(body.refresh_token));
      if (!existing) {
        throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "refresh_token revogado ou expirado.", 401);
      }
      const dbUser = deps.authRepo ? await deps.authRepo.findUserById(existing.userId) : null;
      const nextRefresh = `brt_${randomBytes(32).toString("base64url")}`;
      const nextAccess = await issueUserJwt(
        {
          sub: existing.userId,
          email: dbUser?.email ?? `${existing.userId}@brain.local`,
          name: `${dbUser?.name ?? existing.userId} (${existing.clientName})`,
          tenant_id: existing.tenantId,
          roles: dbUser?.roles ?? ["developer"],
          allowed_projects: existing.allowedProjects.length > 0 ? existing.allowedProjects : dbUser?.allowedProjects ?? [],
          allowed_policies: dbUser?.allowedPolicies ?? ["public-org", "internal-project"],
          permissions: (dbUser?.customPermissions as never) ?? undefined,
          actor_type: "agent"
        },
        undefined,
        "1h"
      );

      await deps.mcpAuthRepo.rotateMcpToken(
        existing.id,
        sha256Hex(nextAccess),
        sha256Hex(nextRefresh),
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      );

      return {
        access_token: nextAccess,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: nextRefresh,
        scope: existing.scopes.join(" ")
      };
    }

    throw new BrainError("BRAIN_ERR_CONFLICT", `grant_type não suportado: ${String(grantType)}`, 400);
  });

  // Listar e revogar tokens MCP persistidos no PostgreSQL
  app.get("/v1/auth/mcp-tokens", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    if (!deps.mcpAuthRepo) return { items: [] };
    const isAdmin = ctx.roles.some((r) => ["admin", "owner"].includes(r.toLowerCase()));
    const items = await deps.mcpAuthRepo.listMcpTokens(ctx.tenantId, isAdmin ? undefined : ctx.actorId);
    return { items };
  });

  app.delete<{ Params: { tokenId: string } }>("/v1/auth/mcp-tokens/:tokenId", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    if (!deps.mcpAuthRepo) return { revoked: false };
    const revoked = await deps.mcpAuthRepo.revokeMcpToken(req.params.tokenId, ctx.tenantId);
    return { revoked, tokenId: req.params.tokenId };
  });

  app.post<{ Params: { userId: string } }>("/v1/auth/mcp-tokens/revoke-user/:userId", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    const isAdmin = ctx.roles.some((r) => ["admin", "owner"].includes(r.toLowerCase()));
    if (!isAdmin && req.params.userId !== ctx.actorId) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Sem permissão para revogar tokens de outro usuário.", 403);
    }
    if (!deps.mcpAuthRepo) return { revokedCount: 0, userId: req.params.userId };
    const revokedCount = await deps.mcpAuthRepo.revokeTokensByUser(ctx.tenantId, req.params.userId);
    return { revokedCount, userId: req.params.userId };
  });

  app.post("/v1/auth/mcp-tokens/revoke-current", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    const raw = req.headers.authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!raw || !deps.mcpAuthRepo) return { revoked: false };
    const record = await deps.mcpAuthRepo.findActiveTokenByHash(sha256Hex(raw));
    if (!record) return { revoked: false };
    const revoked = await deps.mcpAuthRepo.revokeMcpToken(record.id, ctx.tenantId);
    return { revoked, tokenId: record.id };
  });
}
