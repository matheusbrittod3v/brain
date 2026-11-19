import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { BrainDb } from "./client.js";
import { authMcpTokens, oauthAuthCodes, oauthRegisteredClients } from "./schema.js";

/**
 * Persists OAuth 2.1 dynamic clients, PKCE authorization codes, and revocable MCP tokens.
 */
export class PgMcpAuthRepository {
  private ensured = false;

  constructor(private readonly db: BrainDb) {}

  async ensureTables(): Promise<void> {
    if (this.ensured) return;
    try {
      const check = await this.db.execute(sql`SELECT to_regclass('public.auth_mcp_tokens') AS tbl`);
      const rows = Array.isArray(check) ? check : (check as { rows?: Array<{ tbl?: string | null }> }).rows ?? [];
      if (rows[0]?.tbl) {
        this.ensured = true;
        return;
      }
      await this.db.execute(sql`
        CREATE TABLE IF NOT EXISTS oauth_registered_clients (
          client_id TEXT PRIMARY KEY,
          client_name TEXT NOT NULL,
          redirect_uris TEXT[] NOT NULL DEFAULT '{}',
          grant_types TEXT[] NOT NULL DEFAULT '{authorization_code,refresh_token}',
          scope TEXT NOT NULL DEFAULT 'projects:all',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await this.db.execute(sql`
        CREATE TABLE IF NOT EXISTS oauth_auth_codes (
          code TEXT PRIMARY KEY,
          client_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          redirect_uri TEXT NOT NULL,
          code_challenge TEXT NOT NULL,
          code_challenge_method TEXT NOT NULL DEFAULT 'S256',
          scope TEXT NOT NULL DEFAULT 'projects:all',
          allowed_projects TEXT[] NOT NULL DEFAULT '{}',
          expires_at TIMESTAMPTZ NOT NULL,
          consumed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await this.db.execute(sql`
        CREATE TABLE IF NOT EXISTS auth_mcp_tokens (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          client_id TEXT NOT NULL DEFAULT 'codex-mcp',
          client_name TEXT NOT NULL DEFAULT 'Codex / MCP Client',
          label TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          refresh_token_hash TEXT UNIQUE,
          scopes TEXT[] NOT NULL DEFAULT '{projects:all}',
          allowed_projects TEXT[] NOT NULL DEFAULT '{}',
          last_used_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch {
      // Tables may already be provisioned by admin migration
    }
    this.ensured = true;
  }

  async registerOAuthClient(input: {
    clientId: string;
    clientName: string;
    redirectUris: string[];
    grantTypes: string[];
    scope: string;
  }) {
    await this.ensureTables();
    const [row] = await this.db
      .insert(oauthRegisteredClients)
      .values(input)
      .onConflictDoUpdate({
        target: oauthRegisteredClients.clientId,
        set: {
          clientName: input.clientName,
          redirectUris: input.redirectUris,
          grantTypes: input.grantTypes,
          scope: input.scope
        }
      })
      .returning();
    return row;
  }

  async findOAuthClient(clientId: string) {
    await this.ensureTables();
    const rows = await this.db
      .select()
      .from(oauthRegisteredClients)
      .where(eq(oauthRegisteredClients.clientId, clientId))
      .limit(1);
    return rows[0] ?? null;
  }

  async createAuthCode(input: {
    code: string;
    clientId: string;
    userId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    scope: string;
    allowedProjects: string[];
    expiresAt: Date;
  }) {
    await this.ensureTables();
    const [row] = await this.db.insert(oauthAuthCodes).values(input).returning();
    return row;
  }

  async consumeAuthCode(code: string) {
    await this.ensureTables();
    const [row] = await this.db
      .update(oauthAuthCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(oauthAuthCodes.code, code), isNull(oauthAuthCodes.consumedAt)))
      .returning();
    return row ?? null;
  }

  async createMcpToken(input: {
    id: string;
    tenantId: string;
    userId: string;
    clientId: string;
    clientName: string;
    label: string;
    tokenHash: string;
    refreshTokenHash?: string | null;
    scopes: string[];
    allowedProjects: string[];
    expiresAt: Date;
  }) {
    await this.ensureTables();
    const [row] = await this.db
      .insert(authMcpTokens)
      .values({
        ...input,
        refreshTokenHash: input.refreshTokenHash ?? null
      })
      .returning();
    return row;
  }

  async findActiveTokenByHash(tokenHash: string) {
    await this.ensureTables();
    const rows = await this.db
      .select()
      .from(authMcpTokens)
      .where(and(eq(authMcpTokens.tokenHash, tokenHash), isNull(authMcpTokens.revokedAt)))
      .limit(1);
    const row = rows[0];
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return row;
  }

  async findActiveTokenByRefreshHash(refreshTokenHash: string) {
    await this.ensureTables();
    const rows = await this.db
      .select()
      .from(authMcpTokens)
      .where(and(eq(authMcpTokens.refreshTokenHash, refreshTokenHash), isNull(authMcpTokens.revokedAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async rotateMcpToken(id: string, nextTokenHash: string, nextRefreshTokenHash: string, nextExpiresAt: Date) {
    await this.ensureTables();
    const [row] = await this.db
      .update(authMcpTokens)
      .set({
        tokenHash: nextTokenHash,
        refreshTokenHash: nextRefreshTokenHash,
        expiresAt: nextExpiresAt,
        lastUsedAt: new Date()
      })
      .where(and(eq(authMcpTokens.id, id), isNull(authMcpTokens.revokedAt)))
      .returning();
    return row ?? null;
  }

  async touchLastUsed(id: string): Promise<void> {
    await this.ensureTables();
    await this.db.update(authMcpTokens).set({ lastUsedAt: new Date() }).where(eq(authMcpTokens.id, id));
  }

  async listMcpTokens(tenantId: string, userId?: string) {
    await this.ensureTables();
    return this.db
      .select({
        id: authMcpTokens.id,
        tenantId: authMcpTokens.tenantId,
        userId: authMcpTokens.userId,
        clientId: authMcpTokens.clientId,
        clientName: authMcpTokens.clientName,
        label: authMcpTokens.label,
        scopes: authMcpTokens.scopes,
        allowedProjects: authMcpTokens.allowedProjects,
        lastUsedAt: authMcpTokens.lastUsedAt,
        expiresAt: authMcpTokens.expiresAt,
        revokedAt: authMcpTokens.revokedAt,
        createdAt: authMcpTokens.createdAt
      })
      .from(authMcpTokens)
      .where(
        userId
          ? and(eq(authMcpTokens.tenantId, tenantId), eq(authMcpTokens.userId, userId))
          : eq(authMcpTokens.tenantId, tenantId)
      )
      .orderBy(desc(authMcpTokens.createdAt));
  }

  async revokeMcpToken(id: string, tenantId: string): Promise<boolean> {
    await this.ensureTables();
    const rows = await this.db
      .update(authMcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(authMcpTokens.id, id), eq(authMcpTokens.tenantId, tenantId), isNull(authMcpTokens.revokedAt)))
      .returning({ id: authMcpTokens.id });
    return rows.length > 0;
  }

  async revokeTokensByUser(tenantId: string, userId: string): Promise<number> {
    await this.ensureTables();
    const rows = await this.db
      .update(authMcpTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(authMcpTokens.tenantId, tenantId), eq(authMcpTokens.userId, userId), isNull(authMcpTokens.revokedAt)))
      .returning({ id: authMcpTokens.id });
    return rows.length;
  }
}
