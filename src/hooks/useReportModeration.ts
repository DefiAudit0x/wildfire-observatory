import { useCallback, useRef, useState } from "react";
import { apiFetch, isSessionExpiry } from "../utils/adminApi";

/**
 * ARC-M31: two parallel moderation UIs drove the SAME endpoint
 * (/api/admin/reports/:id/update-status) with two behaviours — AdminPanel
 * handled 401 expiry, surfaced failures and gave feedback, while the command
 * surface's ReportsTable let an expired session turn the button silent and
 * swallowed failures into console.error, with drifting Arabic labels.
 *
 * This hook is the single moderation call for both surfaces: one busy-set,
 * one endpoint, one feedback contract. Messages live here so both surfaces
 * show the same wording; each surface only chooses WHERE they appear (toast
 * channel) and what a 401 does to its own session surface.
 */

export interface ReportModerationFeedback {
  /** Refresh the surface's data after a successful change. */
  onSettled: () => void;
  /** 401 — the session cookie no longer grants this action. */
  onSessionExpiry: (message: string) => void;
  /** User-visible failure (server rejection or network error). */
  onError: (message: string) => void;
  /** User-visible success. */
  onSuccess: (message: string) => void;
}

export function useReportModeration(isArabic: boolean, feedback: ReportModerationFeedback) {
  const [updatingIds, setUpdatingIds] = useState<Set<string>>(new Set());

  // ARC-M27 lesson: these callbacks are (re)created by parent renders — the
  // latest instance lives in a ref so the callables below stay referentially
  // stable.
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;
  const isArabicRef = useRef(isArabic);
  isArabicRef.current = isArabic;

  const post = useCallback(async (id: string, body: Record<string, string>, successAr: string, successFr: string): Promise<void> => {
    setUpdatingIds((prev) => new Set(prev).add(id));
    const { onSettled, onSessionExpiry, onError, onSuccess } = feedbackRef.current;
    const ar = isArabicRef.current;
    try {
      const res = await apiFetch(`/api/admin/reports/${encodeURIComponent(id)}/update-status`, "POST", body);
      if (res.ok) {
        onSettled();
        onSuccess(ar ? successAr : successFr);
      } else if (isSessionExpiry(res)) {
        onSessionExpiry(ar ? "انتهت صلاحية جلستك — سجّل الدخول مجدداً" : "Session expirée — veuillez vous reconnecter");
      } else {
        onError(ar ? "فشل تحديث حالة البلاغ" : "Échec de la mise à jour de l'état du signalement");
      }
    } catch {
      onError(ar ? "فشل تحديث حالة البلاغ — تحقق من الاتصال" : "Échec de la mise à jour — vérifiez la connexion");
    } finally {
      setUpdatingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const updateStatus = useCallback(
    (id: string, status: string) => post(id, { status }, "تم تحديث حالة البلاغ", "État du signalement mis à jour"),
    [post]
  );

  const updateSeverity = useCallback(
    (id: string, severity: string) => post(id, { severity }, "تم تحديث درجة خطورة البلاغ", "Gravité du signalement mise à jour"),
    [post]
  );

  return { updatingIds, updateStatus, updateSeverity };
}
