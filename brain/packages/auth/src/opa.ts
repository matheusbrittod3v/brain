import { subject } from "@casl/ability";
import { BrainError } from "@brain/core";
import { buildAbilityForContext } from "./casl.js";
import type { AuthContext } from "./index.js";

export type OpaAction = "read" | "write" | "create" | "update" | "approve";

export interface OpaResourceInput {
  projectId: string;
  accessPolicyId: string;
  action: OpaAction;
  domainId?: number;
  tenantId?: string;
}

export interface OpaEvaluateOptions {
  opaUrl?: string;
  policyPath?: string;
  timeoutMs?: number;
  failOpen?: boolean;
  fetchImpl?: typeof fetch;
}

export interface OpaDecision {
  allowed: boolean;
  engine: "opa" | "casl";
  reason?: string;
}

/**
 * Avalia autorização combinando CASL local (defense-in-depth) com o serviço HTTP do Open Policy Agent (OPA).
 * Quando `OPA_URL` está configurado, envia o payload `input.subject` e `input.resource` para `/v1/data/brain/authz/allow`.
 */
export async function evaluateOpaPolicy(
  ctx: AuthContext,
  resource: OpaResourceInput,
  options: OpaEvaluateOptions = {}
): Promise<OpaDecision> {
  const checkCasl = (): OpaDecision => {
    const ability = buildAbilityForContext(ctx);
    const caslAllowed = ability.can(resource.action, subject("Knowledge", resource));
    return caslAllowed
      ? { allowed: true, engine: "casl" }
      : {
          allowed: false,
          engine: "casl",
          reason: `CASL negou ação '${resource.action}' em '${resource.projectId}'.`
        };
  };

  const opaUrl = (options.opaUrl ?? process.env.OPA_URL ?? "").trim().replace(/\/+$/, "");
  if (!opaUrl) {
    return checkCasl();
  }

  const policyPath = options.policyPath ?? "/v1/data/brain/authz/allow";
  const timeoutMs = options.timeoutMs ?? Math.max(250, Number(process.env.OPA_TIMEOUT_MS ?? 1_500));
  const failOpen = options.failOpen ?? process.env.OPA_FAIL_OPEN === "1";
  const fetchFn = options.fetchImpl ?? fetch;

  const payload = {
    input: {
      subject: {
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        actorType: ctx.actorType,
        roles: ctx.roles,
        allowedProjects: ctx.allowedProjects,
        allowedPolicies: ctx.allowedPolicies
      },
      resource: {
        tenantId: resource.tenantId ?? ctx.tenantId,
        projectId: resource.projectId,
        accessPolicyId: resource.accessPolicyId,
        action: resource.action,
        domainId: resource.domainId ?? null
      }
    }
  };

  try {
    const res = await fetchFn(`${opaUrl}${policyPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!res.ok) {
      if (failOpen) {
        const casl = checkCasl();
        return { ...casl, reason: casl.allowed ? `OPA HTTP ${res.status}; fallback CASL aplicado.` : casl.reason };
      }
      throw new BrainError(
        "BRAIN_ERR_STORAGE_UNAVAILABLE",
        `OPA retornou HTTP ${res.status} ao avaliar política.`,
        503
      );
    }

    const body = (await res.json()) as { result?: unknown };
    if (body.result !== true) {
      return {
        allowed: false,
        engine: "opa",
        reason: `OPA negou ação '${resource.action}' em '${resource.projectId}'.`
      };
    }

    // Defense-in-depth: valida também regras granulares locais do CASL após aprovação do OPA
    const casl = checkCasl();
    if (!casl.allowed) return casl;

    return { allowed: true, engine: "opa" };
  } catch (error) {
    if (error instanceof BrainError) throw error;
    if (failOpen) {
      const casl = checkCasl();
      return { ...casl, reason: casl.allowed ? "OPA indisponível; fallback CASL aplicado." : casl.reason };
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new BrainError(
      "BRAIN_ERR_STORAGE_UNAVAILABLE",
      `Falha ao consultar Open Policy Agent (${opaUrl}): ${detail}`,
      503
    );
  }
}

/**
 * Executa `evaluateOpaPolicy` e lança `BrainError` (403) caso a decisão seja negativa.
 */
export async function enforceOpaPolicy(
  ctx: AuthContext,
  resource: OpaResourceInput,
  options: OpaEvaluateOptions = {}
): Promise<OpaDecision> {
  const decision = await evaluateOpaPolicy(ctx, resource, options);
  if (!decision.allowed) {
    throw new BrainError(
      "BRAIN_ERR_POLICY_DENIED",
      decision.reason ?? `Política negou ação '${resource.action}' em '${resource.projectId}'.`,
      403
    );
  }
  return decision;
}
