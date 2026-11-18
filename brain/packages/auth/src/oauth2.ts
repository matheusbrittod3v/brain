import { randomBytes, randomUUID } from "node:crypto";
import { BrainError } from "@brain/core";
import { issueUserJwt } from "./jwt.js";
import type { AuthUser } from "./users-store.js";

export interface OAuthDeviceSession {
  deviceCode: string;
  userCode: string; // e.g. "ABCD-1234"
  clientId: string;
  clientName: string;
  scope: string;
  userId?: string;
  user?: AuthUser;
  status: "pending" | "approved" | "rejected" | "expired";
  expiresAt: number; // timestamp ms
  createdAt: number;
}

export class OAuth2Manager {
  private sessions = new Map<string, OAuthDeviceSession>();
  private userCodeIndex = new Map<string, string>(); // userCode -> deviceCode

  /**
   * Initializes a Device Authorization session for an AI Agent, CLI, or MCP Server.
   */
  createDeviceAuthorization(params: {
    clientId: string;
    clientName?: string;
    scope?: string;
    expiresInSeconds?: number;
  }): {
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  } {
    const { clientId, clientName = "MCP Server / Agent", scope = "projects:all", expiresInSeconds = 600 } = params;
    const deviceCode = randomUUID();
    const rawCode = randomBytes(4).toString("hex").toUpperCase();
    const userCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;
    const now = Date.now();
    const expiresAt = now + expiresInSeconds * 1000;

    const session: OAuthDeviceSession = {
      deviceCode,
      userCode,
      clientId,
      clientName,
      scope,
      status: "pending",
      expiresAt,
      createdAt: now
    };

    this.sessions.set(deviceCode, session);
    this.userCodeIndex.set(userCode, deviceCode);

    return {
      deviceCode,
      userCode,
      verificationUri: "/auth/oauth",
      expiresIn: expiresInSeconds,
      interval: 2
    };
  }

  /**
   * Finds a session by userCode (used by web interface when user enters the code).
   */
  findSessionByUserCode(userCode: string): OAuthDeviceSession | null {
    const normalized = userCode.trim().toUpperCase();
    const deviceCode = this.userCodeIndex.get(normalized);
    if (!deviceCode) return null;
    const session = this.sessions.get(deviceCode);
    if (!session || Date.now() > session.expiresAt) {
      if (session) session.status = "expired";
      return null;
    }
    return session;
  }

  /**
   * Called by the Web UI when the logged-in user approves the MCP/Agent connection.
   */
  approveSession(userCode: string, user: AuthUser): OAuthDeviceSession {
    const session = this.findSessionByUserCode(userCode);
    if (!session) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", "Código de autorização OAuth expirado ou inválido.", 404);
    }
    if (session.status !== "pending") {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Sessão já processada (${session.status}).`, 400);
    }

    session.status = "approved";
    session.userId = user.id;
    session.user = user;
    return session;
  }

  /**
   * Called by the Web UI if user denies permission.
   */
  rejectSession(userCode: string): void {
    const session = this.findSessionByUserCode(userCode);
    if (session) {
      session.status = "rejected";
    }
  }

  /**
   * Polled or exchanged by the MCP Server / Agent client.
   */
  async exchangeDeviceCode(deviceCode: string, clientId: string): Promise<{
    accessToken: string;
    tokenType: "Bearer";
    expiresIn: number;
    user: {
      id: string;
      email: string;
      name: string;
      roles: string[];
      allowedProjects: string[];
      allowedPolicies: string[];
    };
  }> {
    const session = this.sessions.get(deviceCode);
    if (!session) {
      throw new BrainError("BRAIN_ERR_NOT_FOUND", "Sessão OAuth não encontrada.", 404);
    }
    if (Date.now() > session.expiresAt) {
      session.status = "expired";
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Código expirado. Inicie nova autorização.", 401);
    }
    if (session.clientId !== clientId) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Client ID divergente.", 403);
    }
    if (session.status === "rejected") {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Acesso rejeitado pelo usuário.", 403);
    }
    if (session.status === "pending" || !session.user) {
      throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "authorization_pending", 400);
    }

    // Issue JWT for the MCP Server bound to the approving user
    const token = await issueUserJwt({
      sub: session.user.id,
      email: session.user.email,
      name: session.user.name,
      tenant_id: session.user.tenantId,
      roles: session.user.roles,
      allowed_projects: session.user.allowedProjects,
      allowed_policies: session.user.allowedPolicies,
      permissions: session.user.customPermissions,
      actor_type: "agent",
      linked_agent_ids: [session.clientId]
    });

    // Remove from active pending
    this.sessions.delete(deviceCode);
    this.userCodeIndex.delete(session.userCode);

    return {
      accessToken: token,
      tokenType: "Bearer",
      expiresIn: 86400,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        roles: session.user.roles,
        allowedProjects: session.user.allowedProjects,
        allowedPolicies: session.user.allowedPolicies
      }
    };
  }
}

export const oauth2Manager = new OAuth2Manager();

