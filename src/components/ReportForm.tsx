import { useRef, useState } from "react";
import { Camera, MapPin, Loader2, Upload, AlertTriangle, CheckCircle } from "lucide-react";
import { useReportFields } from "../hooks/reportForm/useReportFields";
import { useReportCamera } from "../hooks/reportForm/useReportCamera";
import { useReportImage } from "../hooks/reportForm/useReportImage";
import { useOfflineDraftQueue } from "../hooks/reportForm/useOfflineDraftQueue";
import { useReportSubmit } from "../hooks/reportForm/useReportSubmit";
import { captureStampedFrame } from "../hooks/reportForm/stampCapture";
import { getBearingDirection } from "../hooks/reportForm/reportFormShared";
import type { SyncState } from "../utils/datasetHealth";

/**
 * ARC-H13 — ReportForm is now a THIN ORCHESTRATOR. The former 1905-line
 * god-component fused ~9 concerns; the logic lives in one-owner-per-slice
 * hooks under src/hooks/reportForm/ while this file keeps the EXACT public
 * surface (props + the three exported contract helpers) and the EXACT DOM:
 *
 *   reportFormShared      — types + pure contract helpers (re-exported below)
 *   stampCapture          — pure canvas capture + telemetry HUD stamp
 *   useReportFields       — fields, wilaya geofence, reverse geo, GPS
 *   useReportCamera       — camera lifecycle, compass, correlation (ARC-H12/M20)
 *   useReportImage        — attach/compress + edge-AI pre-scan
 *   useOfflineDraftQueue  — durable drafts queue + connectivity sync (ARC-L10/L15)
 *   useReportSubmit       — validation, idempotency, offline intercept, badge
 *
 * Shared spinner/feedback: isSubmitting and errorMsg are single states owned
 * HERE (set by the fields/GPS, camera, image and submit paths through their
 * injected setters) — exactly the original single-state topology.
 */

// Public contract surface (pinned by tests/report-form-contract.test.ts) —
// the implementations moved verbatim into reportFormShared.ts.
export { toUserFacingSubmitError, isResolvedWilayaMismatch, normalizeSubmissionResult } from "../hooks/reportForm/reportFormShared";

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

export default function ReportForm({ mapClickedCoords, onSubmit, lang, reports = [], wilayas, syncState = "never" }: ReportFormProps) {
  const isArabic = lang === "ar";
  // Single spinner + single feedback line, shared by GPS/camera/image/submit
  // and the offline sync loop — the original component's exact topology.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fields = useReportFields({ mapClickedCoords, wilayas, isArabic, setErrorMsg });
  const camera = useReportCamera({ lat: fields.lat, lng: fields.lng, reports, isArabic, setErrorMsg });
  const imageState = useReportImage({ isArabic, setErrorMsg });
  const queue = useOfflineDraftQueue({ onSubmit, isArabic, setSubmitting: setIsSubmitting });
  const submit = useReportSubmit({
    onSubmit,
    isArabic,
    fields: { values: fields.values, resetForNextReport: fields.resetForNextReport },
    image: { image: imageState.image, compressedSize: imageState.compressedSize, resetImage: imageState.resetImage },
    camera: { resetOrientation: camera.resetOrientation },
    drafts: {
      isOffline: queue.isOffline,
      isOfflineSimulation: queue.isOfflineSimulation,
      persistDraft: queue.persistDraft,
    },
    setSubmitting: setIsSubmitting,
    setErrorMsg,
  });

  const {
    lat, setLat, lng, setLng, locationName, setLocationName, wilaya, setWilaya,
    severity, setSeverity, description, setDescription,
    reporterName, setReporterName, reporterPhone, setReporterPhone,
    reporterType, setReporterType, reporterBadgeCode, setReporterBadgeCode,
    isLocating, wilayaOptions, wilayaNote, setWilayaNote, handleGetLocation,
  } = fields;
  const {
    isCameraOpen, cameraStatus, stream, videoRef, heading, pitch,
    headingSource, pitchSource, matchedReport, alignmentAccuracy,
    showCalibrationGuide, setShowCalibrationGuide, includeTelemetry, setIncludeTelemetry,
    safeAlignmentAccuracy, safeMatchedDistance, safeMatchedBearing,
    startCamera, stopCamera, setManualHeading, setManualPitch,
  } = camera;
  const {
    image, originalSize, compressedSize, isCompressing, uploadWarning, edgeAiStatus,
    handleImageChange, applyCapturedImage, runEdgeAiPreScan,
  } = imageState;
  const {
    isOffline, isOfflineSimulation, allowOfflineSimulation, offlineDrafts,
    syncStatusMsg, toggleOfflineSimulation, syncOfflineDrafts,
  } = queue;
  const { successReport, dismissSuccess, handleSubmit } = submit;

  // High-fidelity image capture with embedded watermarked telemetry — the
  // canvas work itself is the pure stampCapture module; this composition
  // wires the hook states in and applies the result (ported verbatim).
  const captureSnapshot = () => {
    const stamp = captureStampedFrame({
      stream,
      video: videoRef.current,
      lat,
      lng,
      heading,
      pitch,
      headingSource,
      pitchSource,
      includeTelemetry,
      matchedReport,
      alignmentAccuracy,
      isArabic,
      bearingDirection: (angle: number) => getBearingDirection(angle, isArabic),
    });
    if (!stamp.ok) {
      setErrorMsg(isArabic ? stamp.errorAr : stamp.errorFr);
      stopCamera();
      return;
    }
    applyCapturedImage(stamp.dataUrl);
    // Note: telemetry overlay avoids raw image degradation while keeping a
    // high-fidelity snapshot for the Gemini vision verification.
    runEdgeAiPreScan(stamp.dataUrl);
    stopCamera();
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
              onClick={toggleOfflineSimulation}
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
            onClick={dismissSuccess}
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
              className="w-full py-2 bg-red-600/10 hover:bg-red-600/20 border border-red-500/20 hover:border-red-500/40 text-red-400 rounded-lg text-xs font-semibold transition-colors flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
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
                    ? (isArabic ? `زاوية اتجاه البوصلة: ${heading}° ${getBearingDirection(heading, isArabic)}` : `COMPASS BEARING: ${heading}° ${getBearingDirection(heading, isArabic)}`)
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
                  onChange={(e) => setManualHeading(parseInt(e.target.value, 10))}
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
                  onChange={(e) => setManualPitch(parseInt(e.target.value, 10))}
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
            className="w-full py-3 bg-red-600 hover:bg-red-700 disabled:bg-zinc-800 text-white rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-1.5 cursor-pointer shadow-[0_10px_20px_rgba(220,38,38,0.2)]"
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
