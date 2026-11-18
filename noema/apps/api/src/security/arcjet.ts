import arcjet, { detectBot, shield, tokenBucket, validateEmail } from "@arcjet/node";
import { BrainError } from "@noema/core";
import type { FastifyInstance, FastifyRequest } from "fastify";

const localRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkLocalFallbackRateLimit(ip: string, max = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = localRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    localRateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

/**
 * Registers Arcjet Edge Security (Shield WAF, Bot Detection, Rate Limiting, Disposable Email check)
 * with an automatic local rate-limit fallback when ARCJET_KEY is not set.
 */
export function registerArcjetGuard(app: FastifyInstance) {
  const arcjetKey = process.env.ARCJET_KEY?.trim();

  if (!arcjetKey) {
    app.addHook("preHandler", async (req: FastifyRequest) => {
      if (req.url.startsWith("/v1/auth/login") || req.url.startsWith("/v1/auth/register")) {
        const ip = req.ip || "local";
        if (!checkLocalFallbackRateLimit(ip, 30, 60_000)) {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Muitas tentativas. Aguarde antes de tentar novamente.", 429);
        }
      }
    });
    return;
  }

  const ajGeneral = arcjet({
    key: arcjetKey,
    rules: [
      shield({ mode: "LIVE" }),
      detectBot({ mode: "LIVE", allow: ["CATEGORY:SEARCH_ENGINE", "CATEGORY:MONITOR"] }),
      tokenBucket({ mode: "LIVE", refillRate: 20, interval: 10, capacity: 100 })
    ]
  });

  const ajAuthRegister = arcjet({
    key: arcjetKey,
    rules: [
      shield({ mode: "LIVE" }),
      validateEmail({ mode: "LIVE", deny: ["DISPOSABLE", "INVALID", "NO_MX_RECORDS"] })
    ]
  });

  app.addHook("preHandler", async (req: FastifyRequest) => {
    if (req.url.startsWith("/v1/auth/register") && req.method === "POST") {
      const body = req.body as { email?: string } | undefined;
      if (body?.email) {
        const decision = await ajAuthRegister.protect(req.raw, { email: body.email });
        if (decision.isDenied()) {
          throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Registro bloqueado pela política de segurança Arcjet (email descartável ou inválido).", 403);
        }
      }
      return;
    }

    const decision = await ajGeneral.protect(req.raw, { requested: 1 });
    if (decision.isDenied()) {
      const status = decision.reason.isRateLimit() ? 429 : 403;
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Requisição bloqueada pela proteção de borda Arcjet.", status);
    }
  });
}

