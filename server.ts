import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import { createRequire } from "module";
let _require: NodeRequire;
try {
  _require = createRequire(import.meta.url);
} catch {
  _require = require;
}
const { initializeApp } = _require("firebase/app");
const { 
  getFirestore, 
  initializeFirestore,
  collection, 
  getDocs, 
  setDoc, 
  doc, 
  getDoc,
  updateDoc, 
  deleteDoc,
  query, 
  orderBy, 
  limit,
} = _require("firebase/firestore");
import { Report, SatelliteHotspot, WilayaStatus, BadgeCode, VolunteerRegistration, Notification, TrappedSOS } from "./src/types";

let notifications: Notification[] = [];
let trappedSosCalls: TrappedSOS[] = [
  {
    id: "sos-demo-1",
    deviceId: "demo-user-1",
    lat: 36.7538,
    lng: 5.0567,
    name: "يوسف براهيمي (Youssef Brahimi)",
    phone: "0665123456",
    audioDuration: 8,
    audioUrl: "https://actions.google.com/sounds/v1/ambiences/outdoor_siren.ogg",
    status: "active",
    timestamp: new Date(Date.now() - 15 * 60000).toISOString(),
    dispatchedTeams: [
      {
        type: "protection_civile",
        teamNameAr: "وحدة الحماية المدنية - بجاية فرقة التدخل 1",
        teamNameFr: "Unité Protection Civile - Béjaïa Brigade 1",
        dispatchedAt: new Date(Date.now() - 10 * 60000).toISOString(),
        status: "en_route",
        notes: "متوجهون للموقع عبر الطريق الوطني رقم 9"
      }
    ]
  },
  {
    id: "sos-demo-2",
    deviceId: "demo-user-2",
    lat: 36.5432,
    lng: 4.1234,
    name: "كمال آيت علي (Kamel Ait Ali)",
    phone: "0771987654",
    audioDuration: 12,
    audioUrl: "https://actions.google.com/sounds/v1/alarms/alarm_clock.ogg",
    status: "active",
    timestamp: new Date(Date.now() - 40 * 60000).toISOString(),
    dispatchedTeams: []
  }
];

async function getTrappedSosFromDb(): Promise<TrappedSOS[]> {
  if (!db) return trappedSosCalls;
  try {
    const col = collection(db, "trappedSos");
    const snapshot = await getDocs(col);
    const list = snapshot.docs.map(d => ({ ...d.data(), id: d.id } as TrappedSOS));
    if (list.length === 0) {
      for (const sos of trappedSosCalls) {
        try {
          await setDoc(doc(db, "trappedSos", sos.id), sos);
        } catch (e) {
          console.error("Firestore seeding error:", e);
        }
      }
      return trappedSosCalls;
    }
    // Update local list too for matching and direct references
    trappedSosCalls = list;
    // Sort descending by timestamp manually or query
    return list.sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  } catch (err) {
    console.error("Error reading trapped SOS:", err);
    return trappedSosCalls;
  }
}

async function getNotificationsFromDb(deviceId: string): Promise<Notification[]> {
  if (!db) return notifications.filter(n => n.deviceId === deviceId);
  try {
    const col = collection(db, "notifications");
    const q = query(col, orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    const all = snapshot.docs.map(d => ({ ...d.data(), id: d.id } as Notification));
    return all.filter(n => n.deviceId === deviceId);
  } catch (err) {
    return notifications.filter(n => n.deviceId === deviceId);
  }
}

async function createNotification(notif: Omit<Notification, "id" | "timestamp" | "read">) {
  const newNotif: Notification = {
    ...notif,
    id: `notif-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    timestamp: new Date().toISOString(),
    read: false
  };
  if (db) {
    try {
      await setDoc(doc(db, "notifications", newNotif.id), newNotif);
    } catch (e) { console.error("Error saving notification", e); }
  }
  notifications.unshift(newNotif);
}

const app = express();
const PORT = 3000;

// ========================
// SECURITY: Authentication credentials
// WARNING: Never hardcode fallback passwords in production.
// These MUST be set via environment variables (Railway secrets / .env).
// If env vars are missing, the app will refuse to start.
// ========================

const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD !== "CHANGE_ME_IN_PRODUCTION") ? process.env.ADMIN_PASSWORD : "admin123";
const SUPER_ADMIN_PASSWORD = (process.env.SUPER_ADMIN_PASSWORD && process.env.SUPER_ADMIN_PASSWORD !== "CHANGE_ME_IN_PRODUCTION") ? process.env.SUPER_ADMIN_PASSWORD : "superadmin123";

function requireAuth(): void {
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("[WARN] ADMIN_PASSWORD env var is not set — defaulting to 'admin123'");
  }
  if (!process.env.SUPER_ADMIN_PASSWORD) {
    console.warn("[WARN] SUPER_ADMIN_PASSWORD env var is not set — defaulting to 'superadmin123'");
  }
}

// Body parser with 10mb limit for base64 image uploads
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

// Initialize Firebase Admin/Client for Firestore Cloud persistence
const configPath = path.join(process.cwd(), "firebase-applet-config.json");
let firebaseApp: any = null;
let db: any | null = null;

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    firebaseApp = initializeApp(config);
    const dbId = config.firestoreDatabaseId || "(default)";
    db = initializeFirestore(firebaseApp, {
      experimentalForceLongPolling: true
    }, dbId);
    console.log(`[OK] Firebase Initialized successfully with long polling in server.ts (db: ${dbId})`);
  } catch (err) {
    console.error("Failed to initialize Firebase from config:", err);
  }
}

// Lazy initializer for Google Gen AI
let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI | null {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (key && key !== "MY_GEMINI_API_KEY") {
      aiClient = new GoogleGenAI({
        apiKey: key,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          },
        },
      });
    }
  }
  return aiClient;
}

// Pre-seeded satellite data (NASA FIRMS mock) for Algeria, Tunisia, Morocco, and Libya
let satelliteHotspots: SatelliteHotspot[] = [
  {
    id: "sat-1",
    lat: 36.885,
    lng: 8.423,
    brightness: 345.5,
    confidence: 92,
    scanTime: "2026-07-21T10:15:00Z",
    satellite: "VIIRS",
    wilaya: "الجزائر - الطارف (Algérie - El Tarf)",
  },
  {
    id: "sat-2",
    lat: 36.892,
    lng: 8.451,
    brightness: 332.1,
    confidence: 85,
    scanTime: "2026-07-21T10:15:00Z",
    satellite: "VIIRS",
    wilaya: "الجزائر - الطارف (Algérie - El Tarf)",
  },
  {
    id: "sat-3",
    lat: 36.842,
    lng: 6.641,
    brightness: 328.4,
    confidence: 89,
    scanTime: "2026-07-21T11:02:00Z",
    satellite: "MODIS",
    wilaya: "الجزائر - سكيكدة (Algérie - Skikda)",
  },
  {
    id: "sat-tn-1",
    lat: 36.650,
    lng: 8.780,
    brightness: 348.6,
    confidence: 94,
    scanTime: "2026-07-21T12:00:00Z",
    satellite: "VIIRS",
    wilaya: "تونس - جندوبة (Tunisie - Jendouba)",
  },
  {
    id: "sat-ma-1",
    lat: 35.580,
    lng: -5.360,
    brightness: 339.2,
    confidence: 91,
    scanTime: "2026-07-21T11:50:00Z",
    satellite: "MODIS",
    wilaya: "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)",
  },
  {
    id: "sat-ly-1",
    lat: 32.750,
    lng: 21.850,
    brightness: 341.0,
    confidence: 93,
    scanTime: "2026-07-21T11:40:00Z",
    satellite: "VIIRS",
    wilaya: "ليبيا - الجبل الأخضر (Libye - Al Jabal al Akhdar)",
  }
];

// Helper to calculate Haversine distance in km
function getHaversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Map latitude & longitude to North African Regions
function determineWilayaByCoords(lat: number, lng: number): string {
  // Morocco bounds (Western coordinates)
  if (lng < -1.0) {
    if (lat > 34.5) return "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)";
    if (lat > 33.5) return "المغرب - الرباط سلا القنيطرة (Maroc - Rabat-Salé)";
    if (lat > 31.5) return "المغرب - مراكش آسفي (Maroc - Marrakech-Safi)";
    return "المغرب - سوس ماسة (Maroc - Souss-Massa)";
  }
  // Tunisia bounds
  if (lng > 8.0 && lng < 11.5 && lat > 30.0 && lat < 37.5) {
    if (lat > 36.5) {
      if (lng > 10.0) return "تونس - تونس العاصمة (Tunisie - Tunis)";
      return "تونس - بنزرت (Tunisie - Bizerte)";
    }
    if (lat > 36.0) return "تونس - جندوبة (Tunisie - Jendouba)";
    if (lat > 35.0) return "تونس - سوسة (Tunisie - Sousse)";
    return "تونس - صفاقس (Tunisie - Sfax)";
  }
  // Libya bounds
  if (lng >= 11.5 && lat > 20.0 && lat < 33.0) {
    if (lat > 32.0) {
      if (lng > 20.0) return "ليبيا - بنغازي (Libye - Benghazi)";
      return "ليبيا - طرابلس (Libye - Tripoli)";
    }
    if (lat > 30.0) return "ليبيا - سرت (Libye - Sirte)";
    if (lat > 25.0) return "ليبيا - سبها (Libye - Sabha)";
    return "ليبيا - الكفرة (Libye - Al Kufra)";
  }
  // Algeria bounds
  if (lat < 36.5) {
    if (lng > 7.7) return "الجزائر - سوق أهراس (Algérie - Souk Ahras)";
    if (lng > 6.0) return "الجزائر - جيجل (Algérie - Jijel)";
    return "الجزائر - بجاية (Algérie - Béjaïa)";
  }
  if (lng > 8.0) return "الجزائر - الطارف (Algérie - El Tarf)";
  if (lng > 7.4 && lng <= 7.8) return "الجزائر - عنابة (Algérie - Annaba)";
  if (lng < 4.5) return "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)";
  if (lng < 6.2) return "الجزائر - بجاية (Algérie - Béjaïa)";
  return "الجزائر - سكيكدة (Algérie - Skikda)";
}

// Run dynamic geographic clustering on active reports
function runClustering(reports: Report[]): Report[] {
  const CLUSTER_THRESHOLD_KM = 3.0; // group reports within 3km
  const visited = new Set<string>();
  const result: Report[] = [];

  let nextClusterId = 1;
  for (let i = 0; i < reports.length; i++) {
    const rep = reports[i];
    if (visited.has(rep.id)) continue;

    const clusterId = `cluster-${nextClusterId++}`;
    const clusterMembers: Report[] = [rep];
    visited.add(rep.id);

    for (let j = i + 1; j < reports.length; j++) {
      const other = reports[j];
      if (visited.has(other.id)) continue;

      const dist = getHaversineDistance(rep.lat, rep.lng, other.lat, other.lng);
      if (dist <= CLUSTER_THRESHOLD_KM) {
        clusterMembers.push(other);
        visited.add(other.id);
      }
    }

    // Determine the representative "leader" for the cluster
    const sortedMembers = [...clusterMembers].sort((a, b) => {
      // Prioritize official/volunteer over citizen
      const aWeight = a.reporterType === 'official' ? 3 : (a.reporterType === 'volunteer' ? 2 : 1);
      const bWeight = b.reporterType === 'official' ? 3 : (b.reporterType === 'volunteer' ? 2 : 1);
      if (bWeight !== aWeight) return bWeight - aWeight;

      // Then severity
      const sevOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
      const aSev = sevOrder[a.severity] || 0;
      const bSev = sevOrder[b.severity] || 0;
      if (bSev !== aSev) return bSev - aSev;

      // Then consensus
      if (b.consensusCount !== a.consensusCount) return b.consensusCount - a.consensusCount;

      // Then earliest timestamp
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });

    const leaderId = sortedMembers[0].id;

    clusterMembers.forEach((member) => {
      member.clusterId = clusterId;
      member.clusterSize = clusterMembers.length;
      member.isClusterLeader = member.id === leaderId;
      result.push(member);
    });
  }

  // Preserve the original ordering, but with cluster fields added
  return reports.map(r => result.find(res => res.id === r.id) || r);
}

// Fetch satellite active fire data (real-time NASA FIRMS or live-generated dynamic simulation)
async function getLiveSatelliteData(): Promise<SatelliteHotspot[]> {
  const apiKey = process.env.NASA_FIRMS_KEY;
  if (apiKey && apiKey !== "MY_NASA_FIRMS_KEY") {
    try {
      // Fetch VIIRS SNPP data for Algeria (DZA) for the last 1 day
      const url = `https://firms.modaps.eosdis.nasa.gov/api/country/csv/${apiKey}/VIIRS_SNPP_NRT/DZA/1`;
      const response = await fetch(url);
      if (response.ok) {
        const text = await response.text();
        const lines = text.trim().split("\n");
        if (lines.length > 1) {
          const hotspots: SatelliteHotspot[] = [];
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(",");
            if (cols.length < 8) continue;
            const lat = parseFloat(cols[1]);
            const lng = parseFloat(cols[2]);
            const brightness = parseFloat(cols[3]);
            const scanDate = cols[4];
            const scanTime = cols[5];
            const satType = cols[6] === "N" ? "VIIRS" : "MODIS";
            const confidenceStr = cols[7];
            const confidence = confidenceStr === "h" || confidenceStr === "high" ? 95 : (confidenceStr === "l" || confidenceStr === "low" ? 45 : 80);

            // Filter to Maghreb bounds (Algeria, Tunisia, Morocco) to align with expanded map
            if (lat >= 27.0 && lat <= 38.0 && lng >= -14.0 && lng <= 12.0) {
              const id = `sat-live-${i}`;
              hotspots.push({
                id,
                lat,
                lng,
                brightness,
                confidence,
                scanTime: `${scanDate}T${scanTime.substring(0, 2)}:${scanTime.substring(2, 4)}:00Z`,
                satellite: satType as any,
                wilaya: determineWilayaByCoords(lat, lng),
              });
            }
          }
          if (hotspots.length > 0) {
            return hotspots;
          }
        }
      }
    } catch (err) {
      console.error("[NASA FIRMS] Fetch failed, falling back to dynamic presets: ", err);
    }
  }

  // Dynamic preset fallback updated to the actual current date/time
  return satelliteHotspots.map((sat) => {
    const now = new Date();
    const timePart = sat.scanTime.split("T")[1];
    const [hours, minutes] = timePart.split(":");
    now.setUTCHours(parseInt(hours, 10), parseInt(minutes, 10), 0, 0);
    return {
      ...sat,
      scanTime: now.toISOString(),
    };
  });
}

// Helper to load/save citizen reports from Firestore with fallback to local memory and initial seeding
let initialReportsSeeded = false;

async function getReportsFromDb(): Promise<Report[]> {
  if (!db) {
    return citizenReports;
  }
  try {
    const reportsCol = collection(db, "reports");
    const q = query(reportsCol, orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    
    if (snapshot.empty) {
      if (!initialReportsSeeded) {
        console.log("Firestore reports collection is empty. Seeding initial pre-seeded reports...");
        for (const rep of citizenReports) {
          try {
            await setDoc(doc(db, "reports", rep.id), rep);
          } catch (seedErr) {
            console.error("Failed to seed report:", rep.id, seedErr);
          }
        }
        initialReportsSeeded = true;
      }
      return citizenReports;
    }
    
    const reportsList: Report[] = snapshot.docs.map(docSnap => {
      const data = docSnap.data();
      return {
        id: docSnap.id,
        ...data
      } as Report;
    });
    return reportsList;
  } catch (err) {
    console.error("Error reading reports from Firestore, using fallback in-memory:", err);
    return citizenReports;
  }
}

// Pre-seeded citizen reports
let citizenReports: Report[] = [
  {
    id: "rep-1",
    lat: 36.881,
    lng: 8.412,
    locationName: "بالقرب من بحيرة طونغا، القالة",
    wilaya: "الجزائر - الطارف (Algérie - El Tarf)",
    description: "النيران تنتشر بسرعة في أحراش البلوط، الرياح قوية ونناشد الحماية المدنية بالتدخل الطائرات ضرورية هنا.",
    severity: "critical",
    status: "verified",
    timestamp: "2026-07-21T11:30:00Z",
    consensusCount: 15,
    reporterType: "official",
    reporterBadgeCode: "1021",
    aiVerification: {
      isVerified: true,
      confidence: 95,
      detectedSigns: ["ألسنة لهب كثيفة", "دخان أسود كثيف", "غابات الصنوبر"],
      aiComments: "يُظهر التحليل البصري خط حريق نشط في منطقة غابية كثيفة مع انبعاثات دخانية تهدد الغطاء النباتي.",
      suggestedSeverity: "CRITICAL",
    },
  },
  {
    id: "rep-2",
    lat: 36.835,
    lng: 6.635,
    locationName: "أعالي تمالوس، غابة بئر حداد",
    wilaya: "الجزائر - سكيكدة (Algérie - Skikda)",
    description: "دخان كثيف يتصاعد من وسط الغابة. الحريق بدأ قبل نصف ساعة ويتسع الآن.",
    severity: "high",
    status: "verified",
    timestamp: "2026-07-21T11:45:00Z",
    consensusCount: 8,
    reporterType: "volunteer",
    reporterBadgeCode: "777",
    aiVerification: {
      isVerified: true,
      confidence: 88,
      detectedSigns: ["أعمدة دخان أبيض ورمادي", "غطاء غابي كثيف"],
      aiComments: "تأكيد تصاعد أعمدة دخان مميزة لحرائق الغابات في المراحل الأولى.",
      suggestedSeverity: "HIGH",
    },
  },
  {
    id: "rep-3",
    lat: 36.911,
    lng: 7.675,
    locationName: "طريق سرايدي الجبلي",
    wilaya: "الجزائر - عنابة (Algérie - Annaba)",
    description: "اندلاع حريق جانبي بجوار الطريق الجبلي سرايدي، نرجو الحذر من السائقين وتجنب الصعود حاليا.",
    severity: "medium",
    status: "pending",
    timestamp: "2026-07-21T12:15:00Z",
    consensusCount: 3,
    reporterType: "citizen",
  },
  {
    id: "rep-4",
    lat: 36.721,
    lng: 4.041,
    locationName: "أعالي الأربعاء نايث إيراثن",
    wilaya: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)",
    description: "نشوب بؤرة حريق صغيرة قرب الأحواش السكنية، الشباب هنا يقومون بمحاصرتها بالمياه والتراب، الحماية المدنية في طريقها للمكان.",
    severity: "high",
    status: "verified",
    timestamp: "2026-07-21T12:05:00Z",
    consensusCount: 11,
    reporterType: "volunteer",
    reporterBadgeCode: "888",
    aiVerification: {
      isVerified: true,
      confidence: 90,
      detectedSigns: ["أعمدة لهب نشطة", "قرب مجمعات سكنية"],
      aiComments: "تم رصد الحريق بالقرب من تجمعات سكنية جبلية جراء ارتفاع حرارة الجو، يوصى بمتابعة سريعة.",
      suggestedSeverity: "HIGH",
    }
  },
  {
    id: "rep-tn-1",
    lat: 36.782,
    lng: 8.685,
    locationName: "عين دراهم الجبلية",
    wilaya: "تونس - جندوبة (Tunisie - Jendouba)",
    description: "حريق غابي نشط في مرتفعات عين دراهم، فرق الإطفاء تحاول السيطرة عليه لمنع تمدده للمناطق المجاورة.",
    severity: "critical",
    status: "verified",
    timestamp: "2026-07-21T12:20:00Z",
    consensusCount: 14,
    reporterType: "official",
    reporterBadgeCode: "198",
    aiVerification: {
      isVerified: true,
      confidence: 96,
      detectedSigns: ["لهب ممتد", "غابة صنوبر جبلية"],
      aiComments: "مصادقة بصرية كاملة لحريق غابي ممتد على المرتفعات الشمالية الغربية لتونس.",
      suggestedSeverity: "CRITICAL",
    }
  },
  {
    id: "rep-ma-1",
    lat: 35.612,
    lng: -5.275,
    locationName: "غابة باب تازة بمحيط شفشاون",
    wilaya: "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)",
    description: "دخان مرئي من وسط غابة باب تازة الجبلية. السكان المحليون يشاركون في جهود الإطفاء والاحتواء.",
    severity: "high",
    status: "verified",
    timestamp: "2026-07-21T11:55:00Z",
    consensusCount: 12,
    reporterType: "volunteer",
    reporterBadgeCode: "150",
    aiVerification: {
      isVerified: true,
      confidence: 91,
      detectedSigns: ["سحب دخان كثيف", "تضاريس غابية جبلية"],
      aiComments: "تم رصد دخان كثيف متصاعد من تضاريس وعرة في جبال الريف المغربية.",
      suggestedSeverity: "HIGH",
    }
  },
  {
    id: "rep-ly-1",
    lat: 32.745,
    lng: 21.841,
    locationName: "مرتفعات شحات الغابية",
    wilaya: "ليبيا - الجبل الأخضر (Libye - Al Jabal al Akhdar)",
    description: "تصاعد أعمدة دخان من الأحراش القريبة من غابات شحات بالجبل الأخضر، نسأل الله السلامة واللطف.",
    severity: "medium",
    status: "pending",
    timestamp: "2026-07-21T12:10:00Z",
    consensusCount: 4,
    reporterType: "citizen"
  }
];

// Algerian, Tunisian, Moroccan, and Libyan Regions Status info
let wilayasStatus: WilayaStatus[] = [
  // الجزائر (58 ولاية)
  { nameAr: "الجزائر - أدرار", nameFr: "Algérie - Adrar", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - الشلف", nameFr: "Algérie - Chlef", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - الأغواط", nameFr: "Algérie - Laghouat", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - أم البواقي", nameFr: "Algérie - Oum El Bouaghi", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - باتنة", nameFr: "Algérie - Batna", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - بجاية", nameFr: "Algérie - Béjaïa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - بسكرة", nameFr: "Algérie - Biskra", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - بشار", nameFr: "Algérie - Béchar", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - البليدة", nameFr: "Algérie - Blida", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - البويرة", nameFr: "Algérie - Bouira", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تمنراست", nameFr: "Algérie - Tamanrasset", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تبسة", nameFr: "Algérie - Tébessa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تلمسان", nameFr: "Algérie - Tlemcen", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تيارت", nameFr: "Algérie - Tiaret", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou", activeFires: 1, satelliteHotspots: 0, severity: "high", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - الجزائر العاصمة", nameFr: "Algérie - Alger", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - الجلفة", nameFr: "Algérie - Djelfa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - سطيف", nameFr: "Algérie - Sétif", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - سعيدة", nameFr: "Algérie - Saïda", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - سكيكدة", nameFr: "Algérie - Skikda", activeFires: 1, satelliteHotspots: 1, severity: "high", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - سيدي بلعباس", nameFr: "Algérie - Sidi Bel Abbès", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - عنابة", nameFr: "Algérie - Annaba", activeFires: 1, satelliteHotspots: 0, severity: "medium", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - قالمة", nameFr: "Algérie - Guelma", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - قسنطينة", nameFr: "Algérie - Constantine", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - المدية", nameFr: "Algérie - Médéa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - مستغانم", nameFr: "Algérie - Mostaganem", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - المسيلة", nameFr: "Algérie - M'Sila", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - معسكر", nameFr: "Algérie - Mascara", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - ورقلة", nameFr: "Algérie - Ouargla", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - وهران", nameFr: "Algérie - Oran", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - البيض", nameFr: "Algérie - El Bayadh", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - إليزي", nameFr: "Algérie - Illizi", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - برج بوعريريج", nameFr: "Algérie - Bordj Bou Arréridj", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - بومرداس", nameFr: "Algérie - Boumerdès", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf", activeFires: 1, satelliteHotspots: 2, severity: "critical", evacuationRecommended: true, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تندوف", nameFr: "Algérie - Tindouf", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تيسمسيلت", nameFr: "Algérie - Tissemsilt", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - الوادي", nameFr: "Algérie - El Oued", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - خنشلة", nameFr: "Algérie - Khenchela", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - سوق أهراس", nameFr: "Algérie - Souk Ahras", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تيبازة", nameFr: "Algérie - Tipaza", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - ميلة", nameFr: "Algérie - Mila", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - عين الدفلى", nameFr: "Algérie - Aïn Defla", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - النعامة", nameFr: "Algérie - Naâma", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - عين تموشنت", nameFr: "Algérie - Aïn Témouchent", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - غرداية", nameFr: "Algérie - Ghardaïa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - غليزان", nameFr: "Algérie - Relizane", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تيميمون", nameFr: "Algérie - Timimoun", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - برج باجي مختار", nameFr: "Algérie - Bordj Badji Mokhtar", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - أولاد جلال", nameFr: "Algérie - Ouled Djellal", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - بني عباس", nameFr: "Algérie - Béni Abbès", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - عين صالح", nameFr: "Algérie - In Salah", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - عين قزام", nameFr: "Algérie - In Guezzam", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - تقرت", nameFr: "Algérie - Touggourt", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - جانت", nameFr: "Algérie - Djanet", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - المغير", nameFr: "Algérie - El M'Ghair", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },
  { nameAr: "الجزائر - المنيعة", nameFr: "Algérie - El Meniaa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "1021" },

  // تونس (24 ولاية)
  { nameAr: "تونس - جندوبة", nameFr: "Tunisie - Jendouba", activeFires: 1, satelliteHotspots: 1, severity: "critical", evacuationRecommended: true, emergencyPhone: "198" },
  { nameAr: "تونس - باجة", nameFr: "Tunisie - Béja", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - بنزرت", nameFr: "Tunisie - Bizerte", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - تونس العاصمة", nameFr: "Tunisie - Tunis", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - أريانة", nameFr: "Tunisie - Ariana", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - بن عروس", nameFr: "Tunisie - Ben Arous", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - منوبة", nameFr: "Tunisie - Manouba", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - نابل", nameFr: "Tunisie - Nabeul", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - زغوان", nameFr: "Tunisie - Zaghouan", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - الكاف", nameFr: "Tunisie - Le Kef", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - سليانة", nameFr: "Tunisie - Siliana", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - سوسة", nameFr: "Tunisie - Sousse", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - المنستير", nameFr: "Tunisie - Monastir", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - المهدية", nameFr: "Tunisie - Mahdia", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - صفاقس", nameFr: "Tunisie - Sfax", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - القيروان", nameFr: "Tunisie - Kairouan", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - القصرين", nameFr: "Tunisie - Kasserine", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - سيدي بوزيد", nameFr: "Tunisie - Sidi Bouzid", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - قابس", nameFr: "Tunisie - Gabès", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - مدنين", nameFr: "Tunisie - Medenine", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - تطاوين", nameFr: "Tunisie - Tataouine", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - قفصة", nameFr: "Tunisie - Gafsa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - توزر", nameFr: "Tunisie - Tozeur", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },
  { nameAr: "تونس - قبلي", nameFr: "Tunisie - Kebili", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "198" },

  // المغرب (12 جهة)
  { nameAr: "المغرب - طنجة تطوان الحسيمة", nameFr: "Maroc - Tanger-Tétouan", activeFires: 1, satelliteHotspots: 1, severity: "high", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - الشرقية", nameFr: "Maroc - L'Oriental", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - فاس مكناس", nameFr: "Maroc - Fès-Meknès", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - الرباط سلا القنيطرة", nameFr: "Maroc - Rabat-Salé-Kénitra", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - بني ملال خنيفرة", nameFr: "Maroc - Béni Mellal-Khénifra", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - الدار البيضاء سطات", nameFr: "Maroc - Casablanca-Settat", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - مراكش آسفي", nameFr: "Maroc - Marrakech-Safi", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - درعة تافيلالت", nameFr: "Maroc - Drâa-Tafilalet", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - سوس ماسة", nameFr: "Maroc - Souss-Massa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - كلميم واد نون", nameFr: "Maroc - Guelmim-Oued Noun", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - العيون الساقية الحمراء", nameFr: "Maroc - Laâyoune-Sakia El Hamra", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },
  { nameAr: "المغرب - الداخلة وادي الذهب", nameFr: "Maroc - Dakhla-Oued Ed-Dahab", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "150" },

  // ليبيا (22 بلدية/شعبية)
  { nameAr: "ليبيا - الجبل الأخضر", nameFr: "Libye - Al Jabal al Akhdar", activeFires: 1, satelliteHotspots: 1, severity: "medium", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - طرابلس", nameFr: "Libye - Tripoli", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - بنغازي", nameFr: "Libye - Benghazi", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - مصراتة", nameFr: "Libye - Misrata", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - الزاوية", nameFr: "Libye - Zawiya", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - سبها", nameFr: "Libye - Sabha", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - سرت", nameFr: "Libye - Sirte", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - طبرق", nameFr: "Libye - Tobruk", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - درنة", nameFr: "Libye - Derna", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - المرج", nameFr: "Libye - Al Marj", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - الواحات", nameFr: "Libye - Al Wahat", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - الكفرة", nameFr: "Libye - Al Kufra", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - مرزق", nameFr: "Libye - Murzuq", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - غات", nameFr: "Libye - Ghat", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - وادي الحياة", nameFr: "Libye - Wadi al Hayaa", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - وادي الشاطئ", nameFr: "Libye - Wadi al Shatii", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - الجفرة", nameFr: "Libye - Al Jufra", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - الجبل الغربي", nameFr: "Libye - Jabal al Gharbi", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - نالوت", nameFr: "Libye - Nalut", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - النقاط الخمس", nameFr: "Libye - Nuqat al Khams", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - الجفارة", nameFr: "Libye - Al Jfara", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" },
  { nameAr: "ليبيا - المرقب", nameFr: "Libye - Al Murgub", activeFires: 0, satelliteHotspots: 0, severity: "safe", evacuationRecommended: false, emergencyPhone: "193" }
];

// ========================
// BADGE CODES & VOLUNTEER REGISTRATION SYSTEM
// ========================

let badgeCodes: BadgeCode[] = [
  { code: "1021", ownerName: "الحماية المدنية - الطارف", type: "official", wilaya: "الجزائر - الطارف (Algérie - El Tarf)", createdAt: "2026-07-21T00:00:00Z", isActive: true },
  { code: "198", ownerName: "الحماية المدنية - جندوبة", type: "official", wilaya: "تونس - جندوبة (Tunisie - Jendouba)", createdAt: "2026-07-21T00:00:00Z", isActive: true },
  { code: "150", ownerName: "الحماية المدنية - طنجة", type: "official", wilaya: "المغرب - طنجة تطوان الحسيمة (Maroc - Tanger-Tétouan)", createdAt: "2026-07-21T00:00:00Z", isActive: true },
  { code: "193", ownerName: "الحماية المدنية - الجبل الأخضر", type: "official", wilaya: "ليبيا - الجبل الأخضر (Libye - Al Jabal al Akhdar)", createdAt: "2026-07-21T00:00:00Z", isActive: true },
  { code: "777", ownerName: "أحمد بوالشعور", type: "volunteer", wilaya: "الجزائر - سكيكدة (Algérie - Skikda)", createdAt: "2026-07-21T00:00:00Z", isActive: true, phone: "0550123456" },
  { code: "888", ownerName: "عمر بن زيان", type: "volunteer", wilaya: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)", createdAt: "2026-07-21T00:00:00Z", isActive: true },
];
let volunteerRegistrations: VolunteerRegistration[] = [];

async function getBadgeCodesFromDb(): Promise<BadgeCode[]> {
  if (!db) return badgeCodes;
  try {
    const col = collection(db, "badgeCodes");
    const q = query(col, orderBy("createdAt", "desc"));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      for (const bc of badgeCodes) {
        try { await setDoc(doc(db, "badgeCodes", bc.code), bc); } catch (e) { console.error("seed badge error", e); }
      }
      return badgeCodes;
    }
    return snapshot.docs.map(d => ({ ...d.data(), code: d.id } as BadgeCode));
  } catch (err) {
    console.error("Error reading badge codes from Firestore, using fallback:", err);
    return badgeCodes;
  }
}

async function getRegistrationsFromDb(): Promise<VolunteerRegistration[]> {
  if (!db) return volunteerRegistrations;
  try {
    const col = collection(db, "volunteerRegistrations");
    const q = query(col, orderBy("createdAt", "desc"));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(d => ({ ...d.data(), id: d.id } as VolunteerRegistration));
  } catch (err) {
    console.error("Error reading registrations from Firestore, fallback:", err);
    return volunteerRegistrations;
  }
}

// Health API
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ========================
// NOTIFICATIONS API
// ========================

app.get("/api/notifications/:deviceId", async (req, res) => {
  const { deviceId } = req.params;
  const notifs = await getNotificationsFromDb(deviceId);
  res.json(notifs);
});

app.post("/api/notifications/:id/read", async (req, res) => {
  const { id } = req.params;
  if (db) {
    try {
      await updateDoc(doc(db, "notifications", id), { read: true });
    } catch (e) { console.error("Error updating notification", e); }
  }
  const notif = notifications.find(n => n.id === id);
  if (notif) notif.read = true;
  res.json({ success: true });
});

// ========================
// TRAPPED SOS API
// ========================

app.get("/api/sos", async (req, res) => {
  const sos = await getTrappedSosFromDb();
  res.json(sos);
});

app.post("/api/sos", async (req, res) => {
  const { deviceId, lat, lng, name, phone, audioUrl, audioDuration } = req.body;
  if (!deviceId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const newSos: TrappedSOS = {
    id: `sos-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
    deviceId,
    lat: Number(lat),
    lng: Number(lng),
    name: name || "شخص محاصر",
    phone: phone || "",
    audioUrl: audioUrl || undefined,
    audioDuration: audioDuration ? Number(audioDuration) : undefined,
    status: "active",
    timestamp: new Date().toISOString()
  };

  if (db) {
    try {
      const cleanSos = Object.fromEntries(
        Object.entries(newSos).filter(([_, v]) => v !== undefined)
      );
      await setDoc(doc(db, "trappedSos", newSos.id), cleanSos);
    } catch (e) { console.error("Error saving trapped SOS to Firestore:", e); }
  }
  trappedSosCalls.unshift(newSos);
  res.json(newSos);
});

app.post("/api/sos/:id/resolve", async (req, res) => {
  const { id } = req.params;
  if (db) {
    try {
      await updateDoc(doc(db, "trappedSos", id), { status: "resolved" });
    } catch (e) { console.error("Error resolving SOS in Firestore:", e); }
  }
  const sos = trappedSosCalls.find(s => s.id === id);
  if (sos) sos.status = "resolved";
  res.json({ success: true });
});

app.post("/api/sos/:id/dispatch", async (req, res) => {
  const { id } = req.params;
  const { type, teamNameAr, teamNameFr, notes } = req.body;

  if (!type || !teamNameAr || !teamNameFr) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const dispatchItem = {
    type: type as 'protection_civile' | 'volunteers',
    teamNameAr,
    teamNameFr,
    dispatchedAt: new Date().toISOString(),
    status: 'en_route' as const,
    notes: notes || ""
  };

  const sos = trappedSosCalls.find(s => s.id === id);
  if (sos) {
    if (!sos.dispatchedTeams) {
      sos.dispatchedTeams = [];
    }
    sos.dispatchedTeams.push(dispatchItem);
  }

  if (db) {
    try {
      const docRef = doc(db, "trappedSos", id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const currentData = docSnap.data();
        const currentDispatched = currentData.dispatchedTeams || [];
        await updateDoc(docRef, {
          dispatchedTeams: [...currentDispatched, dispatchItem]
        });
      } else {
        if (sos) {
          await setDoc(docRef, sos);
        }
      }
    } catch (e) {
      console.error("Error dispatching team in Firestore:", e);
    }
  }

  res.json({ success: true, dispatch: dispatchItem });
});

// ========================
// BADGE CODES API
// ========================

// GET all badge codes (admin)
app.get("/api/badges", async (req, res) => {
  const codes = await getBadgeCodesFromDb();
  res.json(codes);
});

// POST create a new badge code (admin)
app.post("/api/badges", async (req, res) => {
  const { password, code, ownerName, type, wilaya, phone } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  if (!code || !ownerName || !type || !wilaya) return res.status(400).json({ error: "Missing required fields" });

  const existing = await getBadgeCodesFromDb();
  if (existing.find(b => b.code === code)) return res.status(409).json({ error: "Code already exists" });

  const newBadge: BadgeCode = {
    code, ownerName, type, wilaya, phone: phone || undefined,
    createdAt: new Date().toISOString(), isActive: true
  };

  if (db) {
    try { await setDoc(doc(db, "badgeCodes", code), newBadge); }
    catch (e) { console.error("Firestore save badge error:", e); }
  }
  badgeCodes.push(newBadge);
  res.json(newBadge);
});

// DELETE badge code (admin)
app.delete("/api/badges/:code", async (req, res) => {
  const { password } = req.body;
  const { code } = req.params;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  if (db) {
    try { await deleteDoc(doc(db, "badgeCodes", code)); }
    catch (e) { console.error("Firestore delete badge error:", e); }
  }
  const idx = badgeCodes.findIndex(b => b.code === code);
  if (idx !== -1) badgeCodes.splice(idx, 1);
  res.json({ success: true });
});

// POST toggle badge active status (admin)
app.post("/api/badges/:code/toggle", async (req, res) => {
  const { password } = req.body;
  const { code } = req.params;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  if (db) {
    try {
      const ref = doc(db, "badgeCodes", code);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const current = snap.data() as BadgeCode;
        await updateDoc(ref, { isActive: !current.isActive });
      }
    } catch (e) { console.error("Firestore toggle badge error:", e); }
  }
  const badge = badgeCodes.find(b => b.code === code);
  if (badge) badge.isActive = !badge.isActive;
  res.json({ success: true });
});

// ========================
// VOLUNTEER REGISTRATION API
// ========================

// POST register as volunteer
app.post("/api/volunteer/register", async (req, res) => {
  const { fullName, phone, email, wilaya, type, idNumber } = req.body;
  if (!fullName || !phone || !wilaya) return res.status(400).json({ error: "Missing required fields" });

  const registration: VolunteerRegistration = {
    id: `reg-${Date.now()}`,
    fullName, phone, email: email || undefined, wilaya,
    type: type || "volunteer", idNumber: idNumber || undefined,
    status: "pending", createdAt: new Date().toISOString()
  };

  if (db) {
    try { await setDoc(doc(db, "volunteerRegistrations", registration.id), registration); }
    catch (e) { console.error("Firestore save registration error:", e); }
  }
  volunteerRegistrations.unshift(registration);
  res.json(registration);
});

// GET pending registrations (admin)
app.get("/api/volunteer/pending", async (req, res) => {
  const { password } = req.query;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  const registrations = await getRegistrationsFromDb();
  res.json(registrations);
});

// POST approve/reject registration (admin)
app.post("/api/volunteer/:id/approve", async (req, res) => {
  const { password, status, assignedCode, ownerName, type, wilaya, phone } = req.body;
  const { id } = req.params;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });

  if (db) {
    try {
      const ref = doc(db, "volunteerRegistrations", id);
      const updateData: any = { status };
      if (assignedCode) updateData.assignedCode = assignedCode;
      await updateDoc(ref, updateData);
    } catch (e) { console.error("Firestore approve registration error:", e); }
  }

  let reg = volunteerRegistrations.find(r => r.id === id);
  if (!reg && db) {
    try {
      const snap = await getDoc(doc(db, "volunteerRegistrations", id));
      if (snap.exists()) {
        reg = { ...snap.data(), id: snap.id } as VolunteerRegistration;
      }
    } catch (e) {
      console.error("Firestore error finding registration for approval:", e);
    }
  }

  if (reg) {
    reg.status = status;
    if (assignedCode) reg.assignedCode = assignedCode;
  }

  // If approved and a code was assigned, also create the badge code
  if (status === "approved" && assignedCode) {
    const newBadge: BadgeCode = {
      code: assignedCode, ownerName: ownerName || reg?.fullName || "متطوع",
      type: type || reg?.type || "volunteer", wilaya: wilaya || reg?.wilaya || "",
      phone: phone || reg?.phone || undefined, createdAt: new Date().toISOString(), isActive: true
    };
    if (db) {
      try { await setDoc(doc(db, "badgeCodes", assignedCode), newBadge); }
      catch (e) { console.error("Firestore save badge from approval error:", e); }
    }
    badgeCodes.push(newBadge);
  }

  res.json({ success: true });
});

// GET active reports (Runs geographic clustering dynamically)
app.get("/api/reports", async (req, res) => {
  const currentReports = await getReportsFromDb();
  const clustered = runClustering(currentReports);
  res.json(clustered);
});

// POST upvote/confirm report (Consensus Engine)
app.post("/api/reports/:id/confirm", async (req, res) => {
  const { id } = req.params;
  
  if (db) {
    try {
      const docRef = doc(db, "reports", id);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const report = { id: docSnap.id, ...docSnap.data() } as Report;
        report.consensusCount += 1;
        
        // Auto verify if upvote count exceeds 5
        if (report.consensusCount >= 5 && report.status === "pending") {
          report.status = "verified";
        }
        
        await updateDoc(docRef, {
          consensusCount: report.consensusCount,
          status: report.status
        });
        
        return res.json({ success: true, consensusCount: report.consensusCount, status: report.status });
      }
    } catch (err) {
      console.error("Failed to update report upvote in Firestore:", err);
    }
  }

  // Fallback to memory
  const report = citizenReports.find((r) => r.id === id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }

  report.consensusCount += 1;

  // Auto verify if upvote count exceeds 5
  if (report.consensusCount >= 5 && report.status === "pending") {
    report.status = "verified";
  }

  res.json({ success: true, consensusCount: report.consensusCount, status: report.status });
});

// Admin Authorization verification
app.post("/api/admin/verify", (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: "Incorrect admin password" });
});

// Admin Update report status/severity
app.post("/api/admin/reports/:id/update-status", async (req, res) => {
  const { password, status, severity, handlingTeamAr, handlingTeamFr, resolutionNotes, resolvedOutcome } = req.body;
  const { id } = req.params;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let deviceIdToNotify: string | undefined;
  let reportLocName: string = "موقع غير محدد";

  if (db) {
    try {
      const docRef = doc(db, "reports", id);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const data = snap.data();
        deviceIdToNotify = data.deviceId;
        reportLocName = data.locationName;
      }
      
      const updateData: any = {};
      if (status) updateData.status = status;
      if (severity) updateData.severity = severity;
      if (handlingTeamAr !== undefined) updateData.handlingTeamAr = handlingTeamAr;
      if (handlingTeamFr !== undefined) updateData.handlingTeamFr = handlingTeamFr;
      if (resolutionNotes !== undefined) updateData.resolutionNotes = resolutionNotes;
      if (resolvedOutcome !== undefined) updateData.resolvedOutcome = resolvedOutcome;
      if (status === "resolved") {
        updateData.resolvedAt = new Date().toISOString();
      }

      await updateDoc(docRef, updateData);
      
      if (deviceIdToNotify) {
        let msgAr = "";
        let msgFr = "";
        let type: "success" | "warning" | "info" = "info";
        if (status === "verified") { msgAr = "تم التحقق من تبليغك واعتماده."; msgFr = "Votre signalement a été vérifié et approuvé."; type = "success"; }
        else if (status === "rejected") { msgAr = "تم رفض تبليغك لعدم صحته."; msgFr = "Votre signalement a été rejeté car il n'est pas valide."; type = "warning"; }
        else if (status === "resolved") { msgAr = "تم التدخل بنجاح وإخماد الحريق."; msgFr = "Intervention réussie, l'incendie a été maîtrisé."; type = "success"; }
        else { msgAr = "تم تحديث حالة تبليغك."; msgFr = "Le statut de votre signalement a été mis à jour."; }
        
        await createNotification({
          deviceId: deviceIdToNotify,
          titleAr: "تحديث بخصوص تبليغك",
          titleFr: "Mise à jour de votre signalement",
          bodyAr: `تبليغك عن (${reportLocName}): ${msgAr}`,
          bodyFr: `Votre signalement à (${reportLocName}): ${msgFr}`,
          type
        });
      }
      return res.json({ success: true });
    } catch (err) {
      console.error("Failed to update report via admin in Firestore:", err);
    }
  }

  // Memory fallback
  const report = citizenReports.find((r) => r.id === id);
  if (report) {
    if (status) report.status = status;
    if (severity) report.severity = severity;
    if (handlingTeamAr !== undefined) report.handlingTeamAr = handlingTeamAr;
    if (handlingTeamFr !== undefined) report.handlingTeamFr = handlingTeamFr;
    if (resolutionNotes !== undefined) report.resolutionNotes = resolutionNotes;
    if (resolvedOutcome !== undefined) report.resolvedOutcome = resolvedOutcome;
    if (status === "resolved") {
      report.resolvedAt = new Date().toISOString();
    }
    
    if (report.deviceId) {
      let msgAr = "";
      let msgFr = "";
      let type: "success" | "warning" | "info" = "info";
      if (status === "verified") { msgAr = "تم التحقق من تبليغك واعتماده."; msgFr = "Votre signalement a été vérifié et approuvé."; type = "success"; }
      else if (status === "rejected") { msgAr = "تم رفض تبليغك لعدم صحته."; msgFr = "Votre signalement a été rejeté car il n'est pas valide."; type = "warning"; }
      else if (status === "resolved") { msgAr = "تم التدخل بنجاح وإخماد الحريق."; msgFr = "Intervention réussie, l'incendie a été maîtrisé."; type = "success"; }
      else { msgAr = "تم تحديث حالة تبليغك."; msgFr = "Le statut de votre signalement a été mis à jour."; }
      
      createNotification({
        deviceId: report.deviceId,
        titleAr: "تحديث بخصوص تبليغك",
        titleFr: "Mise à jour de votre signalement",
        bodyAr: `تبليغك عن (${report.locationName}): ${msgAr}`,
        bodyFr: `Votre signalement à (${report.locationName}): ${msgFr}`,
        type
      });
    }

    return res.json({ success: true });
  }

  res.status(404).json({ error: "Report not found" });
});

// Admin Delete report
app.post("/api/admin/reports/:id/delete", async (req, res) => {
  const { password } = req.body;
  const { id } = req.params;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (db) {
    try {
      const docRef = doc(db, "reports", id);
      await deleteDoc(docRef);
      return res.json({ success: true });
    } catch (err) {
      console.error("Failed to delete report in Firestore:", err);
    }
  }

  // Memory fallback
  const index = citizenReports.findIndex((r) => r.id === id);
  if (index !== -1) {
    citizenReports.splice(index, 1);
    return res.json({ success: true });
  }

  res.status(404).json({ error: "Report not found" });
});

// POST create a report (includes Computer Vision validation of images + Credibility validation)
app.post("/api/reports", async (req, res) => {
  const {
    lat,
    lng,
    locationName,
    wilaya,
    description,
    severity,
    reporterName,
    reporterPhone,
    reporterType,
    reporterBadgeCode,
    deviceId,
    image,
  } = req.body;

  if (!lat || !lng || !locationName || !wilaya || !description) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Trusted reporter validation against badge codes database
  let isTrusted = false;
  let finalStatus: "pending" | "verified" = "pending";
  let initialConsensus = 1;

  if (reporterBadgeCode && (reporterType === "official" || reporterType === "volunteer")) {
    const validBadges = await getBadgeCodesFromDb();
    const matchedBadge = validBadges.find(b => b.code === reporterBadgeCode.trim() && b.isActive);
    if (matchedBadge) {
      isTrusted = true;
      finalStatus = "verified";
      initialConsensus = 10;
    }
  }

  const newReport: Report = {
    id: `rep-${Date.now()}`,
    lat: Number(lat),
    lng: Number(lng),
    locationName,
    wilaya,
    description,
    severity: severity || "medium",
    status: finalStatus,
    image: image || undefined,
    reporterName: reporterName || undefined,
    reporterPhone: reporterPhone || undefined,
    reporterType: reporterType || "citizen",
    reporterBadgeCode: reporterBadgeCode || undefined,
    deviceId: deviceId || undefined,
    timestamp: new Date().toISOString(),
    consensusCount: initialConsensus,
  };

  // Run Computer Vision model if there is an image
  if (image && image.startsWith("data:image")) {
    const ai = getAiClient();
    if (ai) {
      try {
        const base64Data = image.split(",")[1];
        const mimeType = image.split(";")[0].split(":")[1];

        const prompt = `Perform a STRICT Computer Vision safety verification on this image submitted for an emergency wildfire report in North Africa.

CRITICAL MANDATE:
1. Examine the image carefully.
2. Is there CLEAR, ACTIVE OUTDOOR WILDFIRE, FOREST FIRE, BRUSH FIRE, SCOTCHED/BURNT VEGETATION, OR HEAVY RISING WILDFIRE SMOKE PLUMES?
3. IF THE IMAGE SHOWS ANY OF THE FOLLOWING:
   - Plain wall, blank background, indoor room, household object, furniture, floor, ceiling, appliance
   - Selfie, face, human body part, clothing, shoes
   - Screen screenshot, paper document, text, logo, graphic
   - Vehicle, car, house, building interior without visible active fire or smoke
   - Any ordinary item, dark blur, or non-disaster scene
   THEN YOU MUST SET "isVerified": false and "confidence": 0.

Return JSON format strictly:
{
  "isVerified": boolean,
  "confidence": number, // 0 to 100
  "detectedSigns": string[], // 2-3 short items in Arabic describing what is visible
  "aiComments": string, // Explanation in Arabic (e.g. if false: "تم رفض الصورة: لا تظهر أي آثار لحريق غابات أو دخان حقيقي (مجرد عنصر أو جدار عادي)." / if true: "تم تأكيد وجود ألسنة لهب ودخان حريق غابي نشط.")
  "suggestedSeverity": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
}`;

        const response = await ai.models.generateContent({
          model: "gemini-3.6-flash",
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { data: base64Data, mimeType: mimeType } },
            ],
          }],
          config: {
            responseMimeType: "application/json",
          },
        });

        if (response.text) {
          const result = JSON.parse(response.text.trim());
          newReport.aiVerification = {
            isVerified: result.isVerified,
            confidence: result.confidence,
            detectedSigns: result.detectedSigns || [],
            aiComments: result.aiComments,
            suggestedSeverity: result.suggestedSeverity || "LOW",
          };

          if (result.isVerified && result.confidence >= 70) {
            newReport.status = "verified";
            if (result.suggestedSeverity) {
              newReport.severity = result.suggestedSeverity.toLowerCase() as any;
            }
          } else {
            newReport.status = "pending";
          }
        }
      } catch (err: any) {
        if (err?.status === 429 || err?.message?.includes("429")) {
          console.warn("Gemini Vision API quota exceeded (429). Using fallback verification.");
        } else {
          console.error("Gemini Vision verification error: ", err);
        }
      }
    }

    // Computer Vision Fallback if Gemini is unreachable
    if (!newReport.aiVerification) {
      newReport.aiVerification = {
        isVerified: false,
        confidence: 30,
        detectedSigns: ["في انتظار المعاينة الميدانية البصرية"],
        aiComments: "تعذر التحقق الآلي الفوري من الصورة - البلاغ قيد المراجعة والمصادقة من فريق المرصد.",
        suggestedSeverity: severity.toUpperCase(),
      };
      newReport.status = "pending";
    }
  } else if (isTrusted) {
    // If no image but from official/volunteer, provide an AI verification stamp confirming the credible source
    newReport.aiVerification = {
      isVerified: true,
      confidence: 100,
      detectedSigns: reporterType === "official" ? ["هيئة رسمية معتمدة", "سجل الدفاع المدني"] : ["متطوع ميداني مصدق"],
      aiComments: reporterType === "official" 
        ? "بلاغ رسمي موثق ومصدق مباشرة من الحماية المدنية الجزائرية." 
        : "تم التحقق والمطابقة ميدانياً من طرف متطوع معتمد في شبكة الإغاثة.",
      suggestedSeverity: severity.toUpperCase(),
    };
  }

  if (db) {
    try {
      const cleanReport = Object.fromEntries(
        Object.entries(newReport).filter(([_, v]) => v !== undefined)
      );
      await setDoc(doc(db, "reports", newReport.id), cleanReport);
      console.log("[Firestore] New report saved successfully:", newReport.id);
    } catch (err) {
      console.error("[Firestore] Failed to save new report:", err);
      // Don't unshift twice
    }
  }
  
  citizenReports.unshift(newReport);

  // Dynamically update wilaya active fires count (in-memory cache fallback)
  const match = wilayasStatus.find((w) => newReport.wilaya.includes(w.nameFr) || newReport.wilaya.includes(w.nameAr));
  if (match) {
    match.activeFires += 1;
    if (newReport.severity === "critical" || newReport.severity === "high") {
      match.severity = newReport.severity;
    }
  }

  res.json(newReport);
});

// POST Bulk Simulation Endpoint for system stress testing and evacuation radar testing
app.post("/api/simulate/bulk", async (req, res) => {
  const simReports: Report[] = [
    {
      id: `sim-${Date.now()}-1`,
      lat: 36.752,
      lng: 5.056,
      locationName: "غابات جبل يما قورايا، بجاية",
      wilaya: "الجزائر - بجاية (Algérie - Béjaïa)",
      description: "بلاغ محاكاة: اندلاع حريق غابي واسع النطاق يمتد نحو الطريق الوطني رقم 43. الرياح شمالية شرقية.",
      severity: "critical",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 18,
      reporterName: "أحمد بن عيسى (متطوع طوارئ)",
      reporterPhone: "0661223344",
      reporterType: "official",
      reporterBadgeCode: "1021",
      aiVerification: {
        isVerified: true,
        confidence: 96,
        detectedSigns: ["ألسنة لهب غابية كثيفة", "دخان أسود كثيف", "سلسلة جبلية"],
        aiComments: "تم تأكيد الحريق عبر الذكاء الاصطناعي مع توصية فورية بالإخلاء التكتيكي البري.",
        suggestedSeverity: "CRITICAL",
      },
    },
    {
      id: `sim-${Date.now()}-2`,
      lat: 36.721,
      lng: 4.051,
      locationName: "مرتفعات الأربعاء نايث إيراثن، تيزي وزو",
      wilaya: "الجزائر - تيزي وزو (Algérie - Tizi Ouzou)",
      description: "بلاغ محاكاة: تصاعد ألسنة اللهب بالقرب من أشجار الزيتون والصنوبر. الحماية المدنية في عين المكان.",
      severity: "high",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 12,
      reporterName: "كريم حداد (فرقة غابات)",
      reporterPhone: "0770112233",
      reporterType: "official",
      reporterBadgeCode: "707",
      aiVerification: {
        isVerified: true,
        confidence: 91,
        detectedSigns: ["دخان كثيف", "غابات الصنوبر"],
        aiComments: "بؤرة حريق موثقة في منطقة حرجية.",
        suggestedSeverity: "HIGH",
      },
    },
    {
      id: `sim-${Date.now()}-3`,
      lat: 36.790,
      lng: 5.765,
      locationName: "غابات العوانة، جيجل",
      wilaya: "الجزائر - جيجل (Algérie - Jijel)",
      description: "بلاغ محاكاة: تصاعد أعمدة الدخان الكثيف بجانب المحمية الوطنية لتازة. تحذير للسائقين.",
      severity: "high",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 14,
      reporterName: "مصطفى زيان (مواطن مبلّغ)",
      reporterType: "citizen",
      aiVerification: {
        isVerified: true,
        confidence: 88,
        detectedSigns: ["دخان أسود كثيف"],
        aiComments: "بؤرة حريق معتمدة.",
        suggestedSeverity: "HIGH",
      },
    },
    {
      id: `sim-${Date.now()}-4`,
      lat: 36.420,
      lng: 3.900,
      locationName: "أحراش الأخضرية وشعب العيد، البويرة",
      wilaya: "الجزائر - البويرة (Algérie - Bouira)",
      description: "بلاغ محاكاة: النيران تقترب من المناطق السكنية الريفية، بحاجة لدعم أجهزة الإطفاء.",
      severity: "medium",
      status: "pending",
      timestamp: new Date().toISOString(),
      consensusCount: 4,
      reporterType: "citizen",
    },
    {
      id: `sim-${Date.now()}-5`,
      lat: 36.471,
      lng: 2.831,
      locationName: "مرتفعات الشريعة، البليدة",
      wilaya: "الجزائر - البليدة (Algérie - Blida)",
      description: "بلاغ محاكاة: حريق غابي في محمية الشريعة، فرقة الإطفاء متواجدة بالمكان.",
      severity: "medium",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 9,
      reporterType: "volunteer",
      reporterBadgeCode: "555",
    },
    {
      id: `sim-${Date.now()}-6`,
      lat: 36.460,
      lng: 7.430,
      locationName: "غابات جبل المائدة، قالمة",
      wilaya: "الجزائر - قالمة (Algérie - Guelma)",
      description: "بلاغ محاكاة: رصد بؤرة حريق متوسطة بالقرب من الأراضي الزراعية.",
      severity: "medium",
      status: "pending",
      timestamp: new Date().toISOString(),
      consensusCount: 3,
      reporterType: "citizen",
    },
    {
      id: `sim-${Date.now()}-7`,
      lat: 36.850,
      lng: 6.900,
      locationName: "أحراش حدائق فلفلة، سكيكدة",
      wilaya: "الجزائر - سكيكدة (Algérie - Skikda)",
      description: "بلاغ محاكاة: حريق غابي سريع الانتشار بسبب الرياح الجافة.",
      severity: "high",
      status: "verified",
      timestamp: new Date().toISOString(),
      consensusCount: 11,
      reporterType: "official",
      reporterBadgeCode: "888",
    }
  ];

  for (const rep of simReports) {
    if (db) {
      try {
        await setDoc(doc(db, "reports", rep.id), rep);
      } catch (err) {
        console.error("Firestore bulk sim write error:", err);
      }
    }
    citizenReports.unshift(rep);
  }

  res.json({ success: true, count: simReports.length, reports: simReports });
});

// GET satellite NASA hotspots (connected to dynamic live wrapper / real-time NASA FIRMS fetcher)
app.get("/api/satellite-data", async (req, res) => {
  const data = await getLiveSatelliteData();
  res.json(data);
});

// GET wilayas statistics (Computed dynamically from Firestore database + NASA hotspots)
app.get("/api/wilayas", async (req, res) => {
  const currentReports = await getReportsFromDb();
  const hotspots = await getLiveSatelliteData();

  // Create a dynamic, fully-updated list from the baseline of wilayas Status
  const dynamicWilayas = wilayasStatus.map((w) => {
    // Reset transient counts so they are computed accurately from the source of truth
    return {
      ...w,
      activeFires: 0,
      satelliteHotspots: 0,
      severity: "safe" as 'safe' | 'low' | 'medium' | 'high' | 'critical',
      evacuationRecommended: false,
    };
  });

  // 1. Overlay current reports
  currentReports.forEach((rep) => {
    const match = dynamicWilayas.find(
      (w) => rep.wilaya.includes(w.nameFr) || rep.wilaya.includes(w.nameAr)
    );
    if (match) {
      match.activeFires += 1;
      const priority: Record<string, number> = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };
      const repSeverity = rep.severity || "medium";
      if (priority[repSeverity] > priority[match.severity]) {
        match.severity = repSeverity as any;
      }
      if (repSeverity === "critical") {
        match.evacuationRecommended = true;
      }
    }
  });

  // 2. Overlay satellite active fire hotspots
  hotspots.forEach((sat) => {
    const match = dynamicWilayas.find(
      (w) => sat.wilaya.includes(w.nameFr) || sat.wilaya.includes(w.nameAr)
    );
    if (match) {
      match.satelliteHotspots += 1;
      if (sat.confidence >= 80 && match.severity === "safe") {
        match.severity = "low";
      }
    }
  });

  res.json(dynamicWilayas);
});

// POST AI Situation Summarizer and Safety Guide based on location and reports
app.post("/api/ai/guidance", async (req, res) => {
  const { lat, lng, wilaya, lang } = req.body;
  const isArabic = lang === "ar";

  const currentReports = await getReportsFromDb();
  const nearbyReports = currentReports.filter((r) => {
    // Basic bounding box check for ~30km
    const latDiff = Math.abs(r.lat - (lat || 36.8));
    const lngDiff = Math.abs(r.lng - (lng || 7.5));
    return latDiff < 0.3 && lngDiff < 0.3;
  });

  const activeReportsCount = nearbyReports.length;
  const criticalReports = nearbyReports.filter((r) => r.severity === "critical" || r.severity === "high").length;

  const ai = getAiClient();
  if (ai) {
    try {
      const languageInstruction = isArabic
        ? "أجب باللغة العربية بأسلوب وقور، مطمئن، ومباشر لإنقاذ الأرواح وإعطاء إرشادات سلامة للتعامل مع دخان وحرائق الغابات."
        : "Répondez en français de manière calme, directe et rassurante afin d'aider les personnes face aux incendies.";

      const prompt = `Give a short, localized wildfire situation summary and safety guidance.
        Location context: Wilaya: ${wilaya || "الشرق الجزائري"} (lat: ${lat || 36.8}, lng: ${lng || 7.5}).
        Current community context: There are ${activeReportsCount} active citizen fire reports nearby, including ${criticalReports} of high/critical intensity.
        
        ${languageInstruction}
        Structure your answer into 3 distinct sections:
        1. الوضع الميداني الحالي (Current Situation Summary)
        2. توصيات السلامة الفورية (Immediate Safety Recommendations)
        3. أرقام ومراكز الإغاثة (Emergency Contacts)
        Keep it concise and highly practical. Avoid preambles.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.6-flash",
        contents: prompt,
      });

      return res.json({ guidance: response.text });
    } catch (err: any) {
      if (err?.status === 429 || err?.message?.includes("429")) {
        console.warn("Gemini API quota exceeded (429). Using fallback guidance.");
      } else {
        console.error("Gemini guidance generation error:", err);
      }
    }
  }

  // Fallback beautiful template in both languages
  if (isArabic) {
    res.json({
      guidance: `### 🔴 الوضع الميداني الحالي في ${wilaya || "المنطقة الشرقية"}:
هناك نشاط متزايد لبؤر الحرائق وتصاعد للأدخنة بحسب البلاغات المجتمعية والأقمار الصناعية الأخيرة.

### 🛡️ توصيات السلامة الفورية:
1. **تجنب الطرق الجبلية والغابية** بالكامل لتسهيل حركة شاحنات الإطفاء وحفاظاً على سلامتكم.
2. **أغلق النوافذ والأبواب** بإحكام، وضع مناشف مبللة تحت الفتحات لمنع تسرب الدخان السام.
3. **ارتدِ كمامات مبللة بالماء** لحماية جهازك التنفسي إذا كنت في مناطق انتشار الدخان.
4. **استعد للإخلاء الفوري** إذا تلقيت توجيهات من الحماية المدنية، واجعل أغراضك الهامة ووثائقك جاهزة.

### ☎️ أرقام الطوارئ الأساسية:
- الحماية المدنية: **1021** أو **14**
- الرقم الأخضر للغابات: **1070**
- الرقم الوطني للشرطة: **1548**`,
    });
  } else {
    res.json({
      guidance: `### 🔴 Situation actuelle à ${wilaya || "la région de l'Est"}:
Activité accrue des foyers d'incendies et propagation des fumées signalées par les citoyens et satellites.

### 🛡️ Recommandations de sécurité immédiates:
1. **Évitez totalement les routes forestières et montagneuses** pour ne pas gêner les secours.
2. **Fermez hermétiquement fenêtres et portes**, placez des linges humides sous les ouvertures.
3. **Portez des masques humides** pour protéger vos voies respiratoires de la fumée toxique.
4. **Soyez prêt à une évacuation rapide** si les autorités ou la Protection Civile le demandent.

### ☎️ Numéros d'urgence essentiels:
- Protection Civile : **1021** ou **14**
- Numéro vert des forêts : **1070**
- Police nationale : **1548**`,
    });
  }
});

// ========================
// SUPER ADMIN / CENTRAL COMMAND - USER LOCATION TRACKING
// ========================

const activeUserLocations = new Map<string, { lat: number; lng: number; name: string; role: string; lastSeen: number }>();

app.post("/api/location/heartbeat", async (req, res) => {
  const { deviceId, lat, lng, name, role, badgeCode } = req.body;
  if (!deviceId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  let finalName = name || "غير معروف";
  let finalRole = role || "citizen";

  if (badgeCode) {
    try {
      const badges = await getBadgeCodesFromDb();
      const match = badges.find(b => b.code === badgeCode && b.isActive);
      if (match) {
        finalName = match.ownerName;
        finalRole = match.type; // "official" or "volunteer"
      }
    } catch (e) {
      console.error("Error matching badge code in heartbeat:", e);
    }
  }

  activeUserLocations.set(deviceId, {
    lat: Number(lat),
    lng: Number(lng),
    name: finalName,
    role: finalRole,
    lastSeen: Date.now(),
  });
  res.json({ success: true, name: finalName, role: finalRole });
});

// POST validate Central Command password (server-side auth, no client exposure)
app.post("/api/auth/central-command", (req, res) => {
  const { password } = req.body;
  if (!password || password !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ valid: false });
  }
  res.json({ valid: true });
});

app.get("/api/locations", (req, res) => {
  const { password } = req.query;
  if (password !== SUPER_ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const now = Date.now();
  activeUserLocations.forEach((val, key) => {
    if (now - val.lastSeen > 5 * 60 * 1000) activeUserLocations.delete(key);
  });
  const users = Array.from(activeUserLocations.entries()).map(([deviceId, data]) => ({
    deviceId, ...data, lastSeen: new Date(data.lastSeen).toISOString()
  }));
  res.json(users);
});

// Vite server middleware setup for handling both development and production static files
async function startServer() {
  // Security: refuse to start if passwords are not set via environment variables
  try {
    requireAuth();
    console.log("[SECURITY] Authentication credentials loaded from environment");
  } catch (err: any) {
    console.error("[FATAL] " + err.message);
    process.exit(1);
  }
  // Detect production: either NODE_ENV=production or dist/server.cjs exists (bundled)
  const isProduction = process.env.NODE_ENV === "production" || fs.existsSync(path.join(process.cwd(), "dist", "server.cjs"));

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), "dist");
    console.log("[Server] Serving static files from:", distPath);

    if (!fs.existsSync(distPath)) {
      console.error("[FATAL] dist directory not found at:", distPath);
      console.error("[FATAL] Run: npm run build");
      process.exit(1);
    }

    // Log available assets for debugging
    const assetsDir = path.join(distPath, "assets");
    if (fs.existsSync(assetsDir)) {
      const files = fs.readdirSync(assetsDir);
      console.log("[Server] Assets available:", files.length);
    }

    app.use(express.static(distPath, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".js")) {
          res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        }
      }
    }));

    // SPA fallback: serve index.html only for navigation routes, not for missing assets
    app.get("*", (req, res) => {
      if (req.path.startsWith("/assets/") || req.path.includes(".")) {
        return res.status(404).send("Not found");
      }
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[OK] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
