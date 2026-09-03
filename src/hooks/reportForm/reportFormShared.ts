import { haversineKm } from "../../utils/geo";

/**
 * ARC-H13 decomposition — shared vocabulary for the ReportForm hook family.
 * The former 1905-line ReportForm god-component fused ~9 concerns; these
 * modules split them while keeping ONE owner per state slice:
 *
 *   reportFormShared      — types + pure contract helpers (this file)
 *   stampCapture          — pure canvas frame capture + telemetry HUD stamp
 *   useReportFields       — THE owner of every form field, the wilaya
 *                           geofence/reconciliation notes and GPS acquisition
 *   useReportCamera       — camera lifecycle, compass sensors, correlation
 *   useReportImage        — attach/compress pipeline + edge-AI pre-scan
 *   useOfflineDraftQueue  — offline drafts queue + connectivity sync
 *   useReportSubmit       — validation, payload, offline intercept, badge,
 *                           success/error feedback (owns isSubmitting)
 *   ReportForm.tsx        — thin orchestrator + the JSX, unchanged DOM
 */

/** Normalized view of one submission outcome (server or offline draft). */
export interface SubmissionResultView {
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

/** Geofence hint rendered under the wilaya select. */
export interface WilayaNote {
  kind: "suggest" | "mismatch" | "outside";
  option?: string;
  textAr: string;
  textFr: string;
}

/** Result of the on-device color heuristic (never a verification). */
export interface EdgeAiStatusView {
  success: boolean;
  confidence: number;
  messageAr: string;
  messageFr: string;
}

export function toUserFacingSubmitError(message: string | undefined, isArabic: boolean): string {
  const normalized = message?.toLowerCase() || "";
  if (normalized.includes("durable idempotency") || normalized.includes("durable_idempotency") || normalized.includes("admin firestore") || normalized.includes("report data is currently unavailable")) {
    return isArabic
      ? "تعذر إرسال البلاغ الآن لأن خادم المرصد غير جاهز. بقيت بياناتك في النموذج؛ حاول مجددًا عند توفر الخدمة."
      : "Le serveur de l'observatoire n'est pas prêt. Vos données restent dans le formulaire ; réessayez lorsque le service sera disponible.";
  }
  if (normalized.includes("coordinates do not fall within") || normalized.includes("outside the monitoring coverage") || normalized.includes("خارج نطاق المراقبة")) {
    return isArabic
      ? "الموقع لا يطابق الولاية المحددة أو يقع خارج نطاق المراقبة. صحّح الموقع أو الولاية ثم أعد المحاولة."
      : "La position ne correspond pas à la wilaya sélectionnée ou se trouve hors de la zone surveillée. Corrigez-la puis réessayez.";
  }
  if (normalized.includes("idempotency_key_reuse") || normalized.includes("already bound to a different report")) {
    return isArabic
      ? "تعذر إعادة استخدام هذا البلاغ بأمان. أنشئ بلاغًا جديدًا بدل إعادة إرسال بيانات مختلفة."
      : "Ce signalement ne peut pas être réutilisé en toute sécurité. Créez un nouveau signalement au lieu de renvoyer des données différentes.";
  }
  if (normalized.includes("idempotency_data_integrity_failure") || normalized.includes("multiple legacy reports")) {
    return isArabic
      ? "تعذر معالجة البلاغ بأمان بسبب تعارض في السجل. لم يُنشأ بلاغ جديد؛ حاول لاحقًا أو تواصل مع فريق التشغيل."
      : "Le signalement ne peut pas être traité en toute sécurité à cause d'un conflit de registre. Aucun nouveau signalement n'a été créé ; réessayez plus tard.";
  }
  if (normalized.includes("validation failed") || normalized.includes("missing required fields")) {
    return isArabic
      ? "بعض بيانات البلاغ غير مكتملة أو غير صالحة. راجع الحقول المعلّمة ثم أعد المحاولة."
      : "Certaines données du signalement sont incomplètes ou invalides. Vérifiez les champs puis réessayez.";
  }
  if (normalized.includes("too many reports")) {
    return isArabic
      ? "تم إرسال محاولات كثيرة خلال فترة قصيرة. انتظر قليلًا ثم أعد المحاولة."
      : "Trop de tentatives ont été envoyées en peu de temps. Attendez un instant puis réessayez.";
  }
  return isArabic ? "تعذر إرسال البلاغ الآن. بقيت بياناتك في النموذج؛ تحقق من الاتصال ثم أعد المحاولة." : "Impossible d'envoyer le signalement pour le moment. Vos données restent dans le formulaire ; vérifiez la connexion puis réessayez.";
}

export function isResolvedWilayaMismatch(selectedWilaya: string, resolvedWilaya: string): boolean {
  return Boolean(selectedWilaya && resolvedWilaya && selectedWilaya !== resolvedWilaya);
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

/**
 * ARC-H13: the catch-block server-message extraction from handleSubmit is now
 * a pure, testable helper. Reads (in the original order): err.data.error
 * then err.response.data.error; anything else is undefined so the caller
 * falls back to the generic user-facing copy.
 */
export function extractServerErrorMessage(err: unknown): string | undefined {
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
  return typeof serverMsgCandidate === "string" ? serverMsgCandidate : undefined;
}

/** Client-side distance calculation (Haversine formula in km). */
export function getDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  return haversineKm(lat1, lng1, lat2, lng2);
}

/** Client-side bearing calculation (compass degrees 0-360). */
export function calculateBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const lat1Rad = (lat1 * Math.PI) / 180;
  const lat2Rad = (lat2 * Math.PI) / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x =
    Math.cos(lat1Rad) * Math.sin(lat2Rad) -
    Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

  let bearing = (Math.atan2(y, x) * 180) / Math.PI;
  return (bearing + 360) % 360;
}

/** Helper to convert a bearing angle to a cardinal direction (localized). */
export function getBearingDirection(angle: number, isArabic: boolean): string {
  const directions = isArabic
    ? ["شمال", "شمال شرقي", "شرق", "جنوب شرقي", "جنوب", "جنوب غربي", "غرب", "شمال غربي"]
    : ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(((angle % 360) / 45)) % 8;
  return directions[index];
}

/**
 * Draft rows read back from the durable store are normalized with explicit
 * defaults (schemaVersion/createdAt/queuedAt/retryCount) so the sync loop and
 * the UI can rely on their presence regardless of which app version queued
 * them. `nowIso` is injectable for tests.
 */
export function normalizeLoadedDraft<T extends Record<string, unknown>>(draft: T, nowIso = new Date().toISOString()): T & {
  schemaVersion: number;
  createdAt: string;
  queuedAt: string;
  retryCount: number;
} {
  return {
    ...draft,
    schemaVersion: (draft.schemaVersion as number | undefined) ?? 1,
    createdAt: (draft.createdAt as string | undefined) ?? (draft.timestamp as string | undefined) ?? nowIso,
    queuedAt: (draft.queuedAt as string | undefined) ?? (draft.timestamp as string | undefined) ?? nowIso,
    retryCount: Number.isFinite(draft.retryCount) ? (draft.retryCount as number) : 0,
  };
}

/** Clamp used by the camera HUD alignment gauge (0-100 or 0 when absent). */
export function safeAlignmentAccuracyValue(value: number | null): number {
  return Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;
}
