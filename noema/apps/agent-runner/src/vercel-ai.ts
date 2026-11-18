import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

export interface UnifiedLlmRequest {
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  system?: string;
  prompt: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface UnifiedLlmResponse {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * Unified model execution powered by Vercel AI SDK Core (`ai`).
 * Supports OpenAI, Anthropic, and local Ollama via OpenAI-compatible API.
 */
export async function generateWithVercelAiSdk(req: UnifiedLlmRequest): Promise<UnifiedLlmResponse> {
  const modelInstance = (() => {
    if (req.provider === "anthropic") {
      return anthropic(req.model);
    }
    if (req.provider === "ollama") {
      const ollamaCompat = createOpenAI({
        baseURL: `${(req.baseUrl || process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "")}/v1`,
        apiKey: "ollama"
      });
      return ollamaCompat(req.model);
    }
    const openaiClient = createOpenAI({ apiKey: req.apiKey || process.env.OPENAI_API_KEY });
    return openaiClient(req.model);
  })();

  const result = await generateText({
    model: modelInstance,
    system: req.system,
    prompt: req.prompt
  });

  const inputTokens = result.usage?.inputTokens ?? 0;
  const outputTokens = result.usage?.outputTokens ?? 0;
  return {
    text: result.text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    }
  };
}

