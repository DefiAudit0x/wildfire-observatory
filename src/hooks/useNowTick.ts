import { useEffect, useState } from "react";

/**
 * ARC-L22: "time ago" renderings froze between data polls — the underlying
 * timestamp only changed when the parent refetched, so a "2 min" chip could
 * stick for minutes. This hook returns a `now` value that advances on a fixed
 * tick, giving any consumer a cheap, shared re-render heartbeat.
 *
 * The interval pauses while the tab is hidden (nothing visible to update).
 */
export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      setNow(Date.now());
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return now;
}
