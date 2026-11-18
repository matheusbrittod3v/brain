import type { AuthContext } from "@brain/auth";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, stepCountIs } from "ai";
import { compactConversationHistory, type LoopMessage } from "./compactor.js";
import type { AgentToolRegistry } from "../tools/registry.js";

export type AgentLoopEvent =
  | { type: "agent_start"; projectId: string; model: string }
  | { type: "compaction"; droppedCount: number }
  | { type: "tool_start"; toolName: string; input: unknown }
  | { type: "tool_end"; toolName: string; output: string }
  | { type: "agent_end"; text: string; steps: number; totalTokens: number };

export interface AgentLoopRequest {
  auth: AuthContext;
  projectId: string;
  provider: "openai" | "anthropic" | "ollama";
  model: string;
  systemPrompt?: string;
  messages: LoopMessage[];
  registry?: AgentToolRegistry;
  maxSteps?: number;
  maxContextTokens?: number;
  signal?: AbortSignal;
  baseUrl?: string;
  apiKey?: string;
  onEvent?: (event: AgentLoopEvent) => void;
}

export interface AgentLoopResult {
  text: string;
  steps: number;
  compacted: boolean;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

function resolveLanguageModel(req: Pick<AgentLoopRequest, "provider" | "model" | "baseUrl" | "apiKey">) {
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
}

/**
 * Multi-turn agent execution loop combining pi-agent-core lifecycle hooks,
 * automatic context compaction, CASL-guarded Zod tools, and Vercel AI SDK Core.
 */
export async function runAgentLoop(req: AgentLoopRequest): Promise<AgentLoopResult> {
  req.onEvent?.({ type: "agent_start", projectId: req.projectId, model: req.model });

  const compacted = await compactConversationHistory(req.messages, {
    maxTokens: req.maxContextTokens ?? 24_000
  });
  if (compacted.compacted) {
    req.onEvent?.({ type: "compaction", droppedCount: compacted.droppedCount });
  }

  const tools = req.registry?.toVercelAiTools(req.auth, req.projectId, {
    beforeToolCall: async (toolName, input) => {
      req.onEvent?.({ type: "tool_start", toolName, input });
    },
    afterToolCall: async (toolName, output) => {
      req.onEvent?.({ type: "tool_end", toolName, output });
    }
  });

  const modelInstance = resolveLanguageModel(req);
  const coreMessages = compacted.messages.map((m) => ({
    role: m.role === "tool" ? ("assistant" as const) : m.role,
    content: m.content
  }));

  const result = await generateText({
    model: modelInstance,
    system: req.systemPrompt,
    messages: coreMessages,
    ...(tools && Object.keys(tools).length > 0 ? { tools } : {}),
    stopWhen: stepCountIs(req.maxSteps ?? 8),
    abortSignal: req.signal
  });

  const inputTokens = result.totalUsage?.inputTokens ?? 0;
  const outputTokens = result.totalUsage?.outputTokens ?? 0;
  const totalTokens = result.totalUsage?.totalTokens ?? inputTokens + outputTokens;

  req.onEvent?.({
    type: "agent_end",
    text: result.text,
    steps: result.steps.length,
    totalTokens
  });

  return {
    text: result.text,
    steps: result.steps.length,
    compacted: compacted.compacted,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens
    }
  };
}

