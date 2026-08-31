import { useEffect, useRef } from "react";
import { ReconnectingSocket } from "../hooks/useReconnectingSocket";

export interface LiveEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

export function useLiveEvents(onEvent: (event: LiveEvent) => void): void {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  useEffect(() => {
    // ARC-M14: this used to be a second hand-rolled WebSocket client with no
    // heartbeat (a half-open link behind a proxy stayed silently dead until
    // the GET poll hid it) and an unjittered reconnect storm. It now runs on
    // the same ReconnectingSocket engine as the mesh client. No quiet-socket
    // watchdog here: the live hub does not answer pings, so inbound silence
    // is normal on a quiet day — the 30s heartbeat only keeps proxies and
    // NAT gateways from dropping the idle connection.
    const socket = new ReconnectingSocket({
      createSocket: () =>
        new WebSocket(
          `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/api/live`
        ),
      heartbeatMs: 30_000,
      onMessage: (event) => {
        try {
          handlerRef.current(JSON.parse(String(event.data)) as LiveEvent);
        } catch {
          // ignore malformed frames
        }
      },
    });
    socket.connect();
    return () => socket.disconnect();
  }, []);
}
