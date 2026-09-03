import { useEffect, useRef, useState } from "react";
import { loadOfflineDrafts, removeOfflineDrafts, replaceOfflineDrafts } from "../../utils/offlineDraftStore";
import { normalizeSubmissionResult } from "./reportFormShared";

/**
 * ARC-H13 — THE owner of the offline-drafts concern: loading the durable
 * queue on mount, the honest connectivity status (browser `offline/online`
 * + the mesh gateway's `mesh:online`), the DEV-only network simulation
 * toggle, the automatic sync on connectivity return, and the manual sync
 * loop with its per-draft idempotency contract.
 *
 * Sync semantics (ported verbatim):
 *  - drafts are pushed IN ORDER, oldest first, stopping on the first failure
 *    so ordering is preserved and the server is not flooded;
 *  - a draft is removed from the queue ONLY after the server accepted it
 *    (clientGeneratedId makes a re-push idempotent — a tab closed mid-sync
 *    never duplicates);
 *  - if the durable store fails to commit the post-sync state, the in-memory
 *    snapshot is kept and the message says so (no false "synced" claim).
 */
export interface UseOfflineDraftQueueParams {
  onSubmit: (data: any) => Promise<any>;
  isArabic: boolean;
  /** Shared with useReportSubmit — the sync loop drives the same spinner. */
  setSubmitting: (busy: boolean) => void;
}

export function useOfflineDraftQueue({ onSubmit, isArabic, setSubmitting }: UseOfflineDraftQueueParams) {
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const allowOfflineSimulation = import.meta.env.DEV;
  const [isOfflineSimulation, setIsOfflineSimulation] = useState(false);
  const [offlineDrafts, setOfflineDrafts] = useState<any[]>([]);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);
  const syncingDrafts = useRef(false);

  // Load offline drafts on mount (download of connectivity is handled below)
  useEffect(() => {
    void loadOfflineDrafts()
      .then((stored) => {
        setOfflineDrafts(stored.map((draft) => ({
          ...draft,
          schemaVersion: draft.schemaVersion ?? 1,
          createdAt: draft.createdAt ?? draft.timestamp ?? new Date().toISOString(),
          queuedAt: draft.queuedAt ?? draft.timestamp ?? new Date().toISOString(),
          retryCount: Number.isFinite(draft.retryCount) ? draft.retryCount : 0,
        })));
      })
      .catch((error: unknown) => console.error("Failed to load drafts", error));
    return undefined;
  }, []);

  const syncOfflineDrafts = async () => {
    if (offlineDrafts.length === 0 || syncingDrafts.current) return;
    syncingDrafts.current = true;
    setSubmitting(true);
    setSyncStatusMsg(isArabic ? "جاري مزامنة المسودات والتحقق من قبول الخادم..." : "Synchronisation des brouillons et vérification de l'acceptation serveur...");

    let successCount = 0;
    const draftSnapshot = [...offlineDrafts];
    const syncedIds = new Set<string>();
    let failedDraftId: string | null = null;
    let failedMessage: string | null = null;

    for (const draft of draftSnapshot) {
      // clientGeneratedId lets the server answer idempotently — a draft that
      // was already pushed (e.g. the tab closed mid-sync) is returned as-is
      // instead of being duplicated.
      const payload = {
        lat: draft.lat,
        lng: draft.lng,
        locationName: draft.locationName,
        wilaya: draft.wilaya,
        severity: draft.severity,
        description: draft.description,
        reporterName: draft.reporterName,
        reporterPhone: draft.reporterPhone,
        reporterType: draft.reporterType,
        reporterBadgeCode: draft.reporterBadgeCode,
        image: draft.image,
        clientGeneratedId: draft.id,
      };
      try {
        const syncResult = normalizeSubmissionResult(await onSubmit(payload));
        if (!syncResult.responseValid) {
          throw new Error(syncResult.error || "Server did not confirm the draft");
        }
        successCount++;
        syncedIds.add(draft.id); // remove only after server acceptance
      } catch (err: unknown) {
        console.error("Failed to sync draft", draft.id, err);
        failedDraftId = draft.id;
        failedMessage = err instanceof Error ? err.message : "sync failed";
        break; // stop on first error to prevent losing ordering or flooding
      }
    }
    const nextDrafts = draftSnapshot
      .filter((draft) => !syncedIds.has(draft.id))
      .map((draft) => draft.id === failedDraftId
        ? { ...draft, retryCount: (Number.isFinite(draft.retryCount) ? draft.retryCount : 0) + 1, lastError: failedMessage, lastAttemptAt: new Date().toISOString() }
        : draft);
    let persistenceError = false;
    try {
      // ARC-L15: the store is a merge now — synced drafts are removed
      // EXPLICITLY (tombstoned) instead of being dropped by full-list
      // omission, which a stale second tab could resurrect.
      await replaceOfflineDrafts(nextDrafts);
      await removeOfflineDrafts([...syncedIds]);
      setOfflineDrafts(nextDrafts);
    } catch (error: unknown) {
      persistenceError = true;
      console.error("Failed to persist the remaining offline drafts", error);
      // Do not claim successful synchronization or hide drafts in memory when
      // the durable queue did not commit. The server idempotency key makes a
      // later retry safe, while retaining the snapshot prevents local loss.
      setOfflineDrafts(draftSnapshot);
      setSyncStatusMsg(isArabic ? "تعذر تحديث طابور المسودات محليًا؛ أُبقيت المسودات للمحاولة لاحقًا." : "Impossible de mettre à jour la file locale ; les brouillons sont conservés pour une nouvelle tentative.");
    }

    syncingDrafts.current = false;
    setSubmitting(false);
    if (persistenceError) return;
    if (successCount > 0) {
      setSyncStatusMsg(
        isArabic
          ? `✓ تم قبول ومزامنة ${successCount} بلاغ(ات) ميدانية مع المرصد الرئيسي.`
          : `✓ ${successCount} rapport(s) accepté(s) et synchronisé(s) avec l'observatoire.`
      );
      setTimeout(() => setSyncStatusMsg(null), 8000);
    } else {
      setSyncStatusMsg(
        isArabic
          ? "⚠️ عذراً، فشلت عملية المزامنة. يرجى التحقق من اتصال الإنترنت وحاول مجدداً."
          : "⚠️ Échec de la synchronisation. Vérifiez votre connexion."
      );
    }
  };

  // Automatic sync: the moment connectivity returns, stored drafts are pushed
  // through either browser Internet or the active Mesh gateway. A failed retry
  // preserves its draft and surfaces the existing recovery state.
  useEffect(() => {
    const handleConnectivityReturn = () => {
      setIsOffline(false);
      if (offlineDrafts.length > 0 && !syncingDrafts.current) {
        void syncOfflineDrafts();
      }
    };
    const handleOfflineStatus = () => setIsOffline(true);
    window.addEventListener("online", handleConnectivityReturn);
    window.addEventListener("mesh:online", handleConnectivityReturn);
    window.addEventListener("offline", handleOfflineStatus);
    return () => {
      window.removeEventListener("online", handleConnectivityReturn);
      window.removeEventListener("mesh:online", handleConnectivityReturn);
      window.removeEventListener("offline", handleOfflineStatus);
    };
  }, [offlineDrafts.length]);

  /**
   * Offline intercept (called from useReportSubmit): append the draft
   * chronologically (ARC-L10 — the sync loop consumes the array in order, so
   * the OLDEST queued draft must sit first) and persist durably BEFORE the
   * in-memory list moves. Returns false when the durable commit failed — the
   * caller then surfaces the storage error and keeps the form filled.
   */
  const persistDraft = async (draftReport: any): Promise<boolean> => {
    const updatedDrafts = [...offlineDrafts, draftReport];
    try {
      await replaceOfflineDrafts(updatedDrafts);
    } catch (err: unknown) {
      console.error("Failed to save drafts to storage", err);
      return false;
    }
    setOfflineDrafts(updatedDrafts);
    return true;
  };

  return {
    isOffline,
    isOfflineSimulation,
    allowOfflineSimulation,
    offlineDrafts,
    syncStatusMsg,
    toggleOfflineSimulation: () => setIsOfflineSimulation((value) => !value),
    syncOfflineDrafts,
    persistDraft,
  };
}
