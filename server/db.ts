import { getDb, isAdminDb } from "./firebase.js";
import { citizenReports } from "./data.js";
import logger from "./logger.js";

async function loadClientSdk() {
  return import("firebase/firestore");
}

async function getAdminFirestoreModule() {
  return import("firebase-admin/firestore");
}

export async function getReportsFromFirestore() {
  const db = getDb();
  if (!db) return null;
  try {
    if (isAdminDb(db)) {
      const snapshot = await db.collection("reports").orderBy("timestamp", "desc").get();
      if (snapshot.empty) return null;
      return snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) as any[];
    } else {
      const { collection, getDocs, query, orderBy } = await loadClientSdk();
      const reportsCol = collection(db, "reports");
      const q = query(reportsCol, orderBy("timestamp", "desc"));
      const snapshot = await getDocs(q);
      if (snapshot.empty) return null;
      return snapshot.docs.map((d) => ({ id: d.id, ...d.data() } as any));
    }
  } catch (err) {
    logger.error({ err }, "Error reading reports from Firestore");
    return null;
  }
}

export async function seedReportsToFirestore() {
  const db = getDb();
  if (!db) return;
  try {
    if (isAdminDb(db)) {
      for (const rep of citizenReports) {
        await db.collection("reports").doc(rep.id).set(rep);
      }
    } else {
      const { setDoc, doc } = await loadClientSdk();
      for (const rep of citizenReports) {
        await setDoc(doc(db, "reports", rep.id), rep);
      }
    }
    logger.info("Seeded initial reports to Firestore");
  } catch (err) {
    logger.error({ err }, "Failed to seed reports");
  }
}

export async function saveReportToFirestore(report: any) {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection("reports").doc(report.id).set(report);
    } else {
      const { setDoc, doc } = await loadClientSdk();
      await setDoc(doc(db, "reports", report.id), report);
    }
    return true;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to save report");
    return false;
  }
}

export async function confirmReportInFirestore(id: string, voterId?: string) {
  const db = getDb();
  if (!db) return null;
  const CONSENSUS_THRESHOLD = 5;
  try {
    if (isAdminDb(db)) {
      const docRef = db.collection("reports").doc(id);
      const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists) return null;
        const data = snap.data() as any;
        if (voterId && data.voters?.includes(voterId)) {
          return { error: "ALREADY_VOTED" };
        }
        const newConsensus = (data.consensusCount || 0) + 1;
        let newStatus = data.status || "pending";
        if (newConsensus >= CONSENSUS_THRESHOLD && newStatus === "pending") {
          newStatus = "verified";
        }
        const update: Record<string, any> = { consensusCount: newConsensus, status: newStatus };
        if (voterId) {
          update.voters = [...(data.voters || []), voterId];
        }
        tx.update(docRef, update);
        return { consensusCount: newConsensus, status: newStatus };
      });
      return result;
    } else {
      const { doc, runTransaction } = await loadClientSdk();
      const docRef = doc(db, "reports", id);
      const result = await runTransaction(db, async (tx) => {
        const snap = await tx.get(docRef);
        if (!snap.exists()) return null;
        const data = snap.data() as any;
        if (voterId && data.voters?.includes(voterId)) {
          return { error: "ALREADY_VOTED" };
        }
        const newConsensus = (data.consensusCount || 0) + 1;
        let newStatus = data.status || "pending";
        if (newConsensus >= CONSENSUS_THRESHOLD && newStatus === "pending") {
          newStatus = "verified";
        }
        const update: Record<string, any> = { consensusCount: newConsensus, status: newStatus };
        if (voterId) {
          update.voters = [...(data.voters || []), voterId];
        }
        tx.update(docRef, update);
        return { consensusCount: newConsensus, status: newStatus };
      });
      return result;
    }
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to confirm report");
    return null;
  }
}

export async function updateReportInFirestore(id: string, updateData: Record<string, any>) {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection("reports").doc(id).update(updateData);
    } else {
      const { doc, updateDoc } = await loadClientSdk();
      await updateDoc(doc(db, "reports", id), updateData);
    }
    return true;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to update report");
    return false;
  }
}

export async function deleteReportFromFirestore(id: string) {
  const db = getDb();
  if (!db) return false;
  try {
    if (isAdminDb(db)) {
      await db.collection("reports").doc(id).delete();
    } else {
      const { doc, deleteDoc } = await loadClientSdk();
      await deleteDoc(doc(db, "reports", id));
    }
    return true;
  } catch (err) {
    logger.error({ err }, "[Firestore] Failed to delete report");
    return false;
  }
}
