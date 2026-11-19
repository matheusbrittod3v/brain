import type { ModelCatalogItem } from "@brain/agent-runner";
import type { AuditLogger } from "@brain/audit-engine";
import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { PgOperationalRepository } from "@brain/database";
import type { BrainRunnerQueue } from "@brain/agent-runner";
import type { ModelUsageSnapshot } from "../../services/finops-quota.js";

export interface RunnerRouteDeps {
  authenticateProjectRequest: (headerValue: string | undefined, projectId: string) => Promise<AuthContext>;
  enforcePolicy: (
    ctx: AuthContext,
    resource: { projectId: string; accessPolicyId: string; action: "read" | "write" | "create" | "update" | "approve"; domainId?: number }
  ) => Promise<void>;
  recordAudit: (ctx: AuthContext, event: Parameters<AuditLogger["record"]>[0]) => Promise<unknown>;
  runner: BrainRunnerQueue;
  opRepo?: PgOperationalRepository;
  projectModelUsage?: (ctx: AuthContext, projectId: string) => Promise<ModelUsageSnapshot>;
}

export interface RunnerSharedState {
  runtimeApiKeys: Map<string, string>;
  liveModelsCache: Map<string, { online: boolean; models: ModelCatalogItem[]; error?: string }>;
  enforceRunnerRateLimit: (actorId: string, projectId: string) => void;
  maxActiveTasks: number;
}

export function createRunnerSharedState(): RunnerSharedState {
  const runnerRateWindow = new Map<string, number[]>();
  const RATE_LIMIT_PER_MIN = Math.max(5, Number(process.env.BRAIN_RUNNER_RATE_LIMIT_PER_MIN || 30));
  const maxActiveTasks = Math.max(1, Number(process.env.BRAIN_RUNNER_MAX_ACTIVE_TASKS || 15));

  const enforceRunnerRateLimit = (actorId: string, projectId: string) => {
    const key = `${actorId}:${projectId}`;
    const now = Date.now();
    const recent = (runnerRateWindow.get(key) ?? []).filter((ts) => now - ts < 60_000);
    if (recent.length >= RATE_LIMIT_PER_MIN) {
      throw new BrainError("BRAIN_ERR_CONFLICT", `Rate limit do Runner atingido (${RATE_LIMIT_PER_MIN} tarefas/min). Aguarde um instante.`, 429);
    }
    recent.push(now);
    runnerRateWindow.set(key, recent);
  };

  return {
    runtimeApiKeys: new Map<string, string>(),
    liveModelsCache: new Map<string, { online: boolean; models: ModelCatalogItem[]; error?: string }>(),
    enforceRunnerRateLimit,
    maxActiveTasks
  };
}

export function assertSafeExternalUrl(rawUrl?: string): void {
  if (!rawUrl?.trim()) return;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new BrainError("BRAIN_ERR_CONFLICT", "URL inválida fornecida para configuração de provedor/MCP.", 400);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", `Protocolo '${parsed.protocol}' não permitido. Use http: ou https:.`, 403);
  }
  const host = parsed.hostname.toLowerCase();
  const metadataHosts = new Set(["169.254.169.254", "metadata.google.internal", "metadata.goog", "fd00:ec2::254"]);
  if (metadataHosts.has(host) || host.startsWith("169.254.")) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "Bloqueado pelo guardrail SSRF (endpoint de metadata cloud).", 403);
  }
}

const SECRET_KEY_RE = /(key|token|secret|password|pass|auth)/i;

export function maskSensitiveRecord(rec?: Record<string, string>): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (SECRET_KEY_RE.test(k) && typeof v === "string" && v.length > 0) {
      out[k] = v.length <= 6 ? "••••••" : `${v.slice(0, 3)}••••${v.slice(-2)}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

