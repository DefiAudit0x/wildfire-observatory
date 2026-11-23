import { useEffect, useState, useCallback } from "react";
import {
  fetchSharedSession,
  getStaffSessionSnapshot,
  isStaffSessionLoading,
  subscribeStaffSession,
} from "../lib/session";
import type { StaffSession } from "../lib/session";

export type { StaffSession } from "../lib/session";

/**
 * Probes the staff/auth session on the single shared session poller
 * (one interval for the whole app, every 60s) using the httpOnly cookie.
 *
 * ARC-M33: StaffManager and RosterBoard used to run their own private
 * session checks against the same endpoint — two truths that could disagree
 * with this one. They now read THIS hook; `loading` covers the first probe
 * so login surfaces don't flash before the initial check resolves.
 *
 * Fix 29 (AUTH-1): the session state itself lives in the shared module
 * (src/lib/session.ts) — this hook is a thin subscriber, so every instance
 * in the app (App, RosterBoard, StaffManager) reads the same session and
 * one post-login refetch broadcasts to all of them. Return shape unchanged.
 */
export function useStaffSession(): { session: StaffSession; refetch: () => void; loading: boolean } {
  const [session, setSession] = useState<StaffSession>(getStaffSessionSnapshot());
  const [loading, setLoading] = useState(isStaffSessionLoading());

  useEffect(() => {
    return subscribeStaffSession((nextSession, nextLoading) => {
      setSession(nextSession);
      setLoading(nextLoading);
    });
  }, []);

  const refetch = useCallback(() => {
    void fetchSharedSession();
  }, []);

  return { session, refetch, loading };
}
