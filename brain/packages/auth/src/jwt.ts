import { BrainError } from "@brain/core";
import { jwtVerify, SignJWT } from "jose";
import type { ActorType, AuthContext, SystemPermission } from "./index.js";

export interface UserJwtClaims {
  sub: string; // User ID
  email: string;
  name: string;
  tenant_id: string;
  roles: string[];
  allowed_projects: string[];
  allowed_policies: string[];
  permissions?: SystemPermission[];
  linked_agent_ids?: string[];
  actor_type?: ActorType;
}

export function getJwtSecretKey(overrideSecret?: string): Uint8Array {
  const secret = overrideSecret || process.env.BRAIN_JWT_SECRET || process.env.OIDC_HMAC_SECRET;
  if (!secret || secret.trim().length < 32) {
    throw new Error("BRAIN_JWT_SECRET must be configured with at least 32 characters.");
  }
  if (secret === "brain-jwt-super-secret-key-32-chars-min!" || secret === "brain-default-production-grade-jwt-secret-key-32-chars!") {
    throw new Error("BRAIN_JWT_SECRET cannot use a published example value.");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Issues a cryptographically signed JWT for an authenticated user or agent using `jose`.
 */
export async function issueUserJwt(
  claims: UserJwtClaims,
  secretOverride?: string,
  expiresIn = "24h"
): Promise<string> {
  const key = getJwtSecretKey(secretOverride);
  return new SignJWT({
    email: claims.email,
    name: claims.name,
    tenant_id: claims.tenant_id,
    roles: claims.roles,
    allowed_projects: claims.allowed_projects,
    allowed_policies: claims.allowed_policies,
    permissions: claims.permissions ?? [],
    linked_agent_ids: claims.linked_agent_ids ?? [],
    actor_type: claims.actor_type ?? "human"
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer("brain-auth")
    .setAudience("brain-api")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

/**
 * Verifies and parses a user JWT into a full AuthContext.
 */
export async function verifyUserJwt(token: string, secretOverride?: string): Promise<AuthContext> {
  try {
    const key = getJwtSecretKey(secretOverride);
    const { payload } = await jwtVerify(token, key, {
      issuer: "brain-auth",
      audience: "brain-api"
    });

    const sub = String(payload.sub ?? "");
    const tenantId = String(payload.tenant_id ?? "default-org");
    const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : ["developer"];
    const allowedProjects = Array.isArray(payload.allowed_projects) ? (payload.allowed_projects as string[]) : [];
    const allowedPolicies = Array.isArray(payload.allowed_policies)
      ? (payload.allowed_policies as string[])
      : ["public-org", "internal-project"];
    const permissions =
      Array.isArray(payload.permissions) && payload.permissions.length > 0
        ? (payload.permissions as SystemPermission[])
        : undefined;
    const actorType = (payload.actor_type as ActorType) || "human";
    const linkedAgentIds = Array.isArray(payload.linked_agent_ids) ? (payload.linked_agent_ids as string[]) : [];

    return {
      tenantId,
      actorId: sub,
      actorType,
      roles,
      allowedProjects,
      allowedPolicies,
      permissions
    };
  } catch (error) {
    if (error instanceof BrainError) throw error;
    throw new BrainError("BRAIN_ERR_UNAUTHORIZED", "Token JWT inválido ou expirado.", 401);
  }
}

