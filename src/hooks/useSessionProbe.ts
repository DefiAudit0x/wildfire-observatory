import { useEffect, useState } from "react";
import { subscribeSessionPoll } from "../lib/session";

export function useSessionProbe(): boolean {
  const [privilegedTabVisible, setPrivilegedTabVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const probeSession = async () => {
      try {
        const res = await fetch("/api/admin/session", { credentials: "same-origin" });
        if (!cancelled) setPrivilegedTabVisible(res.ok);
      } catch {
        if (!cancelled) setPrivilegedTabVisible(false);
      }
    };
    const unsubscribe = subscribeSessionPoll(probeSession);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return privilegedTabVisible;
}