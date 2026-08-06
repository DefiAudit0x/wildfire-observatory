import { useEffect, useState } from "react";

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
    probeSession();
    const poll = setInterval(probeSession, 15000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, []);

  return privilegedTabVisible;
}