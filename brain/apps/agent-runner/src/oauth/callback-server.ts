import { createServer, type Server } from "node:http";
import { completedOAuthStates, pkceSessions } from "./store.js";
import type { StoredProviderConnection } from "./types.js";

const activeCallbackServers = new Map<number, Server>();

export function startLocalCallbackListener(
  port: number,
  expectedPath: string,
  completeFn: (providerId: string, code: string, state?: string) => Promise<{ pending?: boolean; connection?: StoredProviderConnection }>
): void {
  if (activeCallbackServers.has(port)) return;
  try {
    const server = createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url || "/", `http://localhost:${port}`);
        if (!reqUrl.pathname.startsWith(expectedPath)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const code = reqUrl.searchParams.get("code") || "";
        const state = reqUrl.searchParams.get("state") || "";
        const oauthError = reqUrl.searchParams.get("error");
        if (oauthError) {
          if (state) completedOAuthStates.set(state, { ok: false, error: oauthError });
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body style="font-family:sans-serif;padding:2rem"><h2>Falha na autorização (${oauthError})</h2><p>Você pode fechar esta aba e tentar novamente no Brain Runner.</p></body></html>`);
          return;
        }
        const session = state ? pkceSessions.get(state) : undefined;
        if (!session || !code) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<html><body style=\"font-family:sans-serif;padding:2rem\"><h2>Sessão OAuth expirada ou código ausente.</h2></body></html>");
          return;
        }
        try {
          const result = await completeFn(session.provider, code, state);
          completedOAuthStates.set(state, { ok: true, connection: result.connection });
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(
            `<html><body style="font-family:sans-serif;padding:2rem;background:#0f172a;color:#f8fafc"><h2>Conectado com sucesso (${session.provider})!</h2><p>${result.connection?.email || "Autenticação concluída."} Pode fechar esta aba e voltar ao Brain Runner.</p><script>setTimeout(()=>window.close(),1500)</script></body></html>`
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          completedOAuthStates.set(state, { ok: false, error: msg });
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<html><body style="font-family:sans-serif;padding:2rem"><h2>Erro ao concluir OAuth2</h2><pre>${msg}</pre></body></html>`);
        } finally {
          setTimeout(() => {
            server.close();
            activeCallbackServers.delete(port);
          }, 1500);
        }
      } catch {
        res.writeHead(500);
        res.end("Internal error");
      }
    });
    server.on("error", () => {
      activeCallbackServers.delete(port);
    });
    server.listen(port, "127.0.0.1");
    activeCallbackServers.set(port, server);
    setTimeout(() => {
      if (activeCallbackServers.has(port)) {
        server.close();
        activeCallbackServers.delete(port);
      }
    }, 5 * 60_000).unref();
  } catch {
    // Non-fatal: manual callback paste still works
  }
}

