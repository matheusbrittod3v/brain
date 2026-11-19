import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  EmailService,
  issueUserJwt,
  oauth2Manager,
  resolveDefaultPermissionsForRoles,
  revokeActorSessions,
  usersStore,
  verifyPassword,
  type AuthContext
} from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgAuthRepository, PgMcpAuthRepository } from "@brain/database";
import { registerOAuthPkceRoutes, sha256Hex } from "./oauth-pkce.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  deps: {
    authenticateRequest: (headerValue: string | undefined) => Promise<AuthContext>;
    emailService?: EmailService;
    authRepo?: PgAuthRepository;
    mcpAuthRepo?: PgMcpAuthRepository;
  }
) {
  const emailService = deps.emailService ?? new EmailService();
  registerOAuthPkceRoutes(app, deps);

  // 1. Configuração pública de autenticação
  app.get("/v1/auth/config", async () => {
    return {
      registrationEnabled: usersStore.isRegistrationEnabled()
    };
  });

  // 2. Registro de usuário por Email e Senha
  app.post<{
    Body: { email: string; password: string; name?: string };
  }>("/v1/auth/register", async (req, reply) => {
    const { email, password, name } = req.body ?? {};
    if (!email || !password) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "Email e senha são obrigatórios.", 400);
    }

    if (deps.authRepo) {
      const existing = await deps.authRepo.findUserByEmail(email.toLowerCase());
      if (existing) {
        throw new BrainError("BRAIN_ERR_CONFLICT", `Já existe uma conta cadastrada para '${email}'.`, 409);
      }
    }

    const { user, verificationToken } = await usersStore.registerUser({
      email,
      password,
      name: name ?? email.split("@")[0]
    });

    if (deps.authRepo) {
      await deps.authRepo.upsertUser({
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        emailVerified: user.emailVerified,
        roles: user.roles,
        allowedProjects: user.allowedProjects,
        allowedPolicies: user.allowedPolicies,
        customPermissions: user.customPermissions as string[] | undefined
      });
      if (verificationToken) {
        await deps.authRepo.saveVerificationToken(
          verificationToken,
          user.id,
          "email_verification",
          new Date(Date.now() + 24 * 60 * 60 * 1000)
        );
      }
    }

    // Se verificação de email estiver ativada, envia via EmailService
    if (verificationToken) {
      await emailService.sendVerificationEmail({
        to: user.email,
        name: user.name,
        verificationToken
      });
      return reply.code(201).send({
        status: "pending_verification",
        message: "Cadastro realizado com sucesso. Verifique seu email para ativar a conta.",
        email: user.email
      });
    }

    // Auto-login: emite token JWT
    const token = await issueUserJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      tenant_id: user.tenantId,
      roles: user.roles,
      allowed_projects: user.allowedProjects,
      allowed_policies: user.allowedPolicies,
      permissions: user.customPermissions
    });

    return reply.code(201).send({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        allowedProjects: user.allowedProjects,
        allowedPolicies: user.allowedPolicies
      }
    });
  });

  // 3. Login por Email e Senha (com verificação Argon2id)
  app.post<{
    Body: { email: string; password: string };
  }>("/v1/auth/login", async (req) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Email e senha são obrigatórios.", 401);
    }

    let user = null as Awaited<ReturnType<typeof usersStore.authenticateUser>> | null;
    if (deps.authRepo) {
      const dbUser = await deps.authRepo.findUserByEmail(email.toLowerCase());
      if (dbUser) {
        const valid = await verifyPassword(dbUser.passwordHash, password);
        if (!valid) {
          throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Email ou senha inválidos.", 401);
        }
        if (!dbUser.emailVerified && usersStore.isEmailVerificationRequired()) {
          throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Email ainda não verificado.", 403);
        }
        user = {
          id: dbUser.id,
          tenantId: dbUser.tenantId,
          email: dbUser.email,
          name: dbUser.name,
          passwordHash: dbUser.passwordHash,
          emailVerified: dbUser.emailVerified,
          roles: dbUser.roles,
          allowedProjects: dbUser.allowedProjects,
          allowedPolicies: dbUser.allowedPolicies,
          customPermissions: dbUser.customPermissions as never,
          createdAt: dbUser.createdAt.toISOString(),
          updatedAt: dbUser.updatedAt.toISOString()
        };
      }
    }
    if (!user) {
      user = await usersStore.authenticateUser(email, password);
    }

    const token = await issueUserJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      tenant_id: user.tenantId,
      roles: user.roles,
      allowed_projects: user.allowedProjects,
      allowed_policies: user.allowedPolicies,
      permissions: user.customPermissions
    });

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        allowedProjects: user.allowedProjects,
        allowedPolicies: user.allowedPolicies,
        permissions:
          user.customPermissions && user.customPermissions.length > 0
            ? user.customPermissions
            : resolveDefaultPermissionsForRoles(user.roles)
      }
    };
  });

  // 4. Verificação de email
  app.post<{
    Body: { token: string };
  }>("/v1/auth/verify-email", async (req) => {
    const token = req.body?.token?.trim();
    if (!token) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Token de verificação é obrigatório.", 400);
    }

    let user = null as ReturnType<typeof usersStore.verifyToken> | null;
    if (deps.authRepo) {
      const dbUser = await deps.authRepo.consumeVerificationToken(token);
      if (dbUser) {
        user = {
          id: dbUser.id,
          tenantId: dbUser.tenantId,
          email: dbUser.email,
          name: dbUser.name,
          passwordHash: dbUser.passwordHash,
          emailVerified: dbUser.emailVerified,
          roles: dbUser.roles,
          allowedProjects: dbUser.allowedProjects,
          allowedPolicies: dbUser.allowedPolicies,
          customPermissions: dbUser.customPermissions as never,
          createdAt: dbUser.createdAt.toISOString(),
          updatedAt: dbUser.updatedAt.toISOString()
        };
      }
    }
    if (!user) {
      user = usersStore.verifyToken(token);
    }
    const jwt = await issueUserJwt({
      sub: user.id,
      email: user.email,
      name: user.name,
      tenant_id: user.tenantId,
      roles: user.roles,
      allowed_projects: user.allowedProjects,
      allowed_policies: user.allowedPolicies,
      permissions: user.customPermissions
    });

    return {
      message: "Email verificado com sucesso.",
      token: jwt,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles
      }
    };
  });

  // 5. OAuth2 Device Flow: Iniciar autorização para Agentes IA e MCP Servers
  app.post<{
    Body: { clientId?: string; clientName?: string; scope?: string };
  }>("/v1/auth/oauth/device/code", async (req) => {
    const clientId = req.body?.clientId?.trim() || "brain-mcp-client";
    const clientName = req.body?.clientName?.trim() || "MCP Server / Agent";
    const scope = req.body?.scope?.trim() || "projects:all knowledge:read knowledge:write runner:execute";

    const session = oauth2Manager.createDeviceAuthorization({
      clientId,
      clientName,
      scope
    });

    if (deps.authRepo) {
      await deps.authRepo.saveOAuthSession({
        deviceCode: session.deviceCode,
        userCode: session.userCode,
        clientId,
        clientName,
        scope,
        expiresAt: new Date(Date.now() + session.expiresIn * 1000)
      });
    }

    return {
      device_code: session.deviceCode,
      user_code: session.userCode,
      verification_uri: session.verificationUri,
      expires_in: session.expiresIn,
      interval: session.interval
    };
  });

  // 7. OAuth2: Listar sessões pendentes para aprovação 1-clique (sem digitar código)
  app.get("/v1/auth/oauth/pending", async (req) => {
    await deps.authenticateRequest(req.headers.authorization);
    const items = deps.authRepo ? await deps.authRepo.listPendingOAuthSessions() : [];
    return { items };
  });

  // 7b. OAuth2: Consultar detalhes de sessão pendente (Web UI)
  app.get<{
    Params: { userCode: string };
  }>("/v1/auth/oauth/session/:userCode", async (req) => {
    const session =
      (deps.authRepo ? await deps.authRepo.findOAuthSessionByUserCode(req.params.userCode) : undefined) ??
      oauth2Manager.findSessionByUserCode(req.params.userCode);
    if (!session) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", "Sessão OAuth2 expirada ou não encontrada.", 404);
    }
    return {
      userCode: session.userCode,
      clientId: session.clientId,
      clientName: session.clientName,
      scope: session.scope,
      status: session.status,
      expiresAt: session.expiresAt
    };
  });

  // 8. OAuth2: Usuário logado aprova autorização via Web UI
  app.post<{
    Body: { userCode: string };
  }>("/v1/auth/oauth/approve", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    const dbUser = deps.authRepo ? await deps.authRepo.findUserById(ctx.actorId) : undefined;
    const user =
      (dbUser
        ? {
            id: dbUser.id,
            tenantId: dbUser.tenantId,
            email: dbUser.email,
            name: dbUser.name,
            passwordHash: dbUser.passwordHash,
            emailVerified: dbUser.emailVerified,
            roles: dbUser.roles,
            allowedProjects: dbUser.allowedProjects,
            allowedPolicies: dbUser.allowedPolicies,
            customPermissions: dbUser.customPermissions as never,
            createdAt: dbUser.createdAt.toISOString(),
            updatedAt: dbUser.updatedAt.toISOString()
          }
        : undefined) ?? usersStore.getUserById(ctx.actorId);
    if (!user) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Usuário autenticado não encontrado.", 401);
    }

    const session = deps.authRepo
      ? await deps.authRepo.approveOAuthSession(req.body.userCode, user.id)
      : oauth2Manager.approveSession(req.body.userCode, user);
    if (!session) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", "Sessão OAuth2 expirada ou não encontrada.", 404);
    }
    await emailService.sendOAuthAlert({
      to: user.email,
      name: user.name,
      clientName: session.clientName,
      userAgent: req.headers["user-agent"]
    });

    return {
      status: "approved",
      message: `Acesso concedido com sucesso ao cliente '${session.clientName}'.`
    };
  });

  // 9. OAuth2: Rejeitar autorização via Web UI
  app.post<{
    Body: { userCode: string };
  }>("/v1/auth/oauth/reject", async (req) => {
    await deps.authenticateRequest(req.headers.authorization);
    oauth2Manager.rejectSession(req.body.userCode);
    return { status: "rejected" };
  });

  // 10. OAuth2: MCP Server / Agente troca device_code por Access Token
  app.post<{
    Body: { deviceCode: string; clientId: string };
  }>("/v1/auth/oauth/token", async (req) => {
    const { deviceCode, clientId } = req.body ?? {};
    if (!deviceCode || !clientId) {
      throw new BrainError("BRAIN_ERR_CONFLICT", "deviceCode e clientId são obrigatórios.", 400);
    }

    if (deps.authRepo) {
      const exchanged = await deps.authRepo.exchangeOAuthDeviceCode(deviceCode);
      if (exchanged && exchanged.clientId === clientId) {
        if (exchanged.status === "pending") {
          throw new BrainError("BRAIN_ERR_CONFLICT", "authorization_pending: aguardando aprovação no navegador.", 400);
        }
        if (exchanged.status === "rejected" || exchanged.status === "expired") {
          throw new BrainError("BRAIN_ERR_UNAUTHORIZED", `Autorização ${exchanged.status}.`, 401);
        }
        if (exchanged.status === "approved" && exchanged.userId) {
          const dbUser = await deps.authRepo.findUserById(exchanged.userId);
          if (dbUser) {
            const accessToken = await issueUserJwt({
              sub: dbUser.id,
              email: dbUser.email,
              name: dbUser.name,
              tenant_id: dbUser.tenantId,
              roles: dbUser.roles,
              allowed_projects: dbUser.allowedProjects,
              allowed_policies: dbUser.allowedPolicies,
              permissions: dbUser.customPermissions as never
            });
            return {
              access_token: accessToken,
              token_type: "Bearer",
              expires_in: 28800,
              user: {
                id: dbUser.id,
                email: dbUser.email,
                name: dbUser.name,
                roles: dbUser.roles
              }
            };
          }
        }
      }
    }

    const result = await oauth2Manager.exchangeDeviceCode(deviceCode, clientId);
    return {
      access_token: result.accessToken,
      token_type: result.tokenType,
      expires_in: result.expiresIn,
      user: result.user
    };
  });

  // 9. Logout / Revogação de sessões do usuário autenticado
  app.post("/v1/auth/logout", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    revokeActorSessions(ctx.actorId);
    return { revoked: true, actorId: ctx.actorId };
  });

  // 10. Gerar Token MCP / Personal Access Token para clientes externos (Codex, Cursor, Claude)
  app.post<{
    Body: { label?: string; expiresInDays?: number };
  }>("/v1/auth/mcp-token", async (req) => {
    const ctx = await deps.authenticateRequest(req.headers.authorization);
    const days = Math.min(365, Math.max(1, Number(req.body?.expiresInDays ?? 90) || 90));
    const label = (req.body?.label || "codex-mcp").trim();
    const dbUser = deps.authRepo ? await deps.authRepo.findUserById(ctx.actorId) : null;
    const token = await issueUserJwt(
      {
        sub: ctx.actorId,
        email: dbUser?.email ?? `${ctx.actorId}@brain.local`,
        name: `${dbUser?.name ?? ctx.actorId} (${label})`,
        tenant_id: ctx.tenantId,
        roles: dbUser?.roles ?? ctx.roles,
        allowed_projects: dbUser?.allowedProjects ?? ctx.allowedProjects,
        allowed_policies: dbUser?.allowedPolicies ?? ctx.allowedPolicies,
        permissions: (dbUser?.customPermissions as never) ?? ctx.permissions,
        actor_type: "agent"
      },
      undefined,
      `${days}d`
    );

    const apiPort = process.env.PORT || "3333";
    const mcpUrl = process.env.BRAIN_PUBLIC_API_URL
      ? `${process.env.BRAIN_PUBLIC_API_URL.replace(/\/+$/, "")}/mcp`
      : `http://localhost:${apiPort}/mcp`;

    const tokenId = `mcpt_${randomUUID()}`;
    if (deps.mcpAuthRepo) {
      await deps.mcpAuthRepo.createMcpToken({
        id: tokenId,
        tenantId: ctx.tenantId,
        userId: ctx.actorId,
        clientId: label,
        clientName: label,
        label,
        tokenHash: sha256Hex(token),
        scopes: ["projects:all"],
        allowedProjects: dbUser?.allowedProjects ?? ctx.allowedProjects,
        expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      });
    }

    return {
      tokenId,
      token,
      tokenType: "Bearer",
      expiresInDays: days,
      mcpUrl,
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      codexToml: `[mcp_servers.brain]\nurl = "${mcpUrl}"\nbearer_token_env_var = "BRAIN_MCP_TOKEN"\n\n# Ou com header direto:\n# [mcp_servers.brain.http_headers]\n# Authorization = "Bearer ${token}"`
    };
  });
}
