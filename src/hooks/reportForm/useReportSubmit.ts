import { useRef, useState } from "react";
import { isValidOptionalPhone } from "../../utils/phone";
import { setReporterBadge } from "../../utils/badgeStore";
import {
  extractServerErrorMessage,
  normalizeSubmissionResult,
  toUserFacingSubmitError,
} from "./reportFormShared";
import type { SubmissionResultView } from "./reportFormShared";

/**
 * ARC-H13 — THE owner of the submission concern: validation, the idempotent
 * payload, the offline intercept (durable draft instead of a doomed send),
 * the online path through the parent's transport, the server-issued badge
 * activation gate, and the success/error feedback contract.
 *
 * Trust rules kept verbatim from the original:
 *  - only a SERVER-issued verified result may activate the local operator
 *    tone gate (setReporterBadge) — a user-supplied code, pending response,
 *    or malformed response is never client-side authority;
 *  - offline drafts never grant trust: the badge must be validated by the
 *    server after synchronization;
 *  - no AI verification is fabricated on-device — Gemini runs on the server
 *    once the draft is pushed, and only then.
 */
export interface UseReportSubmitParams {
  onSubmit: (data: any) => Promise<any>;
  isArabic: boolean;
  fields: {
    values: {
      lat: string;
      lng: string;
      locationName: string;
      wilaya: string;
      severity: string;
      description: string;
      reporterName: string;
      reporterPhone: string;
      reporterType: string;
      reporterBadgeCode: string;
    };
    resetForNextReport: () => void;
  };
  image: {
    image: string | null;
    compressedSize: string | null;
    resetImage: () => void;
  };
  camera: {
    resetOrientation: () => void;
  };
  drafts: {
    isOffline: boolean;
    isOfflineSimulation: boolean;
    persistDraft: (draftReport: any) => Promise<boolean>;
  };
  /** Driven by the offline sync loop through the same shared spinner. */
  setSubmitting: (busy: boolean) => void;
  /** Single feedback line owned by the orchestrator, shared with the
   *  GPS/camera/image paths — the original component's exact topology. */
  setErrorMsg: (message: string | null) => void;
}

export function useReportSubmit({ onSubmit, isArabic, fields, image, camera, drafts, setSubmitting, setErrorMsg }: UseReportSubmitParams) {
  // isSubmitting itself is OWNED by the orchestrator (ReportForm) and shared
  // with the offline sync loop — both paths drive the same spinner, exactly
  // like the original single state. This hook only guards re-entry via its
  // own ref, identical to the original handleSubmit guard. errorMsg is
  // likewise owned by the orchestrator and injected here as a setter.
  const [successReport, setSuccessReport] = useState<SubmissionResultView | any | null>(null);
  const submittingRef = useRef(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const { lat, lng, wilaya, severity, description, reporterName, reporterPhone, reporterType, reporterBadgeCode, locationName } = fields.values;
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
    // ARC-L17: shared optional-phone policy (src/utils/phone.ts) — regex moved
    // there verbatim; empty stays valid (the field is optional).
    if (!isValidOptionalPhone(normalizedPhone)) {
      setErrorMsg(isArabic ? "يرجى إدخال رقم هاتف صالح أو ترك الحقل فارغًا." : "Veuillez saisir un numéro de téléphone valide ou laisser le champ vide.");
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
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
      image: image.image,
      clientGeneratedId,
    };

    // --- INTERCEPT FOR OFFLINE DRAFT MODE ---
    const offlineMode = drafts.isOffline || drafts.isOfflineSimulation;
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

      // ARC-L10: append chronologically — the sync loop consumes the array in
      // order, so the OLDEST queued draft must sit first. Prepending made the
      // newest draft jump the queue (LIFO) while the sync path claimed to
      // preserve ordering.
      const persisted = await drafts.persistDraft(draftReport);
      if (!persisted) {
        setErrorMsg(isArabic ? "تعذر حفظ البلاغ محليًا. تحقق من مساحة التخزين أو أذونات المتصفح." : "Impossible d'enregistrer le brouillon localement. Vérifiez l'espace de stockage du navigateur.");
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }

      setSuccessReport({
        ...draftReport,
        // No AI verification is fabricated on-device: Gemini runs on the
        // server once the draft is pushed — and only then.
        aiVerification: null,
        aiComments: isArabic
          ? `تم حفظ البلاغ كمسودة في ذاكرة الجهاز (${image.compressedSize || "0 KB"}). ستتم محاولة مزامنته عند عودة الاتصال — التحقق بالذكاء الاصطناعي يتم بعد وصوله للخادم.`
          : `Signalement enregistré localement (${image.compressedSize || "0 KB"}). Une synchronisation sera tentée au retour du réseau ; la vérification IA se fait côté serveur.`,
      });

      // Offline drafts never grant trust: the badge must be validated by the
      // server after synchronization before any client trust gate changes.
      // Clear fields on success
      fields.resetForNextReport();
      image.resetImage();
      camera.resetOrientation();
      submittingRef.current = false;
      setSubmitting(false);
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
      fields.resetForNextReport();
      image.resetImage();
      camera.resetOrientation();
    } catch (err: unknown) {
      setErrorMsg(toUserFacingSubmitError(extractServerErrorMessage(err), isArabic));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return {
    successReport,
    dismissSuccess: () => setSuccessReport(null),
    handleSubmit,
  };
}
