import { recordModelUsage } from "../usage-tracker.js";
import { executeSingleTarget } from "./transports.js";
import type { LlmFallbackTarget, UnifiedLlmRequest, UnifiedLlmResponse } from "./types.js";

/**
 * Unified model execution with 2 paths (HTTP/SDK + CLI), 9Router-style fallback chain, and usage tracking.
 */
export async function generateWithVercelAiSdk(req: UnifiedLlmRequest): Promise<UnifiedLlmResponse> {
  const targets: LlmFallbackTarget[] = [
    {
      provider: req.provider,
      model: req.model,
      baseUrl: req.baseUrl,
      apiKey: req.apiKey,
      headers: req.headers,
      cliCommand: req.cliCommand
    },
    ...(req.fallbacks ?? [])
  ];

  const errors: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i]!;
    const started = Date.now();
    try {
      const response = await executeSingleTarget(target, req);
      recordModelUsage({
        provider: response.provider || target.provider,
        model: response.model || target.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cachedTokens: 0,
        totalTokens: response.usage.totalTokens,
        latencyMs: Date.now() - started,
        status: "ok"
      });
      return { ...response, attempts: i + 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordModelUsage({
        provider: target.provider,
        model: target.model,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        latencyMs: Date.now() - started,
        status: "error",
        error: message
      });
      errors.push(`${target.provider}/${target.model}: ${message}`);
    }
  }

  throw new Error(`All LLM targets failed (${errors.join(" | ")})`);
}

