import { useCallback, useState } from "react";
import type { ConfirmationErrorCode } from "../../utils/confirmationErrors";
import { isReportStatus } from "./observatoryPendingReport";
import type { UseObservatoryPollResult } from "./useObservatoryPoll";

/**
 * Consensus confirm + public-principal enrollment (ARC-H4). Extracted from
 * the former god-hook with the exact same error-code discipline: every
 * failure lands in confirmError (rendered as a toast by App) — never silent.
 */

export function useReportConfirmation(
  deviceId: string,
  poll: UseObservatoryPollResult
) {
  const { fetchData } = poll;
  const [confirmError, setConfirmError] = useState<ConfirmationErrorCode | string | null>(null);
  // W-M9: failures must be VISIBLE — App renders confirmError as a toast and
  // clears it through this setter (the hook itself never silently drops it).
  const clearConfirmError = useCallback(() => setConfirmError(null), []);

  // Server-issued anonymous principal (HttpOnly `public_principal` cookie):
  // the confirm endpoint requires it. Enroll lazily with the same 15s write
  // timeout discipline (audit B7); a same-origin POST is enough — the cookie
  // comes back in the response's Set-Cookie header.
  const ensurePublicPrincipal = useCallback(async (): Promise<boolean> => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        // ARC-M17 fix: the controller was built and armed but its signal was
        // never passed to fetch — the 15s timeout aborted nothing, so a hung
        // enrollment could block the confirm retry path indefinitely.
        const res = await fetch("/api/public-principal", { method: "POST", signal: controller.signal });
        return res.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      console.error("Failed to enroll public principal:", err);
      return false;
    }
  }, []);

  // Upvote/Confirm fire (Consensus Engine)
  const handleConfirmReport = useCallback(async (id: string) => {
    setConfirmError(null);
    try {
      // 15s timeout for all write paths (audit B7).
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      try {
        const postConfirm = () =>
          fetch(`/api/reports/${id}/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId }),
            signal: controller.signal,
          });
        let res = await postConfirm();
        // A 401 "Public principal required" means the browser has no (or an
        // expired) principal cookie — first visit or 30-day expiry. Enroll
        // once and retry so the user's first confirm click succeeds.
        if (res.status === 401) {
          const enrolled = await ensurePublicPrincipal();
          if (enrolled) res = await postConfirm();
        }
        if (!res.ok) {
          let message: ConfirmationErrorCode | string = "CONFIRMATION_FAILED";
          try {
            const body = await res.json();
            if (typeof body?.error === "string" && body.error.length <= 200) message = body.error;
          } catch {
            // Non-JSON error response.
          }
          setConfirmError(message);
          return false;
        }
        const result: any = await res.json();
        const status = result?.status;
        const consensusCount = Number(result?.consensusCount);
        if (
          isReportStatus(status) &&
          Number.isInteger(consensusCount) &&
          consensusCount >= 0
        ) {
          // The server response is authoritative. Await the read-after-write
          // reconciliation instead of racing an optimistic state update with
          // a GET that may still contain the previous status.
          await fetchData();
          return true;
        }
        setConfirmError("INVALID_CONFIRMATION_RESPONSE");
        return false;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      // Name check (not instanceof Error): DOMException in some runtimes does
      // not inherit from Error — an aborted fetch always carries the name.
      const message: ConfirmationErrorCode = (err as { name?: string } | null)?.name === "AbortError"
        ? "CONFIRMATION_TIMEOUT"
        : "CONFIRMATION_CONNECTION_FAILED";
      setConfirmError(message);
      console.error("Failed to confirm report:", err);
      return false;
    }
  }, [deviceId, fetchData, ensurePublicPrincipal]);

  return { handleConfirmReport, confirmError, clearConfirmError };
}
