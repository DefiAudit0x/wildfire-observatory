import { getDb, isAdminDb } from "./firebase.js";
import { invalidateReportsCache } from "./db.js";
import logger from "./logger.js";

export type PrincipalConfirmationResult =
  | { status: "confirmed"; consensusCount: number; statusValue: string }
  | { status: "already_voted" }
  | { status: "not_found" }
  | { status: "no_db" }
  | { status: "error" };

/**
 * Durable one-principal-one-confirmation ledger. The confirmation document is
 * keyed by the server-verified principal subject, so consensus history never
 * needs to truncate a voter list and a prior voter remains blocked after more
 * than 50 later confirmations.
 */
export async function confirmReportWithPrincipal(reportId: string, subject: string): Promise<PrincipalConfirmationResult> {
  const db = getDb();
  if (!db || !isAdminDb(db)) return { status: "no_db" };

  try {
    const reportRef = db.collection("reports").doc(reportId);
    const confirmationRef = reportRef.collection("confirmations").doc(subject);
    const result = await db.runTransaction(async (tx) => {
      const [reportSnapshot, confirmationSnapshot] = await Promise.all([
        tx.get(reportRef),
        tx.get(confirmationRef),
      ]);
      if (!reportSnapshot.exists) return { status: "not_found" as const };
      if (confirmationSnapshot.exists) return { status: "already_voted" as const };

      const data = reportSnapshot.data() as { consensusCount?: number; status?: string; voters?: unknown; communityConfirmed?: boolean };
      // Preserve legacy bounded history as a migration guard: a principal that
      // appears there must not regain a vote merely because it predates the
      // durable subcollection.
      if (Array.isArray(data.voters) && data.voters.includes(subject)) {
        return { status: "already_voted" as const };
      }

      const consensusCount = (Number(data.consensusCount) || 0) + 1;
      // v2.15.0 (audit fix — Sybil-resistant consensus): anonymous public
      // principals can no longer flip a report to "verified" by count alone
      // (five fresh cookies from one IP used to mint authority). Reaching the
      // community threshold now records communityConfirmed — displayed as the
      // distinct "مؤكد مجتمعياً" state — while VERIFIED stays reserved for the
      // trusted paths: official/volunteer badge verification at creation and
      // operator moderation.
      const communityConfirmed = consensusCount >= 5 || data.communityConfirmed === true;
      const statusValue = data.status || "pending";

      tx.create(confirmationRef, { subject, createdAt: Date.now() });
      tx.update(reportRef, { consensusCount, status: statusValue, communityConfirmed });
      return { status: "confirmed" as const, consensusCount, statusValue };
    });
    if (result.status === "confirmed") invalidateReportsCache();
    return result;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed durable principal confirmation transaction");
    return { status: "error" };
  }
}
