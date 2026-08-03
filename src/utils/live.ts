import { useEffect, useRef } from "react";

export interface LiveEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export function useLiveEvents(onEvent: (event: LiveEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryMs = 1000;
    let closed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${window.location.host}/api/live`);

      ws.onopen = () => {
        retryMs = 1000;
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(String(event.data)) as LiveEvent;
          handlerRef.current(parsed);
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (closed) return;
        reconnectTimer = setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30000);
      };

      ws.onerror = () => {
        try {
          ws?.close();
        } catch {
          // ignore
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    };
  }, []);
}
