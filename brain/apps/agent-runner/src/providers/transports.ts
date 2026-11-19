import { spawn } from "node:child_process";
import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { getStoredConnection, getStoredToken } from "../oauth-connections.js";
import { normalizeOpenAiBaseUrl } from "./live-discovery.js";
import { PROVIDER_REGISTRY } from "./registry.js";
import type { LlmFallbackTarget, LlmTransportMode, UnifiedLlmRequest, UnifiedLlmResponse } from "./types.js";

/**
 * Direct CLI subprocess path (`claude -p`, `codex exec`, `gemini -p`, or custom command).
 */
export async function runCliProvider(
  command: string[],
  prompt: string,
  system?: string,
  timeoutMs = 120_000
): Promise<UnifiedLlmResponse> {
  const [bin, ...args] = command;
  if (!bin) {
    throw new Error("CLI provider command cannot be empty");
  }
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;

  return new Promise<UnifiedLlmResponse>((resolve, reject) => {
    const extraPath = process.env.HOME ? `${process.env.HOME}/.local/bin:/opt/homebrew/bin` : "/opt/homebrew/bin";
    const child = spawn(bin, [...args, fullPrompt], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${extraPath}:${process.env.PATH || ""}` }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI provider '${bin}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI provider '${bin}' exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      resolve({
        text: stdout.trim(),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
      });
    });
  });
}

export async function executeSingleTarget(
  target: LlmFallbackTarget,
  req: Pick<UnifiedLlmRequest, "system" | "prompt" | "timeoutMs">
): Promise<UnifiedLlmResponse> {
  const spec = PROVIDER_REGISTRY[target.provider];
  const mode: LlmTransportMode = target.cliCommand ? "cli" : spec?.mode || "http";

  if (mode === "cli") {
    const baseCmd = target.cliCommand || spec?.cliCommand || [target.provider];
    const hasModel = Boolean(target.model && target.model !== "default" && !baseCmd.includes("--model"));
    let cmd = baseCmd;
    if (hasModel) {
      if (target.provider === "codex-cli") {
        cmd = [...baseCmd, "--model", target.model];
      } else if (["antigravity-cli", "claude-cli", "gemini-cli"].includes(target.provider) && baseCmd.length >= 1) {
        const [bin, ...rest] = baseCmd;
        cmd = [bin!, "--model", target.model, ...rest];
      }
    }
    const res = await runCliProvider(cmd, req.prompt, req.system, req.timeoutMs);
    return { ...res, provider: target.provider, model: target.model };
  }

  if (target.provider === "codex") {
    const cmd =
      target.model && target.model !== "default"
        ? ["codex", "exec", "--skip-git-repo-check", "--model", target.model]
        : ["codex", "exec", "--skip-git-repo-check"];
    const res = await runCliProvider(cmd, req.prompt, req.system, req.timeoutMs);
    return { ...res, provider: "codex", model: target.model };
  }

  const modelInstance = (() => {
    const storedConn = getStoredConnection(target.provider);
    if (spec?.format === "anthropic" || target.provider === "anthropic" || target.provider === "claude") {
      return anthropic(target.model);
    }

    const rawBaseUrl =
      target.baseUrl ||
      storedConn?.baseUrl ||
      (target.provider === "ollama" ? process.env.OLLAMA_BASE_URL : undefined) ||
      (target.provider === "9router" ? process.env.NINEROUTER_BASE_URL : undefined) ||
      spec?.baseUrl;

    const apiKey =
      target.apiKey ||
      getStoredToken(target.provider) ||
      (spec?.envKey ? process.env[spec.envKey] : undefined) ||
      spec?.defaultApiKey ||
      process.env.OPENAI_API_KEY;

    const client = createOpenAI({
      baseURL: rawBaseUrl ? normalizeOpenAiBaseUrl(rawBaseUrl, target.provider) : undefined,
      apiKey,
      headers: { ...spec?.headers, ...target.headers }
    });
    return client.chat(target.model);
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
    provider: target.provider,
    model: target.model,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens
    }
  };
}

