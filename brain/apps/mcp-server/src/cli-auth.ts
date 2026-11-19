import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { installBrainAgentInstructions } from "./agent-instructions.js";

export interface StoredMcpCredentials {
  apiUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tenantId?: string;
  actorId?: string;
  email?: string;
  savedAt: string;
}

export function getCredentialsPath(): string {
  return join(homedir(), ".brain", "credentials.json");
}

export async function loadStoredCredentials(): Promise<StoredMcpCredentials | null> {
  try {
    const raw = await readFile(getCredentialsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredMcpCredentials>;
    if (!parsed.apiUrl || !parsed.accessToken) return null;
    return {
      apiUrl: parsed.apiUrl.replace(/\/+$/, ""),
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      tenantId: parsed.tenantId,
      actorId: parsed.actorId,
      email: parsed.email,
      savedAt: parsed.savedAt ?? new Date().toISOString()
    };
  } catch {
    return null;
  }
}

async function saveStoredCredentials(creds: StoredMcpCredentials): Promise<void> {
  const credsPath = getCredentialsPath();
  await mkdir(dirname(credsPath), { recursive: true });
  await writeFile(credsPath, JSON.stringify(creds, null, 2), "utf8");
  await chmod(credsPath, 0o600).catch(() => {});
}

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Non-fatal
  }
}

/**
 * Interactive OAuth 2.1 PKCE login (`brain-mcp login`) with automatic browser callback (no code typing).
 */
export async function runMcpLoginFlow(apiUrlInput?: string): Promise<void> {
  const apiUrl = (apiUrlInput || process.env.BRAIN_API_URL || "http://localhost:3333").replace(/\/+$/, "");
  const webUrl = (process.env.BRAIN_WEB_URL || "http://localhost:3000").replace(/\/+$/, "");

  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  const { code, redirectUri, clientId } = await new Promise<{ code: string; redirectUri: string; clientId: string }>(
    (resolve, reject) => {
      const server = createServer(async (req, res) => {
        try {
          const url = new URL(req.url || "/", "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const err = url.searchParams.get("error");
          const authCode = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");
          if (err || !authCode || returnedState !== state) {
            res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
            res.end("<h3>Autorização cancelada ou inválida. Você pode fechar esta aba.</h3>");
            server.close();
            reject(new Error(err || "Callback OAuth inválido."));
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<h3>Brain MCP autenticado com sucesso! Você já pode fechar esta aba.</h3>");
          server.close();
          resolve({ code: authCode, redirectUri: boundRedirectUri, clientId: registeredClientId });
        } catch (e) {
          server.close();
          reject(e);
        }
      });

      let boundRedirectUri = "";
      let registeredClientId = "brain-mcp-cli";
      server.listen(0, "127.0.0.1", async () => {
        try {
          const addr = server.address();
          if (!addr || typeof addr === "string") throw new Error("Falha ao abrir porta local de callback.");
          boundRedirectUri = `http://127.0.0.1:${addr.port}/callback`;

          const regRes = await fetch(`${apiUrl}/oauth/register`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              client_name: "Brain MCP CLI (stdio)",
              redirect_uris: [boundRedirectUri],
              grant_types: ["authorization_code", "refresh_token"],
              scope: "projects:all knowledge:read knowledge:write runner:execute"
            })
          });
          if (regRes.ok) {
            const reg = (await regRes.json()) as { client_id?: string };
            if (reg.client_id) registeredClientId = reg.client_id;
          }

          const authUrl = new URL(`${webUrl}/auth/oauth`);
          authUrl.searchParams.set("response_type", "code");
          authUrl.searchParams.set("client_id", registeredClientId);
          authUrl.searchParams.set("redirect_uri", boundRedirectUri);
          authUrl.searchParams.set("code_challenge", codeChallenge);
          authUrl.searchParams.set("code_challenge_method", "S256");
          authUrl.searchParams.set("scope", "projects:all knowledge:read knowledge:write runner:execute");
          authUrl.searchParams.set("state", state);

          console.error(`\n[brain-mcp] Abrindo navegador para aprovação 1-clique:\n  ${authUrl.toString()}\n`);
          tryOpenBrowser(authUrl.toString());
        } catch (e) {
          server.close();
          reject(e);
        }
      });
    }
  );

  const tokenRes = await fetch(`${apiUrl}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier
    })
  });
  if (!tokenRes.ok) {
    throw new Error(`Falha ao trocar código por token: HTTP ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  await saveStoredCredentials({
    apiUrl,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
    savedAt: new Date().toISOString()
  });
  const installed = await installBrainAgentInstructions({ includeGlobal: true }).catch(() => ({ writtenFiles: [] }));
  console.error(`[brain-mcp] Autenticado com sucesso! Credenciais salvas em ${getCredentialsPath()}`);
  if (installed.writtenFiles.length > 0) {
    console.error(`[brain-mcp] Skill & instruções de agentes atualizadas: ${installed.writtenFiles.join(", ")}`);
  }
}

export async function runMcpWhoami(): Promise<void> {
  const creds = await loadStoredCredentials();
  if (!creds) {
    console.log(JSON.stringify({ authenticated: false, credentialsFile: getCredentialsPath(), hint: "Execute 'brain-mcp login' para autenticar." }, null, 2));
    return;
  }
  const res = await fetch(`${creds.apiUrl}/v1/auth/me`, {
    headers: { authorization: `Bearer ${creds.accessToken}` }
  }).catch(() => null);
  const session = res?.ok ? await res.json().catch(() => null) : null;
  console.log(
    JSON.stringify(
      {
        authenticated: Boolean(session),
        apiUrl: creds.apiUrl,
        actorId: creds.actorId,
        email: creds.email,
        expiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : null,
        credentialsFile: getCredentialsPath(),
        session
      },
      null,
      2
    )
  );
}

export async function runMcpLogout(): Promise<void> {
  const creds = await loadStoredCredentials();
  if (creds) {
    await fetch(`${creds.apiUrl}/v1/auth/mcp-tokens/revoke-current`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.accessToken}` }
    }).catch(() => {});
  }
  await rm(getCredentialsPath(), { force: true });
  console.error(`[brain-mcp] Sessão encerrada e credenciais removidas de ${getCredentialsPath()}`);
}

async function refreshIfNeeded(creds: StoredMcpCredentials, force = false): Promise<StoredMcpCredentials> {
  if (!creds.refreshToken) return creds;
  const nearExpiry = creds.expiresAt ? creds.expiresAt - Date.now() < 5 * 60 * 1000 : false;
  if (!force && !nearExpiry) return creds;

  try {
    const res = await fetch(`${creds.apiUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: creds.refreshToken })
    });
    if (!res.ok) return creds;
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const updated: StoredMcpCredentials = {
      ...creds,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt,
      savedAt: new Date().toISOString()
    };
    await saveStoredCredentials(updated);
    return updated;
  } catch {
    return creds;
  }
}

/**
 * Proxies stdio JSON-RPC messages to the authenticated `/mcp` Streamable HTTP endpoint with session & auto-refresh.
 */
export async function runStdioHttpProxy(initialCredentials: StoredMcpCredentials): Promise<void> {
  let creds = initialCredentials;
  let mcpSessionId: string | null = null;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const endpoint = `${creds.apiUrl}/mcp`;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msgId: unknown = null;
    try {
      const parsed = JSON.parse(trimmed) as { id?: unknown };
      msgId = parsed.id ?? null;
    } catch {
      continue;
    }

    try {
      creds = await refreshIfNeeded(creds);
      const sendRequest = (token: string) =>
        fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
            "x-brain-client": "brain-mcp-stdio-proxy",
            ...(mcpSessionId ? { "mcp-session-id": mcpSessionId } : {})
          },
          body: trimmed
        });

      let res = await sendRequest(creds.accessToken);
      if (res.status === 401 && creds.refreshToken) {
        creds = await refreshIfNeeded(creds, true);
        res = await sendRequest(creds.accessToken);
      }

      const sid = res.headers.get("mcp-session-id");
      if (sid) mcpSessionId = sid;

      const contentType = res.headers.get("content-type") ?? "";
      const bodyText = await res.text();
      if (!res.ok) {
        let isJsonRpc = false;
        if (bodyText.trim().startsWith("{")) {
          try {
            const parsed = JSON.parse(bodyText) as Record<string, unknown>;
            isJsonRpc = parsed.jsonrpc === "2.0" && (typeof parsed.error !== "string");
          } catch {
            isJsonRpc = false;
          }
        }
        if (!isJsonRpc) {
          if (msgId !== null) {
            process.stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: msgId,
                error: { code: -32001, message: bodyText.trim() || `HTTP ${res.status} from ${endpoint}` }
              })}\n`
            );
          }
          continue;
        }
      }

      if (contentType.includes("text/event-stream")) {
        for (const sseLine of bodyText.split(/\r?\n/)) {
          if (sseLine.startsWith("data:")) {
            const data = sseLine.slice(5).trim();
            if (data && data !== "[DONE]") process.stdout.write(`${data}\n`);
          }
        }
      } else if (bodyText.trim()) {
        process.stdout.write(`${bodyText.trim()}\n`);
      }
    } catch (err) {
      if (msgId !== null) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msgId,
            error: { code: -32002, message: err instanceof Error ? err.message : String(err) }
          })}\n`
        );
      }
    }
  }
}
