import { useEffect, useState, useCallback } from "react";

export interface StaffSession {
  authenticated: boolean;
  role: string | null;
  unitId: string | null;
  name: string | null;
  agentId: string | null;
}

/**
 * Probes the staff/auth session (staff_token cookie or Authorization header
 * stored in sessionStorage by the StaffManager login) every 30s.
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
    const token = sessionStorage.getItem("staff_token");
    try {
      const res = await fetch("/api/auth/session", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "same-origin",
      });
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
    refetch();
    const interval = setInterval(refetch, 15000);
    return () => clearInterval(interval);
  }, [refetch]);

  return { session, refetch };
}