"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { ApiFetchFn } from "../lib/types";

export type WsConnectionStatus = "connecting" | "connected" | "disconnected";

export function useNoemaRealtime(params: {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  apiFetch: ApiFetchFn;
  queryClient: QueryClient;
}): WsConnectionStatus {
  const { apiUrl, apiKey, projectId, apiFetch, queryClient } = params;
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>("disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const apiFetchRef = useRef(apiFetch);
  apiFetchRef.current = apiFetch;

  useEffect(() => {
    if (!apiKey || !apiUrl) {
      setWsStatus("disconnected");
      return;
    }
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;

    async function connectWs() {
      if (cancelled) return;
      setWsStatus("connecting");
      try {
        const ticketRes = await apiFetchRef.current<{ ticket: string; wsPath: string }>("/v1/ws/ticket", {
          method: "POST",
          body: JSON.stringify(projectId ? { projectId } : {})
        });
        if (cancelled) return;
        const base = apiUrl.replace(/\/$/, "").replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
        const ws = new WebSocket(`${base}${ticketRes.wsPath}?ticket=${encodeURIComponent(ticketRes.ticket)}`);
        wsRef.current = ws;

        ws.onopen = () => {
          attempt = 0;
          if (!cancelled) setWsStatus("connected");
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data)) as { type?: string; channel?: string };
            if (msg.type === "sync" && msg.channel) {
              void queryClient.invalidateQueries({ queryKey: [msg.channel] });
              if (msg.channel === "projects") {
                void queryClient.invalidateQueries({ queryKey: ["overview"] });
              }
            }
          } catch {
            // Ignore malformed messages
          }
        };

        ws.onclose = () => {
          if (wsRef.current === ws) wsRef.current = null;
          if (cancelled) return;
          setWsStatus("disconnected");
          const delay = Math.min(10_000, 1000 * Math.pow(2, attempt));
          attempt += 1;
          reconnectTimer = setTimeout(() => {
            void connectWs();
          }, delay);
        };

        ws.onerror = () => {
          ws.close();
        };
      } catch {
        if (cancelled) return;
        setWsStatus("disconnected");
        const delay = Math.min(10_000, 1000 * Math.pow(2, attempt));
        attempt += 1;
        reconnectTimer = setTimeout(() => {
          void connectWs();
        }, delay);
      }
    }

    void connectWs();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [apiUrl, apiKey, queryClient]);

  useEffect(() => {
    if (projectId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", projectId }));
    }
  }, [projectId]);

  return wsStatus;
}

