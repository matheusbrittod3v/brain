import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

export interface WsTicketSession {
  tenantId: string;
  actorId: string;
  projectId: string;
  allowedProjects: string[];
  expiresAt: number;
}

export interface RealtimeSyncEvent {
  tenantId: string;
  projectId?: string;
  channel:
    | "projects"
    | "overview"
    | "proposals"
    | "search"
    | "graph"
    | "runner"
    | "integrations"
    | "finops"
    | "audit"
    | "access"
    | "enterprise";
  action: string;
}

interface ConnectedClient {
  ws: WebSocket;
  tenantId: string;
  actorId: string;
  projectId: string;
  allowedProjects: Set<string>;
  isAlive: boolean;
}

const TICKET_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 25_000;

export function createRealtimeHub(options: {
  server: HttpServer;
  allowedCorsOrigin: string;
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const tickets = new Map<string, WsTicketSession>();
  const clients = new Set<ConnectedClient>();

  function pruneExpiredTickets(now = Date.now()) {
    for (const [token, session] of tickets) {
      if (session.expiresAt <= now) {
        tickets.delete(token);
      }
    }
  }

  function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true;
    if (options.allowedCorsOrigin === "*") return true;
    return origin === options.allowedCorsOrigin;
  }

  function rejectUpgrade(socket: Duplex, statusCode: 401 | 403, message: string) {
    socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/v1/ws") return;

    if (!isOriginAllowed(req.headers.origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }

    pruneExpiredTickets();
    const ticket = url.searchParams.get("ticket");
    if (!ticket) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    const session = tickets.get(ticket);
    if (!session || session.expiresAt <= Date.now()) {
      tickets.delete(ticket);
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    tickets.delete(ticket);

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: ConnectedClient = {
        ws,
        tenantId: session.tenantId,
        actorId: session.actorId,
        projectId: session.projectId,
        allowedProjects: new Set(session.allowedProjects),
        isAlive: true
      };
      clients.add(client);

      ws.on("pong", () => {
        client.isAlive = true;
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString("utf8")) as { type?: string; projectId?: string };
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
            return;
          }
          if (msg.type === "subscribe" && typeof msg.projectId === "string" && msg.projectId.trim()) {
            const nextProject = msg.projectId.trim();
            if (client.allowedProjects.size === 0 || client.allowedProjects.has(nextProject)) {
              client.projectId = nextProject;
              ws.send(
                JSON.stringify({
                  type: "subscribed",
                  projectId: nextProject,
                  timestamp: new Date().toISOString()
                })
              );
            }
          }
        } catch {
          // Ignore malformed client frames
        }
      });

      ws.on("close", () => {
        clients.delete(client);
      });

      ws.send(
        JSON.stringify({
          type: "connected",
          tenantId: client.tenantId,
          projectId: client.projectId,
          timestamp: new Date().toISOString()
        })
      );
    });
  };

  options.server.on("upgrade", onUpgrade);

  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) {
        clients.delete(client);
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.ping();
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  return {
    issueTicket(params: {
      tenantId: string;
      actorId: string;
      projectId: string;
      allowedProjects: string[];
    }) {
      pruneExpiredTickets();
      const ticket = randomBytes(32).toString("hex");
      const expiresAt = Date.now() + TICKET_TTL_MS;
      tickets.set(ticket, {
        tenantId: params.tenantId,
        actorId: params.actorId,
        projectId: params.projectId,
        allowedProjects: params.allowedProjects,
        expiresAt
      });
      return {
        ticket,
        expiresInMs: TICKET_TTL_MS,
        wsPath: "/v1/ws"
      };
    },

    publish(event: RealtimeSyncEvent) {
      const payload = JSON.stringify({
        type: "sync",
        channel: event.channel,
        projectId: event.projectId,
        action: event.action,
        timestamp: new Date().toISOString()
      });
      for (const client of clients) {
        if (client.ws.readyState !== WebSocket.OPEN) continue;
        if (client.tenantId !== event.tenantId) continue;
        if (event.projectId && client.projectId && event.projectId !== client.projectId && event.channel !== "projects") {
          continue;
        }
        client.ws.send(payload);
      }
    },

    async close() {
      clearInterval(heartbeat);
      options.server.off("upgrade", onUpgrade);
      for (const client of clients) {
        client.ws.close(1001, "Server shutting down");
      }
      clients.clear();
      tickets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}

