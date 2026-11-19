import { createHash, randomBytes } from "node:crypto";
import { startLocalCallbackListener } from "./callback-server.js";
import { OAUTH_CLIENTS, decodeJwtPayload, extractCodexAccountInfo } from "./clients.js";
import { connections, ensureConnectionsLoaded, persistConnections, pkceSessions } from "./store.js";
import type { OAuthStartResult, StoredProviderConnection } from "./types.js";

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

  if (providerId === "kimi-coding" || providerId === "qwen") {
    const cfg = OAUTH_CLIENTS[providerId];
    const codeVerifier = providerId === "qwen" ? randomBytes(32).toString("base64url") : undefined;
    const body = new URLSearchParams({ client_id: cfg.clientId, scope: cfg.scope });
    if (codeVerifier) {
      body.set("code_challenge", createHash("sha256").update(codeVerifier).digest("base64url"));
      body.set("code_challenge_method", "S256");
    }
    const res = await fetch(cfg.deviceCodeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });
    if (!res.ok) throw new Error(`${providerId} device code failed: ${await res.text()}`);
    const data = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri?: string;
      verification_uri_complete?: string;
      expires_in: number;
      interval?: number;
    };
    if (codeVerifier) {
      pkceSessions.set(data.device_code, {
        provider: providerId,
        codeVerifier,
        redirectUri: "",
        createdAt: Date.now()
      });
    }
    return {
      provider: providerId,
      flowType: "device_code",
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri_complete || data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval ?? 5
    };
  }

  if (providerId === "antigravity" || providerId === "gemini-cli") {
    const cfg = OAUTH_CLIENTS.antigravity;
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    const redirectUri = customRedirectUri?.trim() || cfg.defaultRedirectUri;

    pkceSessions.set(state, { provider: providerId, codeVerifier, redirectUri, createdAt: Date.now() });
    startLocalCallbackListener(51121, "/oauth-callback", completeProviderOAuth);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state
    });

    return {
      provider: providerId,
      flowType: "pkce",
      authUrl: `${cfg.authorizeUrl}?${params.toString()}`,
      state,
      redirectUri
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
  if (providerId === "codex") {
    startLocalCallbackListener(1455, "/auth/callback", completeProviderOAuth);
  }

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

  if (providerId === "kimi-coding" || providerId === "qwen") {
    if (!deviceCode) throw new Error(`deviceCode is required for ${providerId}`);
    const cfg = OAUTH_CLIENTS[providerId];
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code"
    });
    const pendingPkce = pkceSessions.get(deviceCode);
    if (pendingPkce?.codeVerifier) {
      body.set("code_verifier", pendingPkce.codeVerifier);
    }
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      resource_url?: string;
      error?: string;
      error_description?: string;
    };
    if (data.error === "authorization_pending" || data.error === "slow_down") {
      return { pending: true };
    }
    if (!data.access_token) {
      throw new Error(data.error_description || data.error || `${providerId} OAuth failed`);
    }
    pkceSessions.delete(deviceCode);
    const entry: StoredProviderConnection = {
      provider: providerId,
      authType: "oauth",
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      baseUrl: data.resource_url ? (data.resource_url.startsWith("http") ? data.resource_url : `https://${data.resource_url}/v1`) : undefined,
      expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
    connections.set(providerId, entry);
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

  if (providerId === "antigravity" || providerId === "gemini-cli") {
    const cfg = OAUTH_CLIENTS.antigravity;
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: cfg.clientId,
      code,
      redirect_uri: session.redirectUri,
      code_verifier: session.codeVerifier
    });
    if (cfg.clientSecret) {
      body.set("client_secret", cfg.clientSecret);
    }
    const res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body
    });
    if (!res.ok) {
      const errText = await res.text();
      if (errText.includes("client_secret is missing")) {
        throw new Error(
          "Google OAuth exigiu ANTIGRAVITY_OAUTH_CLIENT_SECRET no .env. Configure a variável ou use 'antigravity-cli' (agy) / GEMINI_API_KEY."
        );
      }
      throw new Error(`${providerId} token exchange failed: ${errText}`);
    }
    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in?: number;
    };
    const info = decodeJwtPayload(tokens.id_token);
    let email = (info?.email as string) || undefined;
    if (!email && tokens.access_token) {
      try {
        const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokens.access_token}` }
        });
        if (userRes.ok) {
          const u = (await userRes.json()) as { email?: string };
          email = u.email;
        }
      } catch {
        // Optional
      }
    }
    const entry: StoredProviderConnection = {
      provider: providerId,
      authType: "oauth",
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      email,
      expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
      updatedAt: new Date().toISOString()
    };
    connections.set(providerId, entry);
    pkceSessions.delete(resolvedState!);
    persistConnections();
    return { connection: entry };
  }

  throw new Error(`Unsupported OAuth provider '${providerId}'`);
}

