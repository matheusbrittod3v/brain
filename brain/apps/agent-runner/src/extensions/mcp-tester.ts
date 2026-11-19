import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { RunnerMcpServerItem } from "./presets.js";
import { getProjectMcpsMap, persistExtensionsStore } from "./store.js";

const execFileAsync = promisify(execFile);

export async function testRunnerMcpServer(
  projectId: string,
  serverId: string
): Promise<NonNullable<RunnerMcpServerItem["lastTest"]>> {
  const map = getProjectMcpsMap(projectId);
  const server = map[serverId];
  if (!server) {
    throw new Error(`MCP Server '${serverId}' não encontrado.`);
  }

  const started = Date.now();
  const extraPath = process.env.HOME ? `${process.env.HOME}/.local/bin:/opt/homebrew/bin` : "/opt/homebrew/bin";
  const env = { ...process.env, ...server.env, PATH: `${extraPath}:${process.env.PATH || ""}` };

  let result: NonNullable<RunnerMcpServerItem["lastTest"]>;

  if (server.transport !== "stdio") {
    if (!server.url) {
      result = { ok: false, error: "URL não configurada", testedAt: new Date().toISOString() };
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      try {
        const res = await fetch(server.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            ...(server.headers || {})
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "brain-runner", version: "0.1.0" }
            }
          }),
          signal: controller.signal
        });
        const latencyMs = Date.now() - started;
        if (res.ok) {
          let serverName: string | undefined;
          let serverVersion: string | undefined;
          try {
            const text = await res.text();
            const parsed = JSON.parse(text) as { result?: { serverInfo?: { name?: string; version?: string } } };
            serverName = parsed.result?.serverInfo?.name;
            serverVersion = parsed.result?.serverInfo?.version;
          } catch {
            // SSE or non-JSON response still indicates endpoint is reachable
          }
          result = { ok: true, latencyMs, serverName, serverVersion, testedAt: new Date().toISOString() };
        } else {
          result = { ok: false, latencyMs, error: `HTTP ${res.status}`, testedAt: new Date().toISOString() };
        }
      } catch (err) {
        result = {
          ok: false,
          latencyMs: Date.now() - started,
          error: err instanceof Error ? err.message : "Falha na conexão",
          testedAt: new Date().toISOString()
        };
      } finally {
        clearTimeout(timer);
      }
    }
  } else if (!server.command) {
    result = { ok: false, error: "Comando stdio não configurado", testedAt: new Date().toISOString() };
  } else {
    try {
      await execFileAsync("which", [server.command], { env, timeout: 1500 });
      result = await new Promise((resolve) => {
        const child = spawn(server.command!, server.args || [], {
          stdio: ["pipe", "pipe", "pipe"],
          env
        });
        let settled = false;
        let buffer = "";
        let stderr = "";
        const finish = (r: NonNullable<RunnerMcpServerItem["lastTest"]>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            child.kill("SIGTERM");
          } catch {
            // Ignore
          }
          resolve(r);
        };

        const timer = setTimeout(() => {
          finish({
            ok: true,
            latencyMs: Date.now() - started,
            serverName: server.name,
            testedAt: new Date().toISOString()
          });
        }, 3500);

        child.stdout.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          for (const line of buffer.split(/\r?\n/)) {
            if (!line.trim().startsWith("{")) continue;
            try {
              const msg = JSON.parse(line) as { result?: { serverInfo?: { name?: string; version?: string } } };
              if (msg.result?.serverInfo) {
                finish({
                  ok: true,
                  latencyMs: Date.now() - started,
                  serverName: msg.result.serverInfo.name,
                  serverVersion: msg.result.serverInfo.version,
                  testedAt: new Date().toISOString()
                });
              }
            } catch {
              // Keep buffering
            }
          }
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (err) => {
          finish({
            ok: false,
            latencyMs: Date.now() - started,
            error: err.message,
            testedAt: new Date().toISOString()
          });
        });

        child.on("close", (code) => {
          if (!settled) {
            finish({
              ok: code === 0,
              latencyMs: Date.now() - started,
              error: code !== 0 ? stderr.trim() || `Processo encerrou com código ${code}` : undefined,
              testedAt: new Date().toISOString()
            });
          }
        });

        const initReq = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "brain-runner", version: "0.1.0" }
          }
        });
        child.stdin.write(`${initReq}\n`);
      });
    } catch {
      result = {
        ok: false,
        latencyMs: Date.now() - started,
        error: `Binário '${server.command}' não encontrado no PATH`,
        testedAt: new Date().toISOString()
      };
    }
  }

  server.lastTest = result;
  server.updatedAt = new Date().toISOString();
  persistExtensionsStore();
  return result;
}

