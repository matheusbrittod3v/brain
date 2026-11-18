import { eq } from "drizzle-orm";
import type { BrainDb } from "./client.js";
import { authOAuthSessions, authUsers, authVerificationTokens } from "./schema.js";

export class PgAuthRepository {
  constructor(private readonly db: BrainDb) {}

  async findUserByEmail(email: string) {
    const rows = await this.db.select().from(authUsers).where(eq(authUsers.email, email.trim().toLowerCase())).limit(1);
    return rows[0] ?? null;
  }

  async findUserById(id: string) {
    const rows = await this.db.select().from(authUsers).where(eq(authUsers.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async listUsers(tenantId = "default-org") {
    return this.db
      .select({
        id: authUsers.id,
        tenantId: authUsers.tenantId,
        email: authUsers.email,
        name: authUsers.name,
        emailVerified: authUsers.emailVerified,
        roles: authUsers.roles,
        allowedProjects: authUsers.allowedProjects,
        allowedPolicies: authUsers.allowedPolicies,
        linkedAgentIds: authUsers.linkedAgentIds,
        createdAt: authUsers.createdAt
      })
      .from(authUsers)
      .where(eq(authUsers.tenantId, tenantId));
  }

  async upsertUser(user: {
    id: string;
    tenantId: string;
    email: string;
    name: string;
    passwordHash: string;
    emailVerified: boolean;
    roles: string[];
    allowedProjects: string[];
    allowedPolicies: string[];
    customPermissions?: string[];
    linkedAgentIds?: string[];
  }) {
    const [row] = await this.db
      .insert(authUsers)
      .values({
        id: user.id,
        tenantId: user.tenantId,
        email: user.email.trim().toLowerCase(),
        name: user.name,
        passwordHash: user.passwordHash,
        emailVerified: user.emailVerified,
        roles: user.roles,
        allowedProjects: user.allowedProjects,
        allowedPolicies: user.allowedPolicies,
        customPermissions: user.customPermissions ?? [],
        linkedAgentIds: user.linkedAgentIds ?? []
      })
      .onConflictDoUpdate({
        target: authUsers.id,
        set: {
          name: user.name,
          passwordHash: user.passwordHash,
          emailVerified: user.emailVerified,
          roles: user.roles,
          allowedProjects: user.allowedProjects,
          allowedPolicies: user.allowedPolicies,
          customPermissions: user.customPermissions ?? [],
          linkedAgentIds: user.linkedAgentIds ?? [],
          updatedAt: new Date()
        }
      })
      .returning();
    return row;
  }

  async saveVerificationToken(token: string, userId: string, type: string, expiresAt: Date) {
    await this.db.insert(authVerificationTokens).values({ token, userId, type, expiresAt });
  }

  async consumeVerificationToken(token: string) {
    const rows = await this.db.select().from(authVerificationTokens).where(eq(authVerificationTokens.token, token)).limit(1);
    const entry = rows[0];
    if (!entry) return null;
    await this.db.delete(authVerificationTokens).where(eq(authVerificationTokens.token, token));
    if (entry.expiresAt.getTime() < Date.now()) return null;
    await this.db.update(authUsers).set({ emailVerified: true, updatedAt: new Date() }).where(eq(authUsers.id, entry.userId));
    return this.findUserById(entry.userId);
  }

  async saveOAuthSession(session: {
    deviceCode: string;
    userCode: string;
    clientId: string;
    clientName: string;
    scope: string;
    expiresAt: Date;
  }) {
    await this.db.insert(authOAuthSessions).values(session);
  }

  async findOAuthSessionByUserCode(userCode: string) {
    const rows = await this.db.select().from(authOAuthSessions).where(eq(authOAuthSessions.userCode, userCode.toUpperCase())).limit(1);
    return rows[0] ?? null;
  }

  async approveOAuthSession(userCode: string, userId: string) {
    const [row] = await this.db
      .update(authOAuthSessions)
      .set({ status: "approved", userId })
      .where(eq(authOAuthSessions.userCode, userCode.toUpperCase()))
      .returning();
    return row ?? null;
  }

  async exchangeOAuthDeviceCode(deviceCode: string) {
    const rows = await this.db.select().from(authOAuthSessions).where(eq(authOAuthSessions.deviceCode, deviceCode)).limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.status === "approved") {
      await this.db.delete(authOAuthSessions).where(eq(authOAuthSessions.deviceCode, deviceCode));
    }
    return row;
  }
}

