import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface StoredProviderConnection {
  provider: string;
  authType: "oauth" | "apikey" | "local-import";
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  apiKey?: string;
  baseUrl?: string;
  email?: string;
  planType?: string;
  accountId?: string;
  expiresAt?: string;
  updatedAt: string;
}

export interface OAuthStartResult {
  provider: string;
  flowType: "pkce" | "device_code";
  authUrl?: string;
  state?: string;
  redirectUri?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  expiresIn?: number;
  interval?: number;
}

interface PkcePendingSession {
  provider: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

const pkceSessions = new Map<string, PkcePendingSession>();
const connections = new Map<string, StoredProviderConnection>();
let loadedFromDisk = false;

function resolveStorePath(): string {
  const cwdBrain = join(process.cwd(), ".brain", "runner-connections.json");
  if (existsSync(join(process.cwd(), ".brain"))) return cwdBrain;
  return join(homedir(), ".brain", "runner-connections.json");
}

function decodeJwtPayload(token?: string): Record<string, unknown> | null {
  if (!token || !token.includes(".")) return null;
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const json = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractCodexAccountInfo(idToken?: string, accessToken?: string): { email?: string; accountId?: string; planType?: string } {
  const idPayload = decodeJwtPayload(idToken);
  const accessPayload = decodeJwtPayload(accessToken);
  const authClaim = (idPayload?.["https://api.openai.com/auth"] || accessPayload?.["https://api.openai.com/auth"]) as
    | Record<string, unknown>
    | undefined;
  return {
    email: (idPayload?.email as string) || (accessPayload?.email as string) || undefined,
    accountId: (authClaim?.chatgpt_account_id as string) || undefined,
    planType: (authClaim?.chatgpt_plan_type as string) || undefined
  };
}

function persistConnections(): void {
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
  // Auto-import local CLI credentials (e.g. ~/.codex/auth.json) if not already stored
  if (!connections.has("codex")) {
    importLocalProviderAuth("codex");
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

  if (!providerId || providerId === "gemini-cli") {
    const geminiPath = join(home, ".gemini", "oauth_creds.json");
    if (existsSync(geminiPath)) {
      try {
        const raw = JSON.parse(readFileSync(geminiPath, "utf8")) as {
          access_token?: string;
          refresh_token?: string;
          expiry_date?: number;
        };
        if (raw.access_token) {
          const entry: StoredProviderConnection = {
            provider: "gemini-cli",
            authType: "local-import",
            accessToken: raw.access_token,
            refreshToken: raw.refresh_token,
            expiresAt: raw.expiry_date ? new Date(raw.expiry_date).toISOString() : undefined,
            updatedAt: new Date().toISOString()
          };
          connections.set("gemini-cli", entry);
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

const OAUTH_CLIENTS = {
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    scope: "openid profile email offline_access",
    defaultRedirectUri: "http://localhost:1455/auth/callback"
  },
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    scope: "org:create_api_key user:profile user:inference",
    defaultRedirectUri: "https://console.anthropic.com/oauth/code/callback"
  },
  github: {
    clientId: "Iv1.b507a08c87ecfe98",
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    copilotTokenUrl: "https://api.github.com/copilot_internal/v2/token",
    scope: "read:user"
  }
} as const;

export function supportsProviderOAuth(providerId: string): boolean {
  return providerId === "codex" || providerId === "claude" || providerId === "github";
}

export async function startProviderOAuth(providerId: string, customRedirectUri?: string): Promise<OAuthStartResult> {
  if (providerId === "github") {
    const cfg = OAUTH_CLIENTS.github;
    const res = await fetch(cfg.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scope })
    });
    if (!res.ok) throw new Error(`GitHub device code failed: ${await res.text()}`);
    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    return {
      provider: "github",
      flowType: "device_code",
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval
    };
  }

  if (providerId !== "codex" && providerId !== "claude") {
    throw new Error(`OAuth flow not configured for '${providerId}'`);
  }

  const cfg = OAUTH_CLIENTS[providerId];
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const redirectUri = customRedirectUri?.trim() || cfg.defaultRedirectUri;

  pkceSessions.set(state, { provider: providerId, codeVerifier, redirectUri, createdAt: Date.now() });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: cfg.scope,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state
  });
  if (providerId === "codex") {
    params.set("id_token_add_organizations", "true");
    params.set("codex_cli_simplified_flow", "true");
    params.set("originator", "codex_cli_rs");
  } else {
    params.set("code", "true");
  }

  return {
    provider: providerId,
    flowType: "pkce",
    authUrl: `${cfg.authorizeUrl}?${params.toString()}`,
    state,
    redirectUri
  };
}

export async function completeProviderOAuth(
  providerId: string,
  codeOrUrl: string,
  state?: string,
  deviceCode?: string
): Promise<{ pending?: boolean; connection?: StoredProviderConnection }> {
  ensureConnectionsLoaded();

  if (providerId === "github") {
    if (!deviceCode) throw new Error("deviceCode is required for GitHub Copilot");
    const cfg = OAUTH_CLIENTS.github;
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code"
      })
    });
    const data = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (data.error === "authorization_pending" || data.error === "slow_down") {
      return { pending: true };
    }
    if (!data.access_token) {
      throw new Error(data.error_description || data.error || "GitHub OAuth failed");
    }
    // Fetch GitHub user login
    let login: string | undefined;
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${data.access_token}`, "User-Agent": "Brain-Runner" }
      });
      if (userRes.ok) {
        const u = (await userRes.json()) as { login?: string; email?: string };
        login = u.email || u.login;
      }
    } catch {
      // Optional
    }
    const entry: StoredProviderConnection = {
      provider: "github",
      authType: "oauth",
      accessToken: data.access_token,
      email: login,
      updatedAt: new Date().toISOString()
    };
    connections.set("github", entry);
    persistConnections();
    return { connection: entry };
  }

  let code = codeOrUrl.trim();
  let resolvedState = state;
  if (code.startsWith("http://") || code.startsWith("https://")) {
    const parsed = new URL(code);
    code = parsed.searchParams.get("code") || code;
    resolvedState = parsed.searchParams.get("state") || resolvedState;
  }

  const session = resolvedState ? pkceSessions.get(resolvedState) : undefined;
  if (!session || session.provider !== providerId) {
    throw new Error("Sessão OAuth não encontrada ou expirada. Inicie o login novamente.");
  }

  if (providerId === "codex") {
    const cfg = OAUTH_CLIENTS.codex;
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        code,
        redirect_uri: session.redirectUri,
        code_verifier: session.codeVerifier
      })
    });
    if (!res.ok) throw new Error(`Codex token exchange failed: ${await res.text()}`);
    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };
    const info = extractCodexAccountInfo(tokens.id_token, tokens.access_token);
    const entry: StoredProviderConnection = {
      provider: "codex",
      authType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      email: info.email,
      accountId: info.accountId,
      planType: info.planType,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
    connections.set("codex", entry);
    pkceSessions.delete(resolvedState!);
    persistConnections();
    return { connection: entry };
  }

  if (providerId === "claude") {
    const cfg = OAUTH_CLIENTS.claude;
    let authCode = code;
    let codeState = resolvedState;
    if (authCode.includes("#")) {
      const [c, s] = authCode.split("#");
      authCode = c || authCode;
      codeState = s || codeState;
    }
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        code: authCode,
        state: codeState,
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        redirect_uri: session.redirectUri,
        code_verifier: session.codeVerifier
      })
    });
    if (!res.ok) throw new Error(`Claude token exchange failed: ${await res.text()}`);
    const tokens = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const entry: StoredProviderConnection = {
      provider: "claude",
      authType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
    connections.set("claude", entry);
    pkceSessions.delete(resolvedState!);
    persistConnections();
    return { connection: entry };
  }

  throw new Error(`Unsupported OAuth provider '${providerId}'`);
}

