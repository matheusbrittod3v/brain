import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { extractCodexAccountInfo } from "./clients.js";
import { connections, ensureConnectionsLoaded, persistConnections, registerLocalImporter } from "./store.js";
import type { StoredProviderConnection } from "./types.js";

/**
 * Imports local CLI auth files (~/.codex/auth.json, ~/.claude/.credentials.json, ~/.gemini/oauth_creds.json).
 */
export function importLocalProviderAuth(providerId?: string): StoredProviderConnection[] {
  ensureConnectionsLoaded();
  const imported: StoredProviderConnection[] = [];
  const home = homedir();

  if (!providerId || providerId === "codex" || providerId === "codex-cli") {
    const codexAuthPath = join(home, ".codex", "auth.json");
    if (existsSync(codexAuthPath)) {
      try {
        const raw = JSON.parse(readFileSync(codexAuthPath, "utf8")) as {
          OPENAI_API_KEY?: string | null;
          tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string };
        };
        const accessToken = raw.tokens?.access_token || undefined;
        const apiKey = raw.OPENAI_API_KEY || undefined;
        if (accessToken || apiKey) {
          const info = extractCodexAccountInfo(raw.tokens?.id_token, accessToken);
          const entry: StoredProviderConnection = {
            provider: "codex",
            authType: "local-import",
            accessToken,
            refreshToken: raw.tokens?.refresh_token,
            idToken: raw.tokens?.id_token,
            apiKey,
            email: info.email,
            accountId: info.accountId || raw.tokens?.account_id,
            planType: info.planType,
            updatedAt: new Date().toISOString()
          };
          connections.set("codex", entry);
          imported.push(entry);
        }
      } catch {
        // Ignore unreadable auth.json
      }
    }
  }

  if (!providerId || providerId === "claude" || providerId === "claude-cli") {
    const claudePath = join(home, ".claude", ".credentials.json");
    if (existsSync(claudePath)) {
      try {
        const raw = JSON.parse(readFileSync(claudePath, "utf8")) as {
          claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number };
        };
        if (raw.claudeAiOauth?.accessToken) {
          const entry: StoredProviderConnection = {
            provider: "claude",
            authType: "local-import",
            accessToken: raw.claudeAiOauth.accessToken,
            refreshToken: raw.claudeAiOauth.refreshToken,
            expiresAt: raw.claudeAiOauth.expiresAt ? new Date(raw.claudeAiOauth.expiresAt).toISOString() : undefined,
            updatedAt: new Date().toISOString()
          };
          connections.set("claude", entry);
          imported.push(entry);
        }
      } catch {
        // Ignore
      }
    }
  }

  if (!providerId || providerId === "gemini-cli" || providerId === "antigravity") {
    const geminiPath = join(home, ".gemini", "oauth_creds.json");
    if (existsSync(geminiPath)) {
      try {
        const raw = JSON.parse(readFileSync(geminiPath, "utf8")) as {
          access_token?: string;
          refresh_token?: string;
          expiry_date?: number;
        };
        if (raw.access_token) {
          const targetId = providerId === "antigravity" ? "antigravity" : "gemini-cli";
          const entry: StoredProviderConnection = {
            provider: targetId,
            authType: "local-import",
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            expiresAt: raw.expiry_date ? new Date(raw.expiry_date).toISOString() : undefined,
            updatedAt: new Date().toISOString()
          };
          connections.set(targetId, entry);
          imported.push(entry);
        }
      } catch {
        // Ignore
      }
    }
  }

  if (!providerId || providerId === "kimi-coding" || providerId === "kimi") {
    for (const candidate of [join(home, ".kimi", "credentials.json"), join(home, ".kimi", "config.json")]) {
      if (!existsSync(candidate)) continue;
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf8")) as {
          access_token?: string;
          refresh_token?: string;
          api_key?: string;
        };
        if (raw.access_token || raw.api_key) {
          const targetId = providerId === "kimi" ? "kimi" : "kimi-coding";
          const entry: StoredProviderConnection = {
            provider: targetId,
            authType: "local-import",
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            apiKey: raw.api_key,
            updatedAt: new Date().toISOString()
          };
          connections.set(targetId, entry);
          imported.push(entry);
          break;
        }
      } catch {
        // Ignore
      }
    }
  }

  if (!providerId || providerId === "qwen") {
    const qwenPath = join(home, ".qwen", "oauth_creds.json");
    if (existsSync(qwenPath)) {
      try {
        const raw = JSON.parse(readFileSync(qwenPath, "utf8")) as {
          access_token?: string;
          refresh_token?: string;
          expiry_date?: number;
        };
        if (raw.access_token) {
          const entry: StoredProviderConnection = {
            provider: "qwen",
            authType: "local-import",
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            expiresAt: raw.expiry_date ? new Date(raw.expiry_date).toISOString() : undefined,
            updatedAt: new Date().toISOString()
          };
          connections.set("qwen", entry);
          imported.push(entry);
        }
      } catch {
        // Ignore
      }
    }
  }

  if (imported.length > 0) persistConnections();
  return imported;
}

registerLocalImporter(importLocalProviderAuth);

