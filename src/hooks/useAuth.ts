import { useEffect, useState, useCallback } from "react";
import { subscribeSessionPoll } from "../lib/session";

export interface StaffSession {
  authenticated: boolean;
  role: string | null;
  unitId: string | null;
  name: string | null;
  agentId: string | null;
}

/**
 * Probes the staff/auth session on the single shared session poller
 * (one interval for the whole app, every 60s) using the httpOnly cookie.
 */
export function useStaffSession(): { session: StaffSession; refetch: () => void } {
  const [session, setSession] = useState<StaffSession>({
    authenticated: false,
    role: null,
    unitId: null,
    name: null,
    agentId: null,
  });

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        setSession({
          authenticated: true,
          role: data.user?.role || null,
          unitId: data.user?.unitId || null,
          name: data.user?.name || null,
          agentId: data.user?.agentId || null,
        });
      } else {
        setSession({ authenticated: false, role: null, unitId: null, name: null, agentId: null });
      }
    } catch {
      setSession({ authenticated: false, role: null, unitId: null, name: null, agentId: null });
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeSessionPoll(refetch);
    return unsubscribe;
  }, [refetch]);

  return { session, refetch };
}