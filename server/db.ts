import { getDb, isAdminDb } from "./firebase.js";
import { citizenReports } from "./data.js";

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
    console.error("Error reading reports from Firestore:", err);
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
    console.log("Seeded initial reports to Firestore");
  } catch (err) {
    console.error("Failed to seed reports:", err);
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
    console.error("[Firestore] Failed to save report:", err);
    return false;
  }
}

export async function confirmReportInFirestore(id: string) {
  const db = getDb();
  if (!db) return null;
  try {
    if (isAdminDb(db)) {
      const docRef = db.collection("reports").doc(id);
      const snap = await docRef.get();
      if (!snap.exists) return null;
      const data = snap.data() as any;
      data.consensusCount += 1;
      if (data.consensusCount >= 5 && data.status === "pending") {
        data.status = "verified";
      }
      await docRef.update({ consensusCount: data.consensusCount, status: data.status });
      return { consensusCount: data.consensusCount, status: data.status };
    } else {
      const { doc, getDoc, updateDoc } = await loadClientSdk();
      const docRef = doc(db, "reports", id);
      const snap = await getDoc(docRef);
      if (!snap.exists()) return null;
      const data = snap.data() as any;
      data.consensusCount += 1;
      if (data.consensusCount >= 5 && data.status === "pending") {
        data.status = "verified";
      }
      await updateDoc(docRef, { consensusCount: data.consensusCount, status: data.status });
      return { consensusCount: data.consensusCount, status: data.status };
    }
  } catch (err) {
    console.error("[Firestore] Failed to confirm report:", err);
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
    console.error("[Firestore] Failed to update report:", err);
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
    console.error("[Firestore] Failed to delete report:", err);
    return false;
  }
}
