import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { LlmFallbackTarget } from "./types.js";

export interface ProjectRoutingConfig {
  primary: LlmFallbackTarget;
  secondary: LlmFallbackTarget;
  fallbacks: LlmFallbackTarget[];
  updatedAt: string;
}

const routingMap = new Map<string, ProjectRoutingConfig>();
let loadedFromDisk = false;

function resolveRoutingPath(): string {
  const cwdBrain = join(process.cwd(), ".brain", "runner-routing.json");
  if (existsSync(join(process.cwd(), ".brain"))) return cwdBrain;
  return join(homedir(), ".brain", "runner-routing.json");
}

function defaultRouting(): ProjectRoutingConfig {
  return {
    primary: {
      provider: "codex",
      model: "default"
    },
    secondary: {
      provider: "ollama",
      model: process.env.OLLAMA_MODEL || "gemma2:2b"
    },
    fallbacks: [
      { provider: "ollama", model: process.env.OLLAMA_MODEL || "gemma2:2b" },
      { provider: "9router", model: "qwen2.5-coder:7b" }
    ],
    updatedAt: new Date().toISOString()
  };
}

function ensureLoaded(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const file = resolveRoutingPath();
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, ProjectRoutingConfig>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && v.primary) {
          routingMap.set(k, {
            primary: v.primary,
            secondary: v.secondary ?? defaultRouting().secondary,
            fallbacks: v.fallbacks ?? [],
            updatedAt: v.updatedAt || new Date().toISOString()
          });
        }
      }
    }
  } catch {
    // Ignore malformed file
  }
}

export function getProjectRouting(tenantId: string, projectId: string): ProjectRoutingConfig {
  ensureLoaded();
  return routingMap.get(`${tenantId}:${projectId}`) ?? defaultRouting();
}

export function setProjectRouting(
  tenantId: string,
  projectId: string,
  input: { primary: LlmFallbackTarget; secondary?: LlmFallbackTarget; fallbacks?: LlmFallbackTarget[] }
): ProjectRoutingConfig {
  ensureLoaded();
  const current = getProjectRouting(tenantId, projectId);
  const next: ProjectRoutingConfig = {
    primary: input.primary,
    secondary: input.secondary ?? current.secondary,
    fallbacks: input.fallbacks ?? current.fallbacks,
    updatedAt: new Date().toISOString()
  };
  routingMap.set(`${tenantId}:${projectId}`, next);
  try {
    const file = resolveRoutingPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(Object.fromEntries(routingMap.entries()), null, 2), "utf8");
  } catch {
    // Non-fatal
  }
  return next;
}

