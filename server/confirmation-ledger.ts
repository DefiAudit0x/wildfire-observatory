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

      const data = reportSnapshot.data() as { consensusCount?: number; status?: string; voters?: unknown };
      // Preserve legacy bounded history as a migration guard: a principal that
      // appears there must not regain a vote merely because it predates the
      // durable subcollection.
      if (Array.isArray(data.voters) && data.voters.includes(subject)) {
        return { status: "already_voted" as const };
      }

      const consensusCount = (Number(data.consensusCount) || 0) + 1;
      const statusValue = consensusCount >= 5 && (data.status || "pending") === "pending"
        ? "verified"
        : (data.status || "pending");

      tx.create(confirmationRef, { subject, createdAt: Date.now() });
      tx.update(reportRef, { consensusCount, status: statusValue });
      return { status: "confirmed" as const, consensusCount, statusValue };
    });
    if (result.status === "confirmed") invalidateReportsCache();
    return result;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed durable principal confirmation transaction");
    return { status: "error" };
  }
}
