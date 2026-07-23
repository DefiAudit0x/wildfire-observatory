
import { collection, query, orderBy, getDocs } from "firebase/firestore";

let memoryNotifications: any[] = [];

export async function getNotificationsFromDb(db: any): Promise<any[]> {
  if (!db) return memoryNotifications;
  try {
    const col = collection(db, "notifications");
    const q = query(col, orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ ...d.data(), id: d.id }));
  } catch (err) {
    return memoryNotifications;
  }
}

// In server.ts
// app.get("/api/notifications/:deviceId", async (req, res) => ...
// app.post("/api/notifications", async (req, res) => ...
// app.post("/api/notifications/:id/read", async (req, res) => ...
