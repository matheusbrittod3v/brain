import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline";

export interface StoredMcpCredentials {
  apiUrl: string;
  accessToken: string;
  tenantId?: string;
  actorId?: string;
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
      tenantId: parsed.tenantId,
      actorId: parsed.actorId,
      savedAt: parsed.savedAt ?? new Date().toISOString()
    };
  } catch {
    return null;
  }
}

function tryOpenBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    // Non-fatal: user can open the printed URL manually
  }
}

/**
 * Interactive OAuth2 Device Flow login (`brain-mcp login`) that stores a user JWT in `~/.brain/credentials.json`.
 */
export async function runMcpLoginFlow(apiUrlInput?: string): Promise<void> {
  const apiUrl = (apiUrlInput || process.env.BRAIN_API_URL || "http://localhost:3333").replace(/\/+$/, "");
  const webUrl = (process.env.BRAIN_WEB_URL || "http://localhost:3000").replace(/\/+$/, "");
  const clientId = "brain-mcp-cli";

  const codeRes = await fetch(`${apiUrl}/v1/auth/oauth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientName: "Brain MCP CLI (stdio)", scope: "projects:all" })
  });

  if (!codeRes.ok) {
    throw new Error(`Falha ao iniciar OAuth Device Flow em ${apiUrl}: HTTP ${codeRes.status}`);
  }

  const codeData = (await codeRes.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  const verifyUrl = `${webUrl}${codeData.verification_uri}?code=${encodeURIComponent(codeData.user_code)}`;
  console.error(`\n[brain-mcp] Abra o link abaixo para aprovar a conexão:\n  ${verifyUrl}\n\nCódigo de verificação: ${codeData.user_code}\n`);
  tryOpenBrowser(verifyUrl);

  const deadline = Date.now() + (codeData.expires_in || 600) * 1000;
  const pollMs = Math.max(1500, (codeData.interval || 2) * 1000);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const tokenRes = await fetch(`${apiUrl}/v1/auth/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: codeData.device_code, clientId })
    });

    if (tokenRes.ok) {
      const tokenData = (await tokenRes.json()) as {
        access_token: string;
        user?: { id?: string; email?: string };
      };
      const credsPath = getCredentialsPath();
      await mkdir(dirname(credsPath), { recursive: true });
      const payload: StoredMcpCredentials = {
        apiUrl,
        accessToken: tokenData.access_token,
        actorId: tokenData.user?.id,
        savedAt: new Date().toISOString()
      };
      await writeFile(credsPath, JSON.stringify(payload, null, 2), "utf8");
      await chmod(credsPath, 0o600).catch(() => {});
      console.error(`[brain-mcp] Autenticado como ${tokenData.user?.email ?? tokenData.user?.id ?? "usuário"}. Credenciais salvas em ${credsPath}`);
      return;
    }

    const errText = await tokenRes.text().catch(() => "");
    if (tokenRes.status === 400 && errText.includes("authorization_pending")) {
      continue;
    }
    if (tokenRes.status >= 401) {
      throw new Error(`Autorização rejeitada ou expirada (${tokenRes.status}): ${errText}`);
    }
  }

  throw new Error("Tempo limite excedido aguardando aprovação OAuth2.");
}

/**
 * Proxies stdio JSON-RPC messages to the authenticated `/mcp` Streamable HTTP endpoint.
 */
export async function runStdioHttpProxy(credentials: StoredMcpCredentials): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const endpoint = `${credentials.apiUrl}/mcp`;

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
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${credentials.accessToken}`
        },
        body: trimmed
      });

      const contentType = res.headers.get("content-type") ?? "";
      const bodyText = await res.text();
      if (!res.ok && !bodyText) {
        if (msgId !== null) {
          process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msgId, error: { code: -32001, message: `HTTP ${res.status} from ${endpoint}` } })}\n`);
        }
        continue;
      }

      if (contentType.includes("text/event-stream")) {
        for (const sseLine of bodyText.split(/\r?\n/)) {
          if (sseLine.startsWith("data:")) {
            const data = sseLine.slice(5).trim();
            if (data && data !== "[DONE]") {
              process.stdout.write(`${data}\n`);
            }
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

