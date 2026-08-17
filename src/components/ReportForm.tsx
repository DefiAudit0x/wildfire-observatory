import { useState, useRef, useEffect } from "react";
import { Camera, MapPin, Loader2, Upload, AlertTriangle, CheckCircle } from "lucide-react";
import { haversineKm, determineWilayaByCoords, OUT_OF_COVERAGE } from "../utils/geo";
import { geoErrorMessage } from "../hooks/useGeolocation";
import { setReporterBadge } from "../utils/badgeStore";
import { isFreshThreatTimestamp } from "../utils/threats";
import { loadOfflineDrafts, replaceOfflineDrafts } from "../utils/offlineDraftStore";
import type { SyncState } from "../utils/datasetHealth";

interface SubmissionResultView {
  responseValid: boolean;
  isOfflineDraft?: boolean;
  imageNotAttached?: boolean;
  status?: "pending" | "verified";
  id?: string;
  error?: string;
  message?: string;
  aiVerification?: {
    confidence?: number;
    aiComments?: string;
    detectedSigns?: string[];
    isVerified?: boolean;
    suggestedSeverity?: string;
  };
}

export function toUserFacingSubmitError(message: string | undefined, isArabic: boolean): string {
  const normalized = message?.toLowerCase() || "";
  if (normalized.includes("durable idempotency") || normalized.includes("durable_idempotency") || normalized.includes("admin firestore")) {
    return isArabic
      ? "تعذر إرسال البلاغ الآن لأن خادم المرصد غير جاهز. بقيت بياناتك في النموذج؛ حاول مجددًا عند توفر الخدمة."
      : "Le serveur de l'observatoire n'est pas prêt. Vos données restent dans le formulaire ; réessayez lorsque le service sera disponible.";
  }
  return message || (isArabic ? "عذراً، فشل إرسال البلاغ الميداني." : "Échec de l'envoi du signalement.");
}

export function normalizeSubmissionResult(value: unknown): SubmissionResultView {
  if (!value || typeof value !== "object") {
    return { responseValid: false, error: "The server returned an invalid response." };
  }
  const raw = value as Record<string, unknown>;
  const status = raw.status === "pending" || raw.status === "verified" ? raw.status : undefined;
  const id = typeof raw.id === "string" && raw.id.trim().length >= 3 ? raw.id.trim() : undefined;
  const ai = raw.aiVerification && typeof raw.aiVerification === "object"
    ? raw.aiVerification as Record<string, unknown>
    : null;
  const confidence = ai && Number.isFinite(Number(ai.confidence))
    ? Math.max(0, Math.min(100, Number(ai.confidence)))
    : undefined;
  const detectedSigns = ai && Array.isArray(ai.detectedSigns)
    ? ai.detectedSigns.filter((sign): sign is string => typeof sign === "string").slice(0, 20)
    : undefined;
  const aiVerification = ai && (confidence !== undefined || typeof ai.aiComments === "string" || detectedSigns?.length)
    ? {
      confidence,
      aiComments: typeof ai.aiComments === "string" ? ai.aiComments.slice(0, 1000) : undefined,
      detectedSigns,
      isVerified: ai.isVerified === true,
      suggestedSeverity: typeof ai.suggestedSeverity === "string" ? ai.suggestedSeverity : undefined,
    }
    : undefined;
  const serverAccepted = raw.responseValid === true && Boolean(id && status);
  const offlineAccepted = raw.responseValid === true && raw.isOfflineDraft === true;
  const responseValid = serverAccepted || offlineAccepted;
  return {
    responseValid,
    isOfflineDraft: raw.isOfflineDraft === true,
    imageNotAttached: raw.imageNotAttached === true,
    status,
    id,
    error: typeof raw.error === "string" ? raw.error.slice(0, 500) : undefined,
    message: typeof raw.message === "string" ? raw.message.slice(0, 500) : undefined,
    aiVerification,
  };
}

interface ReportFormProps {
  mapClickedCoords: { lat: number; lng: number } | null;
  onSubmit: (data: any) => Promise<any>;
  lang: "ar" | "fr";
  reports?: any[];
  /** Live wilaya list from the observatory API (single source of truth).
      Falls back to the static list below until the API responds. */
  wilayas?: { nameAr: string; nameFr: string }[];
  syncState?: SyncState;
}

const FALLBACK_WILAYAS = [
  // الجزائر (58 ولاية)
  { nameAr: "الجزائر - أدرار", nameFr: "Algérie - Adrar" },
  { nameAr: "الجزائر - الشلف", nameFr: "Algérie - Chlef" },
  { nameAr: "الجزائر - الأغواط", nameFr: "Algérie - Laghouat" },
  { nameAr: "الجزائر - أم البواقي", nameFr: "Algérie - Oum El Bouaghi" },
  { nameAr: "الجزائر - باتنة", nameFr: "Algérie - Batna" },
  { nameAr: "الجزائر - بجاية", nameFr: "Algérie - Béjaïa" },
  { nameAr: "الجزائر - بسكرة", nameFr: "Algérie - Biskra" },
  { nameAr: "الجزائر - بشار", nameFr: "Algérie - Béchar" },
  { nameAr: "الجزائر - البليدة", nameFr: "Algérie - Blida" },
  { nameAr: "الجزائر - البويرة", nameFr: "Algérie - Bouira" },
  { nameAr: "الجزائر - تمنراست", nameFr: "Algérie - Tamanrasset" },
  { nameAr: "الجزائر - تبسة", nameFr: "Algérie - Tébessa" },
  { nameAr: "الجزائر - تلمسان", nameFr: "Algérie - Tlemcen" },
  { nameAr: "الجزائر - تيارت", nameFr: "Algérie - Tiaret" },
  { nameAr: "الجزائر - تيزي وزو", nameFr: "Algérie - Tizi Ouzou" },
  { nameAr: "الجزائر - الجزائر العاصمة", nameFr: "Algérie - Alger" },
  { nameAr: "الجزائر - الجلفة", nameFr: "Algérie - Djelfa" },
  { nameAr: "الجزائر - جيجل", nameFr: "Algérie - Jijel" },
  { nameAr: "الجزائر - سطيف", nameFr: "Algérie - Sétif" },
  { nameAr: "الجزائر - سعيدة", nameFr: "Algérie - Saïda" },
  { nameAr: "الجزائر - سكيكدة", nameFr: "Algérie - Skikda" },
  { nameAr: "الجزائر - سيدي بلعباس", nameFr: "Algérie - Sidi Bel Abbès" },
  { nameAr: "الجزائر - عنابة", nameFr: "Algérie - Annaba" },
  { nameAr: "الجزائر - قالمة", nameFr: "Algérie - Guelma" },
  { nameAr: "الجزائر - قسنطينة", nameFr: "Algérie - Constantine" },
  { nameAr: "الجزائر - المدية", nameFr: "Algérie - Médéa" },
  { nameAr: "الجزائر - مستغانم", nameFr: "Algérie - Mostaganem" },
  { nameAr: "الجزائر - المسيلة", nameFr: "Algérie - M'Sila" },
  { nameAr: "الجزائر - معسكر", nameFr: "Algérie - Mascara" },
  { nameAr: "الجزائر - ورقلة", nameFr: "Algérie - Ouargla" },
  { nameAr: "الجزائر - وهران", nameFr: "Algérie - Oran" },
  { nameAr: "الجزائر - البيض", nameFr: "Algérie - El Bayadh" },
  { nameAr: "الجزائر - إليزي", nameFr: "Algérie - Illizi" },
  { nameAr: "الجزائر - برج بوعريريج", nameFr: "Algérie - Bordj Bou Arréridj" },
  { nameAr: "الجزائر - بومرداس", nameFr: "Algérie - Boumerdès" },
  { nameAr: "الجزائر - الطارف", nameFr: "Algérie - El Tarf" },
  { nameAr: "الجزائر - تندوف", nameFr: "Algérie - Tindouf" },
  { nameAr: "الجزائر - تيسمسيلت", nameFr: "Algérie - Tissemsilt" },
  { nameAr: "الجزائر - الوادي", nameFr: "Algérie - El Oued" },
  { nameAr: "الجزائر - خنشلة", nameFr: "Algérie - Khenchela" },
  { nameAr: "الجزائر - سوق أهراس", nameFr: "Algérie - Souk Ahras" },
  { nameAr: "الجزائر - تيبازة", nameFr: "Algérie - Tipaza" },
  { nameAr: "الجزائر - ميلة", nameFr: "Algérie - Mila" },
  { nameAr: "الجزائر - عين الدفلى", nameFr: "Algérie - Aïn Defla" },
  { nameAr: "الجزائر - النعامة", nameFr: "Algérie - Naâma" },
  { nameAr: "الجزائر - عين تموشنت", nameFr: "Algérie - Aïn Témouchent" },
  { nameAr: "الجزائر - غرداية", nameFr: "Algérie - Ghardaïa" },
  { nameAr: "الجزائر - غليزان", nameFr: "Algérie - Relizane" },
  { nameAr: "الجزائر - تيميمون", nameFr: "Algérie - Timimoun" },
  { nameAr: "الجزائر - برج باجي مختار", nameFr: "Algérie - Bordj Badji Mokhtar" },
  { nameAr: "الجزائر - أولاد جلال", nameFr: "Algérie - Ouled Djellal" },
  { nameAr: "الجزائر - بني عباس", nameFr: "Algérie - Béni Abbès" },
  { nameAr: "الجزائر - عين صالح", nameFr: "Algérie - In Salah" },
  { nameAr: "الجزائر - عين قزام", nameFr: "Algérie - In Guezzam" },
  { nameAr: "الجزائر - تقرت", nameFr: "Algérie - Touggourt" },
  { nameAr: "الجزائر - جانت", nameFr: "Algérie - Djanet" },
  { nameAr: "الجزائر - المغير", nameFr: "Algérie - El M'Ghair" },
  { nameAr: "الجزائر - المنيعة", nameFr: "Algérie - El Meniaa" },

  // تونس (24 ولاية)
  { nameAr: "تونس - تونس العاصمة", nameFr: "Tunisie - Tunis" },
  { nameAr: "تونس - أريانة", nameFr: "Tunisie - Ariana" },
  { nameAr: "تونس - بن عروس", nameFr: "Tunisie - Ben Arous" },
  { nameAr: "تونس - منوبة", nameFr: "Tunisie - Manouba" },
  { nameAr: "تونس - نابل", nameFr: "Tunisie - Nabeul" },
  { nameAr: "تونس - زغوان", nameFr: "Tunisie - Zaghouan" },
  { nameAr: "تونس - بنزرت", nameFr: "Tunisie - Bizerte" },
  { nameAr: "تونس - باجة", nameFr: "Tunisie - Béja" },
  { nameAr: "تونس - جندوبة", nameFr: "Tunisie - Jendouba" },
  { nameAr: "تونس - الكاف", nameFr: "Tunisie - Le Kef" },
  { nameAr: "تونس - سليانة", nameFr: "Tunisie - Siliana" },
  { nameAr: "تونس - سوسة", nameFr: "Tunisie - Sousse" },
  { nameAr: "تونس - المنستير", nameFr: "Tunisie - Monastir" },
  { nameAr: "تونس - المهدية", nameFr: "Tunisie - Mahdia" },
  { nameAr: "تونس - صفاقس", nameFr: "Tunisie - Sfax" },
  { nameAr: "تونس - القيروان", nameFr: "Tunisie - Kairouan" },
  { nameAr: "تونس - القصرين", nameFr: "Tunisie - Kasserine" },
  { nameAr: "تونس - سيدي بوزيد", nameFr: "Tunisie - Sidi Bouzid" },
  { nameAr: "تونس - قابس", nameFr: "Tunisie - Gabès" },
  { nameAr: "تونس - مدنين", nameFr: "Tunisie - Medenine" },
  { nameAr: "تونس - تطاوين", nameFr: "Tunisie - Tataouine" },
  { nameAr: "تونس - قفصة", nameFr: "Tunisie - Gafsa" },
  { nameAr: "تونس - توزر", nameFr: "Tunisie - Tozeur" },
  { nameAr: "تونس - قبلي", nameFr: "Tunisie - Kebili" },

  // المغرب (12 جهة)
  { nameAr: "المغرب - طنجة تطوان الحسيمة", nameFr: "Maroc - Tanger-Tétouan-Al Hoceïma" },
  { nameAr: "المغرب - الشرقية", nameFr: "Maroc - L'Oriental" },
  { nameAr: "المغرب - فاس مكناس", nameFr: "Maroc - Fès-Meknès" },
  { nameAr: "المغرب - الرباط سلا القنيطرة", nameFr: "Maroc - Rabat-Salé-Kénitra" },
  { nameAr: "المغرب - بني ملال خنيفرة", nameFr: "Maroc - Béni Mellal-Khénifra" },
  { nameAr: "المغرب - الدار البيضاء سطات", nameFr: "Maroc - Casablanca-Settat" },
  { nameAr: "المغرب - مراكش آسفي", nameFr: "Maroc - Marrakech-Safi" },
  { nameAr: "المغرب - درعة تافيلالت", nameFr: "Maroc - Drâa-Tafilalet" },
  { nameAr: "المغرب - سوس ماسة", nameFr: "Maroc - Souss-Massa" },
  { nameAr: "المغرب - كلميم واد نون", nameFr: "Maroc - Guelmim-Oued Noun" },
  { nameAr: "المغرب - العيون الساقية الحمراء", nameFr: "Maroc - Laâyoune-Sakia El Hamra" },
  { nameAr: "المغرب - الداخلة وادي الذهب", nameFr: "Maroc - Dakhla-Oued Ed-Dahab" },

  // ليبيا (22 بلدية/شعبية)
  { nameAr: "ليبيا - طرابلس", nameFr: "Libye - Tripoli" },
  { nameAr: "ليبيا - بنغازي", nameFr: "Libye - Benghazi" },
  { nameAr: "ليبيا - مصراتة", nameFr: "Libye - Misrata" },
  { nameAr: "ليبيا - الزاوية", nameFr: "Libye - Zawiya" },
  { nameAr: "ليبيا - سبها", nameFr: "Libye - Sabha" },
  { nameAr: "ليبيا - سرت", nameFr: "Libye - Sirte" },
  { nameAr: "ليبيا - طبرق", nameFr: "Libye - Tobruk" },
  { nameAr: "ليبيا - درنة", nameFr: "Libye - Derna" },
  { nameAr: "ليبيا - الجبل الأخضر", nameFr: "Libye - Al Jabal al Akhdar" },
  { nameAr: "ليبيا - المرج", nameFr: "Libye - Al Marj" },
  { nameAr: "ليبيا - الواحات", nameFr: "Libye - Al Wahat" },
  { nameAr: "ليبيا - الكفرة", nameFr: "Libye - Al Kufra" },
  { nameAr: "ليبيا - مرزق", nameFr: "Libye - Murzuq" },
  { nameAr: "ليبيا - غات", nameFr: "Libye - Ghat" },
  { nameAr: "ليبيا - وادي الحياة", nameFr: "Libye - Wadi al Hayaa" },
  { nameAr: "ليبيا - وادي الشاطئ", nameFr: "Libye - Wadi al Shatii" },
  { nameAr: "ليبيا - الجفرة", nameFr: "Libye - Al Jufra" },
  { nameAr: "ليبيا - الجبل الغربي", nameFr: "Libye - Jabal al Gharbi" },
  { nameAr: "ليبيا - نالوت", nameFr: "Libye - Nalut" },
  { nameAr: "ليبيا - النقاط الخمس", nameFr: "Libye - Nuqat al Khams" },
  { nameAr: "ليبيا - الجفارة", nameFr: "Libye - Al Jfara" },
  { nameAr: "ليبيا - المرقب", nameFr: "Libye - Al Murgub" }
];

export default function ReportForm({ mapClickedCoords, onSubmit, lang, reports = [], wilayas, syncState = "never" }: ReportFormProps) {
  // The server owns the wilaya geofence; the static copy only covers the
  // first-load/offline window before the API list arrives.
  const wilayaOptions = wilayas && wilayas.length > 0 ? wilayas : FALLBACK_WILAYAS;
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [locationName, setLocationName] = useState("");
  const [wilaya, setWilaya] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [description, setDescription] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterPhone, setReporterPhone] = useState("");
  const [reporterType, setReporterType] = useState("citizen");
  const [reporterBadgeCode, setReporterBadgeCode] = useState("");
  
  // Image attachments and compression states
  const [image, setImage] = useState<string | null>(null);
  const [originalSize, setOriginalSize] = useState<string | null>(null);
  const [compressedSize, setCompressedSize] = useState<string | null>(null);
  const [isCompressing, setIsCompressing] = useState(false);
  
  // Submission states
  const [isLocating, setIsLocating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [successReport, setSuccessReport] = useState<any | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Compass & Camera states
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<"closed" | "active" | "unavailable">("closed");
  const [stream, setStream] = useState<MediaStream | null>(null);
  // Sensor values are null until a real sensor delivers them — the form never
  // fabricates a heading/pitch (no fake compass numbers stamped on photos).
  const [heading, setHeading] = useState<number | null>(null); // 0-360 degrees (compass bearing)
  const [pitch, setPitch] = useState<number | null>(null); // -90 to 90 degrees (elevation angle)
  const [headingSource, setHeadingSource] = useState<"sensor" | "manual" | "none">("none");
  const [pitchSource, setPitchSource] = useState<"sensor" | "manual" | "none">("none");
  const [matchedReport, setMatchedReport] = useState<any | null>(null);
  const [alignmentAccuracy, setAlignmentAccuracy] = useState<number | null>(null);
  const [showCalibrationGuide, setShowCalibrationGuide] = useState(false);

  // --- NEW ENHANCED STATES FOR SYSTEM ROBUSTNESS ---
  const [gpsMode, setGpsMode] = useState<"adaptive" | "continuous">("adaptive");
  const allowOfflineSimulation = import.meta.env.DEV;
  const [isOffline, setIsOffline] = useState(() => typeof navigator !== "undefined" && !navigator.onLine);
  const [isOfflineSimulation, setIsOfflineSimulation] = useState(false);
  const [offlineDrafts, setOfflineDrafts] = useState<any[]>([]);
  const [edgeAiStatus, setEdgeAiStatus] = useState<{
    success: boolean;
    confidence: number;
    messageAr: string;
    messageFr: string;
  } | null>(null);
  const [syncStatusMsg, setSyncStatusMsg] = useState<string | null>(null);
  const [includeTelemetry, setIncludeTelemetry] = useState(true);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [wilayaNote, setWilayaNote] = useState<{
    kind: "suggest" | "mismatch" | "outside";
    option?: string;
    textAr: string;
    textFr: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const syncingDrafts = useRef(false);
  const submittingRef = useRef(false);
  const isArabic = lang === "ar";

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
    const handleMeshOnline = () => setIsOffline(false);
    window.addEventListener("mesh:online", handleMeshOnline);
    return () => {
      window.removeEventListener("mesh:online", handleMeshOnline);
    };
  }, []);

  // Sync clicked coordinates from the parent map component
  useEffect(() => {
    if (mapClickedCoords) {
      setLat(mapClickedCoords.lat.toFixed(6));
      setLng(mapClickedCoords.lng.toFixed(6));
    }
  }, [mapClickedCoords]);

  // Bind the selected region to the coordinates (mirror of the server's
  // geofence): suggest the wilaya on GPS fix, warn on country mismatch so the
  // submission is not silently rejected by the server after the fact.
  useEffect(() => {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      setWilayaNote(null);
      return;
    }
    const resolved = determineWilayaByCoords(parsedLat, parsedLng);
    if (resolved === OUT_OF_COVERAGE) {
      if (wilaya) {
        setWilayaNote({
          kind: "outside",
          textAr: "⚠️ الإحداثيات خارج تغطية المنصة — سيرفض الخادم البلاغ.",
          textFr: "⚠️ Coordonnées hors couverture — le serveur rejettera le rapport.",
        });
      } else {
        setWilayaNote(null);
      }
      return;
    }
    const resolvedOption = wilayaOptions.find((w) => `${w.nameAr} (${w.nameFr})` === resolved);
    if (!wilaya && resolvedOption) {
      // The geofence result is authoritative for this coordinate. Selecting it
      // here prevents a visible suggestion from remaining an unsubmitted form
      // value while keeping the user free to choose another matching option.
      setWilaya(`${resolvedOption.nameAr} (${resolvedOption.nameFr})`);
      setWilayaNote({
        kind: "suggest",
        option: `${resolvedOption.nameAr} (${resolvedOption.nameFr})`,
        textAr: `تم اعتماد الولاية تلقائيًا حسب الإحداثيات: ${resolvedOption.nameAr}`,
        textFr: `Wilaya automatiquement confirmée par les coordonnées : ${resolvedOption.nameFr}`,
      });
      return;
    }
    if (wilaya) {
      const selectedCountry = wilaya.split(" - ")[0];
      if (selectedCountry && selectedCountry !== resolved.split(" - ")[0]) {
        setWilayaNote({
          kind: "mismatch",
          textAr: `⚠️ إحداثياتك تقع في «${resolved.split(" (")[0]}» بينما اخترت ولاية مختلفة — سيرفض الخادم البلاغ ما لم تصحّح الاختيار.`,
          textFr: `⚠️ Vos coordonnées sont dans «${resolved.split(" (")[0]}» mais vous avez choisi une autre wilaya — le serveur rejettera le rapport.`,
        });
        return;
      }
    }
    setWilayaNote(null);
  }, [lat, lng, wilaya, wilayaOptions]);

  // Wilaya reconciliation (audit): while the fallback list is live the user
  // may pick a fallback option that does not exist in the server's
  // authoritative list. When the real list arrives (wilayaOptions identity
  // swap), a stale selection is cleared WITH its derived note — the form can
  // never submit a value the server cannot geofence; the user picks again
  // from the authoritative options.
  useEffect(() => {
    if (!wilayas || wilayas.length === 0 || !wilaya) return;
    if (!wilayaOptions.some((w) => `${w.nameAr} (${w.nameFr})` === wilaya)) {
      setWilaya("");
      setWilayaNote(null);
    }
  }, [wilayas, wilaya, wilayaOptions]);

  const syncOfflineDrafts = async () => {
    if (offlineDrafts.length === 0 || syncingDrafts.current) return;
    syncingDrafts.current = true;
    setIsSubmitting(true);
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
      await replaceOfflineDrafts(nextDrafts);
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
    setIsSubmitting(false);
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
  // without any manual action (previously only the UI flag flipped — the
  // promised auto-sync never happened).
  useEffect(() => {
    const handleOnlineStatus = () => {
      setIsOffline(false);
      if (offlineDrafts.length > 0 && !syncingDrafts.current) {
        void syncOfflineDrafts();
      }
    };
    const handleOfflineStatus = () => setIsOffline(true);
    window.addEventListener("online", handleOnlineStatus);
    window.addEventListener("offline", handleOfflineStatus);
    return () => {
      window.removeEventListener("online", handleOnlineStatus);
      window.removeEventListener("offline", handleOfflineStatus);
    };
  }, [offlineDrafts.length]);

  // Client-side distance calculation (Haversine formula in km)
  const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number =>
    haversineKm(lat1, lng1, lat2, lng2);

  // Client-side bearing calculation (compass degrees 0-360)
  const calculateBearing = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const lat1Rad = (lat1 * Math.PI) / 180;
    const lat2Rad = (lat2 * Math.PI) / 180;

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x =
      Math.cos(lat1Rad) * Math.sin(lat2Rad) -
      Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

    let bearing = (Math.atan2(y, x) * 180) / Math.PI;
    return (bearing + 360) % 360;
  };

  // Helper to convert bearing angle to cardinal direction
  const getBearingDirection = (angle: number): string => {
    const directions = isArabic 
      ? ["شمال", "شمال شرقي", "شرق", "جنوب شرقي", "جنوب", "جنوب غربي", "غرب", "شمال غربي"]
      : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const index = Math.round(((angle % 360) / 45)) % 8;
    return directions[index];
  };

  // Listener for actual device orientation/compass sensors
  useEffect(() => {
    const handleOrientation = (e: DeviceOrientationEvent) => {
      let currentHeading = null;
      if ("webkitCompassHeading" in e) {
        currentHeading = (e as any).webkitCompassHeading;
      } else if (e.alpha !== null) {
        // 360 - alpha is only an approximation of the compass bearing (device
        // orientation vs. geographic north); it is treated as an estimate.
        currentHeading = 360 - e.alpha;
      }
      
      if (currentHeading !== null) {
        setHeading(Math.round(currentHeading));
        setHeadingSource("sensor");
      }

      if (e.beta !== null) {
        setPitch(Math.round(e.beta));
        setPitchSource("sensor");
      }
    };

    window.addEventListener("deviceorientation", handleOrientation);
    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
    };
  }, []);

  // Correlation effect: matches GPS + compass heading with current reports
  // (an alignment estimate only — no bearing, no matching).
  useEffect(() => {
    if (!lat || !lng || heading === null || !reports || reports.length === 0) {
      setMatchedReport(null);
      setAlignmentAccuracy(null);
      return;
    }

    const uLat = parseFloat(lat);
    const uLng = parseFloat(lng);
    if (isNaN(uLat) || isNaN(uLng)) return;

    let bestMatch: any = null;
    let maxScore = -1;

    reports.forEach((rep) => {
      if ((rep.status !== "pending" && rep.status !== "verified") || !isFreshThreatTimestamp(rep.timestamp) || !Number.isFinite(rep.lat) || !Number.isFinite(rep.lng)) return;
      const dist = getDistance(uLat, uLng, rep.lat, rep.lng);
      // Correlate reports within 15km
      if (dist > 15) return;

      const bearing = calculateBearing(uLat, uLng, rep.lat, rep.lng);
      let diff = Math.abs(bearing - heading);
      if (diff > 180) diff = 360 - diff;

      // Only match if within 45 degrees of camera focus FOV
      if (diff > 45) return;

      // Score based on angular alignment and distance proximity
      const angleScore = ((45 - diff) / 45) * 60; // Up to 60 points
      const distScore = ((15 - dist) / 15) * 40;  // Up to 40 points
      const score = angleScore + distScore;

      if (score > maxScore) {
        maxScore = score;
        bestMatch = {
          report: rep,
          distance: dist,
          bearing: bearing,
          angleDiff: diff,
        };
      }
    });

    if (bestMatch) {
      setMatchedReport(bestMatch.report);
      const confidence = Math.round(40 + (maxScore / 100) * 55); // 40% to 95%
      setAlignmentAccuracy(confidence);
    } else {
      setMatchedReport(null);
      setAlignmentAccuracy(null);
    }
    }, [lat, lng, heading, reports]);
  const safeAlignmentAccuracy = Number.isFinite(Number(alignmentAccuracy))
    ? Math.max(0, Math.min(100, Number(alignmentAccuracy)))
    : 0;
  const safeMatchedDistance = matchedReport && Number.isFinite(Number(matchedReport.distance))
    ? Number(matchedReport.distance).toFixed(1)
    : "—";
  const safeMatchedBearing = matchedReport && Number.isFinite(Number(matchedReport.bearing))
    ? Number(matchedReport.bearing).toFixed(0)
    : "—";
  // Attach the media stream to the <video> the moment it exists — no arbitrary
  // delay that races the element mount.
  useEffect(() => {
    if (stream && videoRef.current) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Camera stream activation
  const startCamera = async () => {
    try {
      setIsCameraOpen(true);
      setCameraStatus("closed");
      setErrorMsg(null);
      const constraints = {
        video: { facingMode: "environment" },
        audio: false,
      };
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      setStream(mediaStream);
      setCameraStatus("active");
      // iOS (Safari 13+) gates motion sensors behind an explicit permission
      // prompt; request it within the camera gesture.
      try {
        const DOE = (window as any).DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === "function") {
          const permission = await DOE.requestPermission();
          if (permission !== "granted") {
            setHeading(null);
            setPitch(null);
            setHeadingSource(permission === "denied" ? "none" : headingSource);
            setPitchSource("none");
          }
        }
      } catch (err) {
        console.warn("DeviceOrientation permission request failed", err);
      }
    } catch (err: unknown) {
      console.warn("Camera hardware unavailable", err);
      setCameraStatus("unavailable");
      setStream(null);
      setIsCameraOpen(false);
      setErrorMsg(isArabic ? "الكاميرا غير متاحة أو لم يُسمح لها. يمكنك إرفاق صورة من جهازك أو متابعة البلاغ بدون صورة." : "Caméra indisponible ou permission refusée. Vous pouvez joindre une photo ou continuer sans image.");
    }
  };

  const stopCamera = () => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    setIsCameraOpen(false);
    setCameraStatus("closed");
    setHeading(null);
    setPitch(null);
    setHeadingSource("none");
    setPitchSource("none");
    setMatchedReport(null);
    setAlignmentAccuracy(null);
    setShowCalibrationGuide(false);
  };

  // High-fidelity image capture with embedded watermarked telemetry
  const captureSnapshot = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (stream && videoRef.current && videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
      const video = videoRef.current;
      const videoWidth = video.videoWidth;
      const videoHeight = video.videoHeight;
      const targetRatio = 640 / 480;
      let sourceX = 0;
      let sourceY = 0;
      let sourceWidth = videoWidth;
      let sourceHeight = videoHeight;

      if (videoWidth / videoHeight > targetRatio) {
        sourceWidth = videoHeight * targetRatio;
        sourceX = (videoWidth - sourceWidth) / 2;
      } else {
        sourceHeight = videoWidth / targetRatio;
        sourceY = (videoHeight - sourceHeight) / 2;
      }

      ctx.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, 640, 480);
    } else {
      // Never fabricate a fake photo: if the camera is unavailable, tell the
      // user and let the report proceed without an image (or via file upload).
      setErrorMsg(
        isArabic
          ? "⚠️ الكاميرا غير متاحة. يمكنك إرفاق صورة من جهازك أو متابعة البلاغ بدون صورة."
          : "⚠️ Caméra indisponible. Vous pouvez joindre une photo ou continuer sans image."
      );
      stopCamera();
      return;
    }

    // Overlay technical HUD overlay onto the image
    ctx.strokeStyle = "rgba(239, 68, 68, 0.5)";
    ctx.lineWidth = 1.5;
    
    // Crosshair target
    ctx.beginPath();
    ctx.moveTo(320, 200);
    ctx.lineTo(320, 280);
    ctx.moveTo(280, 240);
    ctx.lineTo(360, 240);
    ctx.stroke();

    // Technical bounds indicators
    ctx.beginPath();
    ctx.moveTo(20, 40); ctx.lineTo(40, 40); ctx.moveTo(20, 40); ctx.lineTo(20, 60);
    ctx.moveTo(620, 40); ctx.lineTo(600, 40); ctx.moveTo(620, 40); ctx.lineTo(620, 60);
    ctx.moveTo(20, 440); ctx.lineTo(40, 440); ctx.moveTo(20, 440); ctx.lineTo(20, 420);
    ctx.moveTo(620, 440); ctx.lineTo(600, 440); ctx.moveTo(620, 440); ctx.lineTo(620, 420);
    ctx.stroke();

    // Branded telemetry watermark labels — factual only: GPS, UTC time, and
    // sensor values (marked N/A when absent). No "secure proof" claims: the
    // stamp is an evidentiary aid, not a cryptographic proof.
    ctx.fillStyle = "rgba(248, 250, 252, 0.9)";
    ctx.font = "bold 13px monospace";
    ctx.fillText("MAGHREB WILDFIRE OBSERVATORY - TELEMETRY CAPTURE", 30, 70);
    
    ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
    ctx.font = "10px monospace";
    ctx.fillText("FIELD VISUAL ASSIST - ALIGNMENT ESTIMATE (NOT PROOF)", 30, 90);
    
    ctx.fillStyle = "rgba(241, 245, 249, 0.8)";
    ctx.font = "9px monospace";
    ctx.fillText(`GPS LAT: ${lat || "N/A"}`, 30, 115);
    ctx.fillText(`GPS LNG: ${lng || "N/A"}`, 30, 130);
    if (includeTelemetry) {
      ctx.fillText(`BEARING: ${heading !== null ? `${heading}° ${getBearingDirection(heading)}` : "N/A"} (${headingSource.toUpperCase()})`, 30, 145);
      ctx.fillText(`PITCH: ${pitch !== null ? `${pitch}° (${pitchSource.toUpperCase()})` : "N/A"}`, 30, 160);
    } else {
      ctx.fillText("SENSOR STAMP: OFF", 30, 145);
    }
    ctx.fillText(`UTC CAPTURE: ${new Date().toISOString().slice(0, 19)}Z`, 30, 175);

    if (matchedReport) {
      ctx.fillStyle = "rgba(34, 197, 94, 0.9)";
      ctx.fillText(`ALIGNMENT WITH EXISTING REPORT: ${alignmentAccuracy}% (ESTIMATE)`, 30, 200);
      ctx.fillText(`LOCATION: ${matchedReport.locationName.substring(0, 35).toUpperCase()}`, 30, 215);
    } else {
      ctx.fillStyle = "rgba(239, 68, 68, 0.9)";
      ctx.fillText("NO EXISTING REPORT WITHIN BEARING/RANGE", 30, 200);
    }

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setImage(dataUrl);
    // Live capture carries the GPS/UTC stamp in the frame; a file upload does
    // not (warning surfaced to the reporter below).
    setUploadWarning(null);
    // Note: telemetry overlay avoids raw image degradation while keeping a
    // high-fidelity snapshot for the Gemini vision verification.
    runEdgeAiPreScan(dataUrl);

    stopCamera();
  };

  // Automated browser-side GPS acquisition
  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      setErrorMsg(geoErrorMessage(undefined, isArabic));
      return;
    }

    setIsLocating(true);
    setErrorMsg(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLat(position.coords.latitude.toFixed(6));
        setLng(position.coords.longitude.toFixed(6));
        setIsLocating(false);
      },
      // Same actionable per-code wording as the rest of the app (permission
      // blocked vs no signal vs timeout — each has a different fix).
      (error) => {
        setIsLocating(false);
        setErrorMsg(geoErrorMessage(error?.code, isArabic));
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // --- LIGHTWEIGHT ON-DEVICE HEURISTIC PRE-SCANNER ---
  // Note: this is a coarse color-based heuristic (feasible in-browser without a
  // model download). It never verifies a report — final verification is done
  // by the backend Gemini vision model. It only nudges the user to frame the
  // fire clearly.
  const runEdgeAiPreScan = (dataUrl: string, compressionPercent: number | null = null) => {
    const tempImg = new Image();
    tempImg.onload = () => {
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = 50;
      tempCanvas.height = 50;
      const tempCtx = tempCanvas.getContext("2d");
      if (!tempCtx) return;
      
      tempCtx.drawImage(tempImg, 0, 0, 50, 50);
      const imgData = tempCtx.getImageData(0, 0, 50, 50).data;
      
      let fireScore = 0;
      let smokeScore = 0;
      for (let i = 0; i < imgData.length; i += 4) {
        const r = imgData[i];
        const g = imgData[i+1];
        const b = imgData[i+2];
        
        // Fire colors: High Red, moderate Green, low Blue
        if (r > 130 && g > 55 && r > g * 1.3 && b < 100) {
          fireScore++;
        }
        // Smoke colors: Gray, muted, near-equal R, G, B channels
        if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 90 && r < 210) {
          smokeScore++;
        }
      }
      
      const totalPixels = 50 * 50;
      const fireRatio = fireScore / totalPixels;
      const smokeRatio = smokeScore / totalPixels;
      const baseConfidence = (fireRatio * 600) + (smokeRatio * 400);
      const confidence = Math.max(10, Math.min(99, Math.round(baseConfidence)));
      
      if (fireRatio > 0.008 || smokeRatio > 0.02) {
        setEdgeAiStatus({
          success: true,
          confidence: Math.max(50, confidence),
          messageAr: `🔎 فحص لوني بصري أولي (تقديري فقط — لا يُثبت وجود حريق؛ التحقق النهائي يتم بالذكاء الاصطناعي في الخادم عند وصول البلاغ): ألوان متوافقة مع ظلال نارية/دخانية (${Math.max(50, confidence)}%). تم ضغط الصورة بنسبة ${compressionPercent ?? 0}%.`,
          messageFr: `🔎 Pré-scan visuel local (heuristique couleur uniquement — ne constitue pas une preuve ; la vérification finale est faite par l'IA serveur) : teintes compatibles feu/fumée (${Math.max(50, confidence)}%). Image compressée à ${compressionPercent ?? 0}%.`
        });
      } else {
        setEdgeAiStatus({
          success: false,
          confidence,
          messageAr: `⚠️ فحص لوني بصري أولي (تقديري فقط — لا يُثبت عدم وجود حريق): لم تُرصد تدرجات نارية/دخانية واضحة (${confidence}%). الالتقاط المقرّب والصريح يساعد التحقق الخادمي.`,
          messageFr: `⚠️ Pré-scan visuel local : contraste feu/fumée faible (≈${confidence}%). Cadrez clairement pour faciliter la vérification serveur.`
        });
      }
    };
    tempImg.src = dataUrl;
  };

  // Image Upload & Smart Canvas Compression with Edge AI integration
  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
    if (!file) return;
    const isImageType = file.type.startsWith("image/");
    const MAX_INPUT_BYTES = 15 * 1024 * 1024;
    if (!isImageType || file.size > MAX_INPUT_BYTES) {
      setErrorMsg(isArabic ? "الصورة غير صالحة أو أكبر من 15 ميغابايت." : "Image invalide ou supérieure à 15 Mo.");
      e.target.value = "";
      return;
    }
    setErrorMsg(null);
    setOriginalSize((file.size / 1024).toFixed(1) + " KB");
    setIsCompressing(true);

    const reader = new FileReader();
    reader.onerror = () => {
      setIsCompressing(false);
      setImage(null);
      setErrorMsg(isArabic ? "تعذر قراءة الصورة المحددة." : "Impossible de lire l'image sélectionnée.");
    };
    reader.onload = (event) => {
      const img = new Image();
      img.onerror = () => {
        setIsCompressing(false);
        setImage(null);
        setErrorMsg(isArabic ? "الصورة تالفة أو غير قابلة للفك." : "L'image est corrompue ou illisible.");
      };
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        
        const MAX_WIDTH = 600;
        const MAX_HEIGHT = 600;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;

        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          setImage(dataUrl);
          
          const stringLength = dataUrl.length - "data:image/jpeg;base64,".length;
          const sizeInBytes = stringLength * (3 / 4);
          if (sizeInBytes > 480_000) {
            setImage(null);
            setCompressedSize(null);
            setUploadWarning(isArabic ? "الصورة المضغوطة ما زالت كبيرة جدًا للإرسال الآمن." : "L'image compressée reste trop volumineuse pour un envoi sûr.");
            setIsCompressing(false);
            return;
          }
          setCompressedSize((sizeInBytes / 1024).toFixed(1) + " KB");

          const compressionPercent = file.size > 0
            ? Math.min(99, Math.max(0, Math.round((1 - sizeInBytes / file.size) * 100)))
            : 0;
          
          // Trigger local Edge AI analysis immediately
          runEdgeAiPreScan(dataUrl, compressionPercent);
          // A file upload has no in-app telemetry overlay. EXIF/GPS metadata is
          // not inspected here, so it must not be described as absent or proof.
          setUploadWarning(
            isArabic
              ? "⚠️ الصور المرفوعة لا تتضمن ختم القياس الميداني الخاص بالتصوير المباشر. لا يفحص التطبيق بيانات EXIF/GPS، لذلك لا تُعد هذه البيانات إثباتًا مستقلًا."
              : "⚠️ Les photos jointes n'ont pas le marquage de télémétrie de la capture directe. L'application ne vérifie pas les métadonnées EXIF/GPS; elles ne constituent donc pas une preuve indépendante."
          );
        }
        setIsCompressing(false);
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    if (!lat || !lng) {
      setErrorMsg(isArabic ? "يرجى تحديد الموقع الجغرافي للحرائق أولاً." : "Veuillez spécifier la position GPS.");
      return;
    }
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      setErrorMsg(isArabic ? "إحداثيات غير صالحة. يرجى تحديد الموقع من الخريطة." : "Coordonnées invalides. Veuillez choisir la position sur la carte.");
      return;
    }
    if (parsedLat < 19 || parsedLat > 38 || parsedLng < -18 || parsedLng > 25) {
      setErrorMsg(isArabic ? "الإحداثيات المدخلة خارج نطاق المراقبة (شمال أفريقيا فقط)." : "Coordonnées hors de la zone surveillée (Afrique du Nord uniquement).");
      return;
    }
    if (!wilaya) {
      setErrorMsg(isArabic ? "يرجى اختيار الولاية." : "Veuillez choisir la Wilaya.");
      return;
    }
        const normalizedDescription = description.trim();
    const normalizedLocationName = locationName.trim();
    const normalizedName = reporterName.trim();
    const normalizedPhone = reporterPhone.trim();
    const normalizedBadge = reporterBadgeCode.trim();
    if (normalizedDescription.length < 10) {
      setErrorMsg(isArabic ? "يرجى إعطاء وصف تفصيلي لا يقل عن 10 أحرف." : "Description trop courte (min 10 caract.).");
      return;
    }
    if (normalizedPhone && !/^\+?[0-9][0-9 ()-]{5,29}$/.test(normalizedPhone)) {
      setErrorMsg(isArabic ? "يرجى إدخال رقم هاتف صالح أو ترك الحقل فارغًا." : "Veuillez saisir un numéro de téléphone valide ou laisser le champ vide.");
      return;
    }
    submittingRef.current = true;
    setIsSubmitting(true);
    setErrorMsg(null);

    // Idempotency key: retries of the same submission (offline sync, double
    // taps, tab reopen after a crash) resolve to the already-stored report
    // instead of creating duplicates.
    const clientGeneratedId = typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `cg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;

    const payload: any = {
      lat: parsedLat,
      lng: parsedLng,
      locationName: normalizedLocationName,
      wilaya: wilaya.trim(),
      severity,
      description: normalizedDescription,
      reporterName: normalizedName || undefined,
      reporterPhone: normalizedPhone || undefined,
      reporterType,
      reporterBadgeCode: normalizedBadge || undefined,
      image,
      clientGeneratedId,
    };

    // --- INTERCEPT FOR OFFLINE DRAFT MODE ---
    const offlineMode = isOffline || isOfflineSimulation;
    if (offlineMode) {
      const draftReport = {
        ...payload,
        id: clientGeneratedId,
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        queuedAt: new Date().toISOString(),
        schemaVersion: 1,
        retryCount: 0,
        isOfflineDraft: true,
        responseValid: true,
        consensusCount: 1,
        status: "pending" as const,
      };

      const updatedDrafts = [draftReport, ...offlineDrafts];
      try {
        await replaceOfflineDrafts(updatedDrafts);
      } catch (err: unknown) {
        console.error("Failed to save drafts to storage", err);
        setErrorMsg(isArabic ? "تعذر حفظ البلاغ محليًا. تحقق من مساحة التخزين أو أذونات المتصفح." : "Impossible d'enregistrer le brouillon localement. Vérifiez l'espace de stockage du navigateur.");
        submittingRef.current = false;
        setIsSubmitting(false);
        return;
      }
      setOfflineDrafts(updatedDrafts);

      setSuccessReport({
        ...draftReport,
        // No AI verification is fabricated on-device: Gemini runs on the
        // server once the draft is pushed — and only then.
        aiVerification: null,
        aiComments: isArabic
          ? `تم حفظ البلاغ كمسودة في ذاكرة الجهاز (${compressedSize || "0 KB"}). ستتم محاولة مزامنته عند عودة الاتصال — التحقق بالذكاء الاصطناعي يتم بعد وصوله للخادم.`
          : `Signalement enregistré localement (${compressedSize || "0 KB"}). Une synchronisation sera tentée au retour du réseau ; la vérification IA se fait côté serveur.`,
      });

      // Offline drafts never grant trust: the badge must be validated by the
      // server after synchronization before any client trust gate changes.
      // Clear fields on success
      setLocationName("");
      setDescription("");
      setImage(null);
      setOriginalSize(null);
      setCompressedSize(null);
      setEdgeAiStatus(null);
      setLat("");
      setLng("");
      setReporterName("");
      setReporterPhone("");
      setReporterBadgeCode("");
      setReporterType("citizen");
      setHeading(null);
      setPitch(null);
      setPitchSource("none");
      setHeadingSource("none");
      setMatchedReport(null);
      setAlignmentAccuracy(null);
      submittingRef.current = false;
      setIsSubmitting(false);
      return;
    }
    try {
            const result = normalizeSubmissionResult(await onSubmit(payload));
      setSuccessReport(result);
      // Only a server-issued verified result may activate the local operator
      // tone gate. A user-supplied code, pending response, or malformed
      // response is never treated as client-side authority.
      if (normalizedBadge && result?.status === "verified") setReporterBadge(normalizedBadge);
      // Reset form on success
      setLocationName("");
      setDescription("");
      setImage(null);
      setOriginalSize(null);
      setCompressedSize(null);
      setEdgeAiStatus(null);
      setLat("");
      setLng("");
      setReporterName("");
      setReporterPhone("");
      setReporterBadgeCode("");
      setReporterType("citizen");
      setHeading(null);
      setPitch(null);
      setPitchSource("none");
      setHeadingSource("none");
      setMatchedReport(null);
      setAlignmentAccuracy(null);
    } catch (err: unknown) {
      const errorRecord = typeof err === "object" && err !== null ? err as Record<string, unknown> : {};
      const responseRecord = typeof errorRecord.response === "object" && errorRecord.response !== null
        ? errorRecord.response as Record<string, unknown>
        : {};
      const responseData = typeof responseRecord.data === "object" && responseRecord.data !== null
        ? responseRecord.data as Record<string, unknown>
        : {};
      const serverMsgCandidate = typeof errorRecord.data === "object" && errorRecord.data !== null
        ? (errorRecord.data as Record<string, unknown>).error
        : responseData.error;
      const serverMsg = typeof serverMsgCandidate === "string" ? serverMsgCandidate : undefined;
      setErrorMsg(toUserFacingSubmitError(serverMsg, isArabic));
    } finally {
      submittingRef.current = false;
      setIsSubmitting(false);
    }
  };

  return (
    <div className="bg-zinc-900/50 border border-white/5 rounded-xl p-5 shadow-[0_4px_25px_rgba(0,0,0,0.5)] relative overflow-hidden" dir={isArabic ? "rtl" : "ltr"}>
      <div className="flex items-center gap-2 mb-4">
        <div className="p-1.5 bg-red-600/20 text-red-500 rounded border border-red-500/20">
          <AlertTriangle className="h-5 w-5 animate-pulse" />
        </div>
        <h3 className="font-bold text-base text-slate-100">
          {isArabic ? "إرسال بلاغ عاجل عن حريق" : "Signaler d'urgence un incendie"}
        </h3>
      </div>

      {/* --- OFFLINE / ONLINE STATUS SELECTOR & DRAFTS SYNC QUEUE --- */}
      <div className="mb-4 bg-black/60 border border-white/5 p-3 rounded-lg flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${isOffline || isOfflineSimulation ? "bg-amber-500 animate-pulse" : "bg-emerald-500 animate-pulse"}`}></span>
            <span className="text-[11px] font-bold text-slate-200">
              {isOfflineSimulation
                ? (isArabic ? "محاكاة انقطاع الشبكة — تُحفظ المسودات محليًا" : "Simulation hors-ligne — brouillons enregistrés localement")
                : isOffline
                  ? (isArabic ? "الاتصال غير متاح — تُحفظ المسودات محليًا" : "Connexion indisponible — brouillons enregistrés localement")
                  : syncState === "live"
                    ? (isArabic ? "الخادم متاح — البلاغات تُرسل مباشرة" : "Serveur disponible — envoi direct")
                    : syncState === "partial" || syncState === "degraded" || syncState === "stale"
                      ? (isArabic ? "الخادم متاح جزئيًا — تحقق من حالة المزامنة" : "Serveur partiellement disponible — vérifiez la synchronisation")
                      : (isArabic ? "لم تُؤكّد جاهزية الخادم — ستظهر النتيجة بعد الإرسال" : "La disponibilité du serveur n'est pas confirmée — le résultat apparaîtra après l'envoi")}
            </span>
          </div>
          
          {allowOfflineSimulation && (
            <button
              type="button"
              onClick={() => setIsOfflineSimulation((value) => !value)}
              className={`px-2 py-1 rounded text-[10px] font-bold border transition-colors cursor-pointer ${
                isOfflineSimulation
                  ? "bg-amber-500/25 text-amber-400 border-amber-500/40 hover:bg-amber-500/45"
                  : "bg-slate-900 text-slate-400 border-white/10 hover:bg-slate-800"
              }`}
            >
              {isOfflineSimulation
                ? (isArabic ? "🛜 إيقاف المحاكاة" : "🛜 Désactiver la simulation")
                : (isArabic ? "📴 محاكاة Offline (تطوير)" : "📴 Simuler le hors-ligne (dev)")}
            </button>
          )}
        </div>

        {offlineDrafts.length > 0 && (
          <div className="mt-2 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-amber-300 font-bold flex items-center gap-1.5">
                📦 {isArabic ? `لديك ${offlineDrafts.length} مسودة بانتظار المزامنة` : `${offlineDrafts.length} brouillon(s) en attente de synchronisation`}
              </span>
              {!isOffline && !isOfflineSimulation && (
                <button
                  type="button"
                  onClick={syncOfflineDrafts}
                  disabled={isSubmitting}
                  className="px-2.5 py-1 bg-amber-500 hover:bg-amber-600 text-slate-950 rounded text-[10px] font-extrabold transition-all cursor-pointer shadow-md flex items-center gap-1"
                >
                  {isSubmitting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <span>🚀 {isArabic ? "مزامنة وبث المسودات" : "Mynchroniser les brouillons"}</span>
                  )}
                </button>
              )}
            </div>
            {syncStatusMsg && (
              <p role="status" aria-live="polite" className="text-[9px] text-emerald-400 font-bold leading-normal">{syncStatusMsg}</p>
            )}
          </div>
        )}
      </div>

      {successReport ? (
        <div className="bg-emerald-950/20 border border-emerald-500/30 rounded-xl p-5 text-center space-y-4 animate-fade-in">
          <div className="inline-flex p-3 bg-emerald-500/20 text-emerald-400 rounded-full">
            <CheckCircle className="h-10 w-10" />
          </div>
          <h4 className="font-bold text-lg text-emerald-400">
            {successReport.isOfflineDraft
              ? (isArabic ? "تم حفظ البلاغ كمسودة" : "Signalement enregistré comme brouillon")
              : successReport.responseValid === false
                ? (isArabic ? "تم قبول البلاغ — جارٍ مزامنته" : "Signalement accepté — synchronisation en cours")
                : (isArabic ? "تم إرسال البلاغ بنجاح" : "Signalement envoyé avec succès !")}
          </h4>
          <p className="text-xs text-slate-300 leading-relaxed max-w-sm mx-auto">
            {successReport.isOfflineDraft
              ? (isArabic
                  ? "حُفظ البلاغ كمسودة على جهازك. ستتم محاولة مزامنته عند عودة الاتصال، والتحقق بالذكاء الاصطناعي يتم بعد وصوله إلى الخادم."
                  : "Signalement enregistré sur votre appareil. Une synchronisation sera tentée au retour du réseau ; l'analyse IA se fait côté serveur.")
              : successReport.responseValid === false
                ? (isArabic
                    ? "قبل الخادم طلب البلاغ، لكن استجابته التفصيلية لم تكن صالحة للعرض. ستتم إعادة المزامنة قبل عرض الحالة النهائية، دون اختلاق حالة أو نتيجة."
                    : "Le serveur a accepté le signalement, mais sa réponse détaillée n'était pas exploitable. Une resynchronisation est lancée avant d'afficher l'état final.")
                : (isArabic
                    ? "شكراً لك. تم قبول البلاغ، وقد تظهر نتيجة التحليل أو المراجعة لاحقًا. لا يعني قبول الإرسال أن البلاغ حقيقة موثقة تلقائيًا."
                    : "Merci. Le signalement est accepté ; l'analyse ou la revue peuvent intervenir ensuite. L'acceptation de l'envoi ne constitue pas une confirmation du fait.")}
          </p>

          {/* Honest disclosure when the photo could not be transmitted (bad
              data URL, decoder failure): the report WAS accepted, but without
              the evidence photo — a silent drop would mislead the reporter
              into believing the image reached the coordination team. */}
          {successReport.imageNotAttached && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-start" dir={isArabic ? "rtl" : "ltr"}>
              <p className="text-[11px] text-amber-300 font-bold mb-1">
                ⚠️ {isArabic ? "أُرسل البلاغ بدون الصورة" : "Signalement envoyé SANS photo"}
              </p>
              <p className="text-[11px] text-slate-300 leading-relaxed">
                {isArabic
                  ? "تعذّر إرسال الصورة (ملف تالف أو غير قابل للقراءة). البلاغ وصل، لكن الصورة لن تصل إلى فريق التنسيق — حاول إعادة الإرسال بصورة أخرى."
                  : "La photo n'a pas pu être transmise (fichier illisible). Le signalement est bien arrivé, mais l'équipe ne recevra pas l'image — réessayez avec une autre photo."}
              </p>
            </div>
          )}

          {/* AI Feedback presentation */}
          {successReport.aiVerification && (
            <div className="bg-black/60 p-3.5 rounded-lg border border-emerald-500/20 text-start" dir={isArabic ? "rtl" : "ltr"}>
              <div className="flex items-center gap-1 text-emerald-300 font-bold text-xs mb-1.5 justify-between">
                <span>🤖 {isArabic ? "تحليل بصري مساعد بالذكاء الاصطناعي (Gemini)" : "Analyse visuelle assistée par IA (Gemini)"}</span>
                <span className="bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 px-1.5 py-0.5 rounded text-[10px]">
                  {Number.isFinite(Number(successReport.aiVerification.confidence))
                    ? `${Math.max(0, Math.min(100, Number(successReport.aiVerification.confidence)))}% ${isArabic ? "مؤشر تحليل" : "indice d'analyse"}`
                    : (isArabic ? "غير متاح" : "indisponible")}
                </span>
              </div>
              <p className="text-xs text-slate-300 mb-2 leading-relaxed">
                {successReport.aiVerification.aiComments}
              </p>
              <div className="flex flex-wrap gap-1">
                {(Array.isArray(successReport.aiVerification.detectedSigns) ? successReport.aiVerification.detectedSigns : []).map((sign: string, idx: number) => (
                  <span key={`${sign}-${idx}`} className="bg-zinc-900 text-slate-300 text-[10px] px-2 py-0.5 rounded border border-white/5">
                    🔍 {sign}
                  </span>
                ))}
              </div>
            </div>
          )}

          <button
            onClick={() => setSuccessReport(null)}
            className="w-full py-2.5 bg-zinc-800 hover:bg-zinc-700 text-slate-200 rounded-lg font-bold text-sm transition-colors cursor-pointer"
          >
            {isArabic ? "تقديم بلاغ آخر" : "Faire un autre signalement"}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          
          {/* Coordinates Grid */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
                {isArabic ? "خط العرض (Latitude)" : "Latitude"}
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                  placeholder="36.88124"
                  className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg py-2 pl-3 pr-8 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40"
                  required
                />
                <MapPin className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-gray-500" />
              </div>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
                {isArabic ? "خط الطول (Longitude)" : "Longitude"}
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                  placeholder="8.41125"
                  className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg py-2 pl-3 pr-8 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40"
                  required
                />
                <MapPin className="absolute right-2.5 top-2.5 h-3.5 w-3.5 text-gray-500" />
              </div>
            </div>
          </div>

          {/* Smart Location Button & Instructions */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={handleGetLocation}
              disabled={isLocating}
              className="w-full py-2 bg-red-650/10 hover:bg-red-650/20 border border-red-500/20 hover:border-red-500/40 text-red-400 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isLocating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{isArabic ? "جاري جلب موقعك بالـ GPS..." : "Acquisition GPS..."}</span>
                </>
              ) : (
                <>
                  <MapPin className="h-3.5 w-3.5 text-red-500" />
                  <span>{isArabic ? "تحديد موقعي التلقائي (الـ GPS)" : "Me géolocaliser automatiquement"}</span>
                </>
              )}
            </button>
            <p className="text-[10px] text-gray-500 italic text-center">
              {isArabic
                ? "💡 تلميح: يمكنك أيضاً تحديد الموقع بدقة تامة بمجرد النقر فوق أي نقطة على الخريطة مباشرة!"
                : "💡 Astuce: Vous pouvez aussi cliquer directement sur la carte pour épingler le feu"}
            </p>
          </div>

          {/* Location Name & Wilaya */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
                {isArabic ? "الولاية" : "Wilaya"}
              </label>
              <select
                value={wilaya}
                onChange={(e) => {
                  setWilaya(e.target.value);
                  setWilayaNote(null);
                }}
                className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg py-2 px-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40 cursor-pointer"
                required
              >
                <option value="">{isArabic ? "-- اختر الولاية --" : "-- Choisir Wilaya --"}</option>
                {wilayaOptions.map((w) => (
                  <option key={`${w.nameAr}-${w.nameFr}`} value={`${w.nameAr} (${w.nameFr})`}>
                    {isArabic ? w.nameAr : w.nameFr}
                  </option>
                ))}
              </select>
              {wilayaNote && (
                <div className={`mt-1.5 p-2 rounded-lg border text-[10px] leading-relaxed ${
                  wilayaNote.kind === "suggest"
                    ? "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
                    : "bg-amber-950/25 border-amber-500/30 text-amber-300"
                }`}>
                  <div className="flex items-start justify-between gap-2">
                    <span>{isArabic ? wilayaNote.textAr : wilayaNote.textFr}</span>
                    {wilayaNote.kind === "suggest" && wilayaNote.option && (
                      <button
                        type="button"
                        onClick={() => {
                          setWilaya(wilayaNote.option!);
                          setWilayaNote(null);
                        }}
                        className="shrink-0 px-2 py-1 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 rounded text-[9px] font-black cursor-pointer hover:bg-emerald-500/30"
                      >
                        {isArabic ? "استخدام" : "Utiliser"}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
                {isArabic ? "اسم التجمع السكني أو الغابة (اختياري)" : "Nom du lieu / Forêt (optionnel)"}
              </label>
              <input
                type="text"
                value={locationName}
                maxLength={200}
                onChange={(e) => setLocationName(e.target.value)}
                placeholder={isArabic ? "مثال: غابة جبل الوحش، بالقرب من السد" : "Ex: Forêt de Seraïdi, près du réservoir"}
                className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg py-2 px-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40"
              />
            </div>
          </div>

          {/* Severity & Contact */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1.5">
              {isArabic ? "مستوى خطورة النيران ومداها" : "Intensité et gravité"}
            </label>
            <div className="grid grid-cols-4 gap-2">
              {[
                { val: "low", labelAr: "خفيف", labelFr: "Faible" },
                { val: "medium", labelAr: "متوسط", labelFr: "Moyen" },
                { val: "high", labelAr: "مرتفع", labelFr: "Élevé" },
                { val: "critical", labelAr: "كارثي", labelFr: "Critique" },
              ].map((item) => (
                <button
                  key={item.val}
                  type="button"
                  onClick={() => setSeverity(item.val)}
                  aria-pressed={severity === item.val}
                  className={`py-2 px-1 text-center rounded-lg border text-[11px] font-bold cursor-pointer transition-all ${
                    severity === item.val
                      ? "bg-red-600 text-white border-red-600 shadow-[0_0_12px_rgba(220,38,38,0.3)]"
                      : "bg-black/40 text-slate-400 border-white/5 hover:border-white/10"
                  }`}
                >
                  {isArabic ? item.labelAr : item.labelFr}
                </button>
              ))}
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
              {isArabic ? "الوصف التفصيلي وحالة النيران" : "Description et détails du feu"}
            </label>
            <textarea
              value={description}
              maxLength={2000}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={
                isArabic
                  ? "ما الذي يحترق؟ هل النيران تقترب من المنازل والقرى؟ هل تتوفر سيارات الإطفاء؟..."
                  : "Qu'est-ce qui brûle ? Le feu approche-t-il des habitations ? Quel est l'état du vent ?..."
              }
              rows={3}
              className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg p-3 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40 leading-relaxed"
              required
            ></textarea>
          </div>

          {/* Image upload with bandwidth simulation compression info */}
          <div>
            <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
              {isArabic ? "التقاط أو إرفاق صورة ميدانية (تُضغط تلقائياً)" : "Prendre / Joindre une photo (compressée auto)"}
            </label>
            
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                onChange={handleImageChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isCompressing}
                className="py-2.5 px-4 bg-black/50 border border-white/5 hover:border-white/10 text-slate-300 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                {isCompressing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin text-red-500" />
                    <span>{isArabic ? "جاري ضغط الصورة..." : "Compression de la photo..."}</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-4 w-4 text-red-500" />
                    <span>{isArabic ? "إرفاق ملف صورة" : "Joindre un fichier"}</span>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={startCamera}
                className="py-2.5 px-4 bg-red-950/40 hover:bg-red-950/60 border border-red-500/20 text-red-400 hover:text-white rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Camera className="h-4 w-4" />
                <span>{isArabic ? "كاميرا ميدانية وبوصلة" : "Caméra & Boussole"}</span>
              </button>

              <label className="flex items-center gap-1.5 text-[10px] text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeTelemetry}
                  onChange={(e) => setIncludeTelemetry(e.target.checked)}
                  className="accent-red-500 h-3.5 w-3.5"
                />
                <span>{isArabic ? "إضافة ختم الاتجاه والارتفاع على الصورة" : "Imprimer cap & inclinaison sur la photo"}</span>
              </label>

              {image && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 bg-black/60 p-1.5 rounded-lg border border-white/5 w-fit">
                    <img src={image} className="h-8 w-12 object-cover rounded border border-white/10" alt="Thumbnail" />
                    <div className="text-[9px] text-slate-400 leading-none">
                      <p className="text-red-400 font-bold">{isArabic ? "مضغوطة بنجاح" : "Compressé"}</p>
                      <p className="mt-0.5">{compressedSize} <span className="line-through text-[8px] text-gray-600">({originalSize})</span></p>
                    </div>
                  </div>

                  {uploadWarning && (
                    <div className="p-2.5 rounded-lg border border-amber-500/40 bg-amber-950/25 text-amber-300 text-[10px] leading-relaxed">
                      {uploadWarning}
                    </div>
                  )}

                  {edgeAiStatus && (
                    <div className={`p-2.5 rounded-lg border text-[10px] flex items-start gap-2 leading-relaxed ${
                      edgeAiStatus.success 
                        ? "bg-emerald-950/20 border-emerald-500/20 text-emerald-400" 
                        : "bg-amber-950/25 border-amber-500/30 text-amber-400 animate-pulse"
                    }`}>
                      <span className="text-base leading-none">🤖</span>
                      <div className="flex-1">
                        <div className="flex items-center justify-between font-extrabold mb-0.5">
                          <span>{isArabic ? "فحص بصري أولي (محلي في المتصفح):" : "Pré-scan visuel local :"}</span>
                          <span className={`px-1 rounded text-[9px] font-black ${
                            edgeAiStatus.success ? "bg-emerald-500/20 text-emerald-300" : "bg-amber-500/20 text-amber-300"
                          }`}>
                            {edgeAiStatus.confidence}% {isArabic ? "مؤشر لوني" : "score visuel"}
                          </span>
                        </div>
                        <p>{isArabic ? edgeAiStatus.messageAr : edgeAiStatus.messageFr}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            <p className="text-[9px] text-gray-500 mt-1 italic">
              {isArabic
                ? "🔒 تُضغط الصور محلياً. قد تتضمن الصور الملتقطة بالكاميرا ختم الموقع والوقت؛ الصور المرفوعة لا تُعامل كإثبات GPS/وقت. المطابقة مع البلاغات المجاورة تقديرية ولا تُثبت الحريق."
                : "🔒 Les images sont compressées localement. Les captures caméra peuvent porter une empreinte de position et d'heure ; les fichiers joints ne constituent pas une preuve GPS/temps. L'alignement reste une estimation."}
            </p>
          </div>

      {/* 4. CAMERA VIEWPORT OVERLAY */}
      {isCameraOpen && (
        <div className="fixed inset-0 bg-slate-950/98 z-[9999] flex flex-col justify-between p-4 md:p-6 select-none font-mono text-slate-100">
          
          {/* HUD Top Bar info */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-red-500/20 pb-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse"></span>
                <span className="text-sm font-black tracking-widest text-red-500">
                  {isArabic ? "نظام المساعدة البصرية الميداني" : "FIELD VISUAL ASSIST SYSTEM"}
                </span>
              </div>
              <p className="text-[10px] text-slate-400 mt-1">
                {isArabic ? "توجيه الكاميرا وتقدير المواجهة مع البلاغات القريبة — تقديري ولا يثبت الحريق" : "Camera guidance & bearing estimate against nearby reports — an estimate, not a fire proof"}
              </p>
            </div>
            
            <button 
              type="button"
              onClick={stopCamera}
              className="self-end md:self-auto px-3 py-1.5 bg-slate-900 border border-white/10 text-xs rounded hover:bg-slate-800 text-slate-300 font-bold"
            >
              [ {isArabic ? "إغلاق الكاميرا ✕" : "CLOSE FEED ✕"} ]
            </button>
          </div>

          {/* Large Interactive Viewport */}
          <div className="relative flex-1 my-4 bg-black rounded-xl overflow-hidden border border-red-500/10 shadow-[inset_0_0_50px_rgba(239,68,68,0.2)] flex items-center justify-center">
            
            {stream ? (
              <video 
                ref={videoRef} 
                autoPlay 
                playsInline 
                muted 
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              // Explicit demo fallback: this is never presented as camera or sensor data.
              <div className="absolute inset-0 flex flex-col justify-between p-4 bg-gradient-to-b from-slate-950 via-indigo-950/40 to-slate-950">
                <div className="text-center pt-12">
                  <div className="text-[10px] uppercase tracking-widest text-red-500 bg-red-950/40 border border-red-500/20 py-1.5 px-3 rounded-lg inline-block font-bold">
                    ⚠️ {cameraStatus === "unavailable"
                      ? (isArabic ? "الكاميرا غير متاحة — معاينة تجريبية فقط" : "CAMERA UNAVAILABLE — DEMO PREVIEW ONLY")
                      : (isArabic ? "معاينة تجريبية — لا توجد بيانات كاميرا حقيقية" : "DEMO PREVIEW ONLY — NO REAL CAMERA DATA")}
                  </div>
                </div>

                {/* Abstract guidance backdrop; no simulated fire or sensor claim. */}
                <div className="relative h-48 w-full overflow-hidden opacity-80 mt-auto">
                  <div className="absolute bottom-0 w-full h-24 bg-slate-950 rounded-t-[100%] border-t border-red-500/20"></div>
                  
                  {/* Abstract, non-evidentiary visual guidance marker */}
                  <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center">
                    <div className="h-28 w-16 bg-gradient-to-t from-red-600/40 via-amber-500/20 to-transparent rounded-full blur-xl animate-pulse"></div>
                    <div className="h-20 w-8 bg-gradient-to-t from-red-600 via-amber-500 to-transparent rounded-full blur-sm -mt-20 animate-pulse"></div>
                    <span className="text-[9px] text-red-400 tracking-widest mt-1 bg-black/80 px-1.5 py-0.5 rounded border border-red-500/20 font-bold">
                      {isArabic ? "توجيه بصري تجريبي فقط" : "VISUAL GUIDANCE DEMO ONLY"}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Static optical coordinate grids overlay */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
              {/* Outer boundary guidelines */}
              <div className="absolute top-6 left-6 border-t-2 border-l-2 border-red-500/30 w-8 h-8"></div>
              <div className="absolute top-6 right-6 border-t-2 border-r-2 border-red-500/30 w-8 h-8"></div>
              <div className="absolute bottom-6 left-6 border-b-2 border-l-2 border-red-500/30 w-8 h-8"></div>
              <div className="absolute bottom-6 right-6 border-b-2 border-r-2 border-red-500/30 w-8 h-8"></div>
              
              {/* Tactical circular reticle */}
              <div className="h-44 w-44 rounded-full border border-red-500/20 flex items-center justify-center animate-pulse">
                <div className="h-32 w-32 rounded-full border border-red-500/30 border-dashed flex items-center justify-center">
                  <div className="h-4 w-4 rounded-full bg-red-600/40"></div>
                </div>
              </div>
              
              {/* Horizontal / Vertical crosshairs */}
              <div className="absolute h-px w-3/4 bg-red-500/20"></div>
              <div className="absolute w-px h-3/4 bg-red-500/20"></div>
            </div>

            {/* TOP COMPASS BAR RULER Overlay */}
            <div className="absolute top-4 left-4 right-4 bg-slate-950/90 border border-slate-800 backdrop-blur rounded-lg p-3 flex flex-col items-center">
              <div className="flex justify-between items-center w-full mb-1">
                <span className="text-xs font-black text-amber-500 tracking-wider flex items-center gap-1.5">
                  🧭 {heading !== null
                    ? (isArabic ? `زاوية اتجاه البوصلة: ${heading}° ${getBearingDirection(heading)}` : `COMPASS BEARING: ${heading}° ${getBearingDirection(heading)}`)
                    : (isArabic ? "البوصلة: لا توجد بيانات من المستشعر" : "BEARING: NO SENSOR DATA")}
                  {headingSource === "sensor" && (
                    <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 px-1.5 py-0.5 rounded text-[8px] font-black normal-case">
                      {isArabic ? "مستشعر" : "SENSOR"}
                    </span>
                  )}
                  {headingSource === "manual" && (
                    <span className="bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded text-[8px] font-black normal-case">
                      {isArabic ? "ضبط يدوي" : "MANUAL"}
                    </span>
                  )}
                </span>
                
                {/* Compass guide toggle (there is no fake calibration progress:
                    calibration is a user gesture, not a timer) */}
                <button
                  type="button"
                  onClick={() => setShowCalibrationGuide((v) => !v)}
                  className={`px-2 py-0.5 rounded text-[9px] font-black tracking-widest uppercase transition-all cursor-pointer ${
                    showCalibrationGuide
                      ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                      : "bg-slate-800 text-slate-300 border border-white/10 hover:bg-slate-700"
                  }`}
                >
                  {showCalibrationGuide
                    ? (isArabic ? "إخفاء الدليل" : "MASQUER LE GUIDE")
                    : (isArabic ? "دليل البوصلة" : "GUIDE BOUSSOLE")}
                </button>
              </div>

              {/* Compass guide — static honest instructions */}
              {showCalibrationGuide && (
                <div className="w-full bg-slate-900 border border-slate-700 rounded p-2 text-center text-[10px] space-y-1 my-1.5">
                  <p className="text-sky-300 font-bold">
                    {isArabic ? "كيف تعمل البوصلة؟" : "Comment ça marche ?"}
                  </p>
                  <p className="text-slate-300 leading-normal">
                    {isArabic
                      ? "تُقرأ الزاوية من مستشعر الاتجاه في جهازك عند توفره. أمسك الهاتف أفقياً وأدر نفسك ببطء لالتقاط الاتجاه الحقيقي. على iOS/Safari قد يُطلب منك إذن الحركة والاتجاه أولاً. إذا لم تظهر بيانات، اسحب المنزلق للضبط اليدوي — وسيُعلَّم ذلك على الصورة."
                      : "La direction provient du capteur d'orientation de l'appareil (s'il existe). Tenez le téléphone à plat et pivotez lentement. Sur iOS/Safari, une permission mouvement/orientation peut être requise. Sans capteur, utilisez le curseur manuel — l'image sera marquée MANUAL."}
                  </p>
                </div>
              )}

              {/* Compass scale slider allowing manual override / calibration */}
              <input 
                type="range" 
                min="0" 
                max="359" 
                  value={heading ?? 0}
                  aria-label={isArabic ? "اتجاه يدوي أو قراءة المستشعر" : "Direction manuelle ou lecture du capteur"}
                  aria-valuetext={heading === null ? (isArabic ? "لا توجد قراءة مستشعر؛ القيمة اليدوية غير محددة" : "Aucune lecture capteur ; réglage manuel non défini") : `${heading}°`}
                  onChange={(e) => {
                  setHeading(parseInt(e.target.value, 10));
                  setHeadingSource("manual");
                }}
                className="w-full mt-2 accent-red-500 cursor-pointer h-1 bg-slate-800 rounded-lg appearance-none"
              />
              {headingSource === "none" && (
                <p className="text-[9px] text-slate-500 mt-1 w-full text-center">
                  {isArabic ? "لا مستشعر متاح — اسحب المنزلق للضبط اليدوي (سيُعلَّم ذلك على الصورة)." : "Aucun capteur disponible — glissez pour un réglage manuel (marqué sur la photo)."}
                </p>
              )}
              <div className="flex justify-between w-full text-[9px] text-slate-500 mt-1 font-mono">
                <span>0° N</span>
                <span>45° NE</span>
                <span>90° E</span>
                <span>135° SE</span>
                <span>180° S</span>
                <span>225° SW</span>
                <span>270° W</span>
                <span>315° NW</span>
              </div>
            </div>

            {/* LEFT TILT PITCH RULER Overlay */}
            <div className="absolute left-4 top-1/4 bottom-1/4 bg-slate-950/90 border border-slate-800 backdrop-blur rounded-lg p-3 flex flex-col items-center justify-between w-14">
              <span className="text-[10px] text-slate-400 font-bold rotate-90 my-2 whitespace-nowrap">
                {isArabic ? "زاوية الارتفاع" : "PITCH"}
              </span>
              <div className="flex-1 flex flex-col items-center justify-center gap-2 w-full">
                <input 
                  type="range" 
                  min="-60" 
                  max="60" 
                  value={pitch ?? 0}
                  onChange={(e) => {
                    setPitch(parseInt(e.target.value, 10));
                    setPitchSource("manual");
                  }}
                  className="h-28 accent-amber-500 cursor-row-resize appearance-none bg-slate-800 rounded w-1"
                  style={{ WebkitAppearance: "slider-vertical" as any }}
                />
                <span className="text-[10px] font-bold text-amber-400 mt-1">{pitch !== null ? (pitch > 0 ? `+${pitch}` : pitch) : "—"}°</span>
              </div>
            </div>

            {/* RIGHT VISUAL ALIGNMENT HUD PANEL (Matched reports status) */}
            <div className="absolute right-4 top-1/4 max-w-[200px] bg-slate-950/95 border border-slate-800 backdrop-blur rounded-lg p-3 space-y-2 text-[10px]">
              <div className="flex items-center gap-1.5 border-b border-white/5 pb-1.5">
                <span className="flex h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                <span className="font-extrabold text-slate-200 uppercase tracking-widest text-[9px]">
                  {isArabic ? "محاذاة بصرية تقديرية" : "VISUAL ALIGNMENT (EST.)"}
                </span>
              </div>

              {matchedReport ? (
                <div className="space-y-1">
                  <p className="text-emerald-400 font-bold flex items-center gap-1">
                    🎯 {isArabic ? "بلاغ قريب في هذا الاتجاه" : "REPORT ON THIS BEARING"}
                  </p>
                  <p className="text-slate-200 font-semibold line-clamp-1">{matchedReport.locationName}</p>
                  <div className="w-full h-1 bg-slate-900 rounded-full overflow-hidden mt-1">
                    <div className="bg-emerald-500 h-full" style={{ width: `${safeAlignmentAccuracy}%` }}></div>
                  </div>
                  <div className="flex justify-between text-[8px] text-slate-500 mt-1">
                    <span>{isArabic ? "تقدير المطابقة:" : "Match estimate:"}</span>
                    <span className="font-bold text-emerald-400">{safeAlignmentAccuracy}%</span>
                  </div>
                  <p className="text-slate-400 text-[8px] mt-1 leading-normal italic">
                    {isArabic 
                      ? `بلاغ قائم يتوافق مع الاتجاه والمدى (${safeMatchedDistance} كلم، زاوية ${safeMatchedBearing}°) — مطابقة تقديرية للموقع لا إثبات للمصدر.`
                      : `Signalement existant corrélé en orientation/distance (${safeMatchedDistance} km, bearing ${safeMatchedBearing}°) — correspondance estimée.`}
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-red-400 font-bold">
                    ⚠️ {isArabic ? "لا بلاغات قريبة" : "NO NEARBY REPORT"}
                  </p>
                  <p className="text-slate-400 leading-normal text-[8px]">
                    {isArabic 
                      ? "لا توجد بلاغات مسجلة ضمن هذا الاتجاه والمدى من موقعك. حدّث نقطة الإرسال من الخريطة أو الـ GPS مباشرة."
                      : "Aucun signalement enregistré dans cet angle et cette portée. Renseignez la position via la carte ou le GPS."}
                  </p>
                  {(!lat || !lng) && (
                    <p className="text-amber-400 font-bold text-[8px] border-t border-white/5 pt-1 mt-1">
                      ⚠️ {isArabic ? "تنبيه: يلزم تحديد موقعك أولاً" : "GPS coordinates required"}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Bottom Status bar overlay */}
            <div className="absolute bottom-3 left-4 right-4 bg-black/80 backdrop-blur rounded px-3 py-1.5 text-[9px] text-slate-400 flex flex-wrap gap-2 justify-between border border-white/5">
              <span>GPS: <strong className="text-slate-200">{Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) ? `${lat}, ${lng}` : (isArabic ? "غير متاح" : "NOT SET")}</strong></span>
              <span>BEARING: <strong className="text-slate-200">{heading !== null ? `${heading}° (${headingSource})` : "N/A"}</strong></span>
              <span>PITCH: <strong className="text-slate-200">{pitch !== null ? `${pitch}° (${pitchSource})` : "N/A"}</strong></span>
              <span>STAMP: <strong className="text-red-500">{includeTelemetry ? "ACTIVE" : "OFF"}</strong></span>
            </div>

          </div>

          {/* Action capture footer buttons */}
          <div className="flex flex-col items-center gap-2 border-t border-red-500/10 pt-4">
            <button
              type="button"
              onClick={captureSnapshot}
              className="h-14 w-14 rounded-full bg-red-600 hover:bg-red-500 border-4 border-slate-900 shadow-[0_0_20px_rgba(220,38,38,0.6)] hover:scale-105 transition-all flex items-center justify-center cursor-pointer active:scale-95 animate-pulse"
              title={isArabic ? "التقط صورة ميدانية بختم الإحداثيات والوقت" : "Capturer la photo estampillée"}
            >
              <Camera className="h-6 w-6 text-white" />
            </button>
            <span className="text-[10px] text-slate-300 font-extrabold tracking-widest text-center">
              {isArabic ? "انقر لالتقاط صورة ميدانية بختم الإحداثيات والوقت" : "CLICK SHUTTER TO CAPTURE STAMPED PHOTO"}
            </span>
          </div>

        </div>
      )}

          {/* Reporter Role Selection (الحماية المدنية / متطوعين معتمدين) */}
          <div className="bg-black/40 p-3.5 rounded-lg border border-white/5 space-y-3.5">
            <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400">
              {isArabic ? "الصفة والاعتماد الميداني" : "Qualité du déclarant et accréditation"}
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { val: "citizen", labelAr: "👤 مواطن", labelFr: "Citoyen" },
                { val: "volunteer", labelAr: "💚 متطوع معتمد", labelFr: "Bénévole" },
                { val: "official", labelAr: "🛡️ حماية مدنية", labelFr: "Prot. Civile" },
              ].map((item) => (
                <button
                  key={item.val}
                  type="button"
                  onClick={() => {
                    setReporterType(item.val);
                    setReporterBadgeCode("");
                  }}
                  aria-pressed={reporterType === item.val}
                  className={`py-2 px-1 text-center rounded-lg border text-[11px] font-bold cursor-pointer transition-all ${
                    reporterType === item.val
                      ? "bg-amber-500/20 text-amber-400 border-amber-500/40 shadow-[0_0_8px_rgba(245,158,11,0.15)]"
                      : "bg-black/40 text-slate-400 border-white/5 hover:border-white/10"
                  }`}
                >
                  {isArabic ? item.labelAr : item.labelFr}
                </button>
              ))}
            </div>

            {reporterType !== "citizen" && (
              <div className="space-y-1.5 animate-fade-in">
                <label className="block text-[10px] uppercase tracking-wider font-bold text-amber-500">
                                    {isArabic
                    ? "🔑 رمز اعتماد اختياري — يتحقق الخادم من صلاحيته"
                    : "🔑 Code d'accréditation facultatif — validé par le serveur"}
                </label>
                <input
                  type="text"
                  value={reporterBadgeCode}
                  maxLength={20}
                  onChange={(e) => setReporterBadgeCode(e.target.value)}
                  placeholder={isArabic ? "أدخل الرمز للتحقق الخادمي" : "Saisir le code à valider par le serveur"}
                  className="w-full bg-black/60 border border-amber-500/30 rounded-lg py-2 px-3 text-xs text-amber-300 focus:outline-none focus:ring-1 focus:ring-amber-500"
                  required
                />
                <p className="text-[9px] text-amber-400/80 italic leading-snug">
                  {isArabic 
                    ? "يُرسل الرمز إلى الخادم للتحقق فقط؛ لا يمنح هذا الحقل اعتمادًا أو صلاحية من الواجهة."
                    : "Le code est seulement vérifié par le serveur ; ce champ n'accorde aucune autorité depuis l'interface."}
                </p>
              </div>
            )}
          </div>

          {/* Optional Reporter Info */}
          <div className="grid grid-cols-2 gap-3 border-t border-white/5 pt-3">
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
                {isArabic ? "الاسم الكامل (اختياري)" : "Nom (optionnel)"}
              </label>
              <input
                type="text"
                  value={reporterName}
                  maxLength={120}
                  onChange={(e) => setReporterName(e.target.value)}
                placeholder={isArabic ? "مثال: محمد بلخير" : "Ex: Mohamed"}
                className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg py-1.5 px-2.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40"
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-widest font-bold text-gray-400 mb-1">
                {isArabic ? "رقم الهاتف (اختياري للطوارئ)" : "N° Téléphone (optionnel)"}
              </label>
              <input
                type="tel"
                  value={reporterPhone}
                  maxLength={30}
                  inputMode="tel"
                  onChange={(e) => setReporterPhone(e.target.value)}
                placeholder="06XXXXXXXX"
                className="w-full bg-black/50 border border-white/5 hover:border-white/10 rounded-lg py-1.5 px-2.5 text-xs text-slate-100 focus:outline-none focus:ring-1 focus:ring-red-500/40"
              />
            </div>
          </div>

          {/* Feedback message and Submit */}
          {errorMsg && (
            <div role="alert" aria-live="assertive" className="p-3 bg-red-950/20 border border-red-500/30 text-red-400 rounded-lg text-xs font-semibold leading-relaxed">
              ⚠️ {errorMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || isCompressing}
            className="w-full py-3 bg-red-600 hover:bg-red-700 disabled:bg-zinc-850 text-white rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-[0_10px_20px_rgba(220,38,38,0.2)]"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {isArabic
                    ? "جاري إرسال البلاغ..."
                    : "Envoi du signalement..."}
                </span>
              </>
            ) : (
              <span>{isArabic ? "🚀 بث بلاغ الحريق الآن" : "🚀 Envoyer le signalement"}</span>
            )}
          </button>
        </form>
      )}
    </div>
  );
}
