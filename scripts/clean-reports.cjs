require("dotenv").config();
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}
const db = getFirestore();

(async () => {
  const snap = await db.collection("reports").get();
  let mine = [];
  snap.forEach((d) => {
    const r = d.data();
    const dev = r.deviceId || "";
    const wil = r.wilaya || "";
    if (dev.startsWith("verify-") || wil.startsWith("wilaya test")) {
      mine.push({ id: d.id, deviceId: dev, wilaya: wil, status: r.status });
    }
  });
  console.log("MINE:", JSON.stringify(mine, null, 1));
})();