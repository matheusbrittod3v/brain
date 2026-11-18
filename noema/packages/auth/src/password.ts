import { hash, verify, Version, Algorithm } from "@node-rs/argon2";
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Enterprise-grade password hashing using Argon2id (OWASP & IETF recommended standard).
 * Includes automatic failover to crypto.scrypt if native binary binding is unavailable.
 */
export async function hashPassword(password: string): Promise<string> {
  if (!password || typeof password !== "string" || password.length === 0) {
    throw new Error("Senha não pode ser vazia.");
  }
  try {
    return await hash(password, {
      algorithm: Algorithm.Argon2id,
      version: Version.V0x13,
      memoryCost: 19456, // ~19 MiB
      timeCost: 2,
      parallelism: 1,
      outputLen: 32
    });
  } catch {
    // Fallback using memory-hard scryptSync
    const salt = randomBytes(16).toString("hex");
    const derived = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
    return `scrypt$${salt}$${derived}`;
  }
}

export async function verifyPassword(passwordHash: string, candidate: string): Promise<boolean> {
  if (!passwordHash || !candidate) return false;
  try {
    if (passwordHash.startsWith("$argon2id$") || passwordHash.startsWith("$argon2i$") || passwordHash.startsWith("$argon2d$")) {
      return await verify(passwordHash, candidate);
    }
    if (passwordHash.startsWith("scrypt$")) {
      const parts = passwordHash.split("$");
      if (parts.length !== 3) return false;
      const [, salt, expectedHex] = parts;
      const derived = scryptSync(candidate, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
      const a = Buffer.from(derived, "hex");
      const b = Buffer.from(expectedHex, "hex");
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    }
    return false;
  } catch {
    return false;
  }
}

