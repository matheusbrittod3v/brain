import type { AuthContext } from "@brain/auth";
import { BrainError } from "@brain/core";
import type { BrainRuntime } from "../runtime.js";

export function ollamaUrl(override?: string): string {
  return (override ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
}

export async function fetchOllamaTags(baseUrl: string): Promise<{
  available: boolean;
  baseUrl: string;
  models: Array<{
    name: string;
    sizeBytes: number;
    family?: string;
    parameterSize?: string;
    quantizationLevel?: string;
    modifiedAt?: string;
  }>;
  error?: string;
}> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) {
      return { available: false, baseUrl, models: [], error: `HTTP ${res.status}` };
    }
    const payload = (await res.json()) as {
      models?: Array<{
        name: string;
        size?: number;
        modified_at?: string;
        details?: { family?: string; parameter_size?: string; quantization_level?: string };
      }>;
    };
    return {
      available: true,
      baseUrl,
      models: (payload.models ?? []).map((m) => ({
        name: m.name,
        sizeBytes: m.size ?? 0,
        family: m.details?.family,
        parameterSize: m.details?.parameter_size,
        quantizationLevel: m.details?.quantization_level,
        modifiedAt: m.modified_at
      }))
    };
  } catch (err) {
    return { available: false, baseUrl, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export async function callOllamaGenerate(baseUrl: string, model: string, prompt: string, timeoutMs = 45_000): Promise<{
  response: string;
  evalCount?: number;
  promptEvalCount?: number;
  totalDurationMs?: number;
}> {
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, stream: false }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", `Ollama retornou HTTP ${res.status}: ${text.slice(0, 200)}`, 503);
  }
  const data = (await res.json()) as {
    response?: string;
    eval_count?: number;
    prompt_eval_count?: number;
    total_duration?: number;
  };
  return {
    response: (data.response ?? "").trim(),
    evalCount: data.eval_count,
    promptEvalCount: data.prompt_eval_count,
    totalDurationMs: typeof data.total_duration === "number" ? Math.round(data.total_duration / 1_000_000) : undefined
  };
}

export async function collectVerifiedByEdges(
  graph: BrainRuntime["graph"],
  ctx: AuthContext,
  projectId: string,
  items: ReadonlyArray<{ id: string; type: string; status: string; accessPolicyId?: string }>
) {
  const edges: Array<{
    tenantId: string;
    fromProjectId: string;
    toProjectId: string;
    fromItemId: string;
    toItemId: string;
    fromPolicyId: string;
    toPolicyId: string;
    relationType: "VERIFIED_BY";
    isInferred: false;
    confidence: number;
  }> = [];
  const seen = new Set<string>();
  for (const rule of items.filter((item) => item.type === "business_rule" && item.status !== "deprecated")) {
    const related = await graph.traverseRelated(ctx, { projectId, itemId: rule.id }, 2);
    for (const hit of related) {
      if (hit.via !== "VERIFIED_BY") continue;
      const key = `${rule.id}->${hit.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const policy = rule.accessPolicyId ?? "internal-project";
      edges.push({
        tenantId: ctx.tenantId,
        fromProjectId: projectId,
        toProjectId: projectId,
        fromItemId: rule.id,
        toItemId: hit.itemId,
        fromPolicyId: policy,
        toPolicyId: policy,
        relationType: "VERIFIED_BY",
        isInferred: false,
        confidence: 1
      });
    }
  }
  return edges;
}

