import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PkcePendingSession, StoredProviderConnection } from "./types.js";

export const pkceSessions = new Map<string, PkcePendingSession>();
export const completedOAuthStates = new Map<string, { ok: boolean; connection?: StoredProviderConnection; error?: string }>();
export const connections = new Map<string, StoredProviderConnection>();
let loadedFromDisk = false;
let localImporter: ((providerId?: string) => StoredProviderConnection[]) | null = null;

export function registerLocalImporter(fn: (providerId?: string) => StoredProviderConnection[]): void {
  localImporter = fn;
}

export function getOAuthStateStatus(state: string): { completed: boolean; ok?: boolean; connection?: StoredProviderConnection; error?: string } {
  const done = completedOAuthStates.get(state);
  if (!done) return { completed: false };
  return { completed: true, ...done };
}

function resolveStorePath(): string {
  const cwdBrain = join(process.cwd(), ".brain", "runner-connections.json");
  if (existsSync(join(process.cwd(), ".brain"))) return cwdBrain;
  return join(homedir(), ".brain", "runner-connections.json");
}

export function persistConnections(): void {
  try {
    const file = resolveStorePath();
    mkdirSync(dirname(file), { recursive: true });
    const data = Object.fromEntries(connections.entries());
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // Non-fatal in read-only sandboxes
  }
}

export function ensureConnectionsLoaded(): void {
  if (loadedFromDisk) return;
  loadedFromDisk = true;
  try {
    const file = resolveStorePath();
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, StoredProviderConnection>;
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof v === "object") connections.set(k, v);
      }
    }
  } catch {
    // Ignore malformed file
  }
  if (localImporter) {
    for (const autoProvider of ["codex", "claude", "gemini-cli", "antigravity", "kimi-coding", "qwen"] as const) {
      if (!connections.has(autoProvider)) {
        localImporter(autoProvider);
      }
    }
  }
}

export function getStoredConnection(providerId: string): StoredProviderConnection | undefined {
  ensureConnectionsLoaded();
  return connections.get(providerId);
}

export function getStoredToken(providerId: string): string | undefined {
  const conn = getStoredConnection(providerId);
  return conn?.accessToken || conn?.apiKey;
}

export function saveApiKeyConnection(providerId: string, apiKey: string, baseUrl?: string): StoredProviderConnection {
  ensureConnectionsLoaded();
  const entry: StoredProviderConnection = {
    provider: providerId,
    authType: "apikey",
    apiKey: apiKey.trim(),
    baseUrl: baseUrl?.trim() || undefined,
    updatedAt: new Date().toISOString()
  };
  connections.set(providerId, entry);
  persistConnections();
  return entry;
}

export function disconnectProviderConnection(providerId: string): boolean {
  ensureConnectionsLoaded();
  const deleted = connections.delete(providerId);
  if (deleted) persistConnections();
  return deleted;
}

